import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireUpdaterLock, readRepoInfoForTest } from "../app/updater.js";
import { gitExecutable, selectGitExecutable } from "../scripts/git-executable.mjs";
import { macSigningTimestamp } from "../scripts/mac-signing-identity.mjs";
import { atomicInstallBuiltApp, snapshotUpdateState } from "../scripts/update-packaged-app.mjs";
import type { AtomicInstallOperations } from "../scripts/update-packaged-app.mjs";

const sourceRoot = existsSync(join(process.cwd(), "app", "updater.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const mainSource = await readFile(join(sourceRoot, "app", "main.ts"), "utf8");
const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const updateScriptSource = await readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8");
const localLauncherSource = await readFile(join(sourceRoot, "scripts", "launch-local-app.mts"), "utf8");
const embeddedSupervisorSource = await readFile(join(sourceRoot, "src", "embeddedSupervisor.ts"), "utf8");
const packageMacSource = await readFile(join(sourceRoot, "scripts", "package-mac.mjs"), "utf8");
const writeBuildInfoSource = await readFile(join(sourceRoot, "scripts", "write-build-info.mts"), "utf8");
const buildHumanIdleSource = await readFile(join(sourceRoot, "scripts", "build-human-idle-helper.mjs"), "utf8");
const execFile = promisify(execFileCallback);

assert.equal(macSigningTimestamp("Vigil Local Code Signing"), "none", "local self-signing must not depend on Apple's timestamp service");
assert.equal(macSigningTimestamp("Apple Development: Example"), "none", "local Apple Development signing must not wait on network timestamping");
assert.equal(macSigningTimestamp("Developer ID Application: Example"), undefined, "distributable identities must retain normal timestamping");
assert.match(packageMacSource, /-c\.mac\.timestamp=\$\{timestamp\}/u, "local app builds must pass the safe timestamp policy to electron-builder");
assert.match(updateScriptSource, /-c\.mac\.timestamp=\$\{signingTimestamp\}/u, "isolated updater builds must use the same timestamp policy");

const preflightIndex = updaterSource.indexOf("await assertLocallyRebuildableApp(appPath)");
const remoteQuitHandlerIndex = updaterSource.indexOf('process.once("SIGUSR2", requestQuit)');
assert.ok(preflightIndex >= 0 && remoteQuitHandlerIndex > preflightIndex, "signature preflight must finish before the updater can ask the app to quit");
assert.match(updaterSource, /let startInFlight: Promise<unknown> \| null = null/u);
assert.match(
  updaterSource,
  /plistStringForKey\(plist, "VigilSourceRoot"\) \|\| plistStringForKey\(plist, "WorkingDirectory"\)/u,
  "updater discovery must retain a repository pointer when the agent runs from its installed runtime"
);
assert.match(updateScriptSource, /\["worktree", "add", "--detach"/u);
assert.match(updaterSource, /packagedBuildRepoRoot\(app\)/u, "the installed app must retain its source checkout pointer");
assert.match(updaterSource, /existsSync\(join\(candidate, "\.git"\)\)/u, "source discovery must reject installed runtime copies that are not Git worktrees");
assert.match(updaterSource, /const REPO_CHECK_ATTEMPTS = 3/u, "transient repository reads must be retried");
assert.match(updaterSource, /await gitExecutable\(repoRoot\)/u, "repository verification must resolve a working Git binary");
assert.match(updaterSource, /const canonicalPath = await realpath\(path\)/u, "the updater must launch the canonical Node executable rather than a user-path symlink rejected by the root guardian");
assert.match(updateScriptSource, /command === "git" \? await gitExecutable\(cwd\) : command/u, "the external updater must use the same verified Git binary");
assert.match(
  buildHumanIdleSource,
  /resolveDeveloperTools\(\)[\s\S]*?CommandLineTools\/usr\/bin[\s\S]*?XcodeDefault\.xctoolchain[\s\S]*?\/usr\/bin/u,
  "local rebuilds must bypass unusable Apple compiler shims after an Xcode update"
);
assert.match(updateScriptSource, /VIGIL_BUILD_SOURCE_ROOT: options\.repoRoot/u, "staged update builds must preserve the real checkout pointer");
assert.ok(
  updateScriptSource.indexOf("await guardianMaintenanceReadiness()")
    < updateScriptSource.indexOf("stagedBuild = await buildInIsolatedWorktree()"),
  "guardian compatibility must fail before dependency installation, compilation, and signing"
);
assert.doesNotMatch(updateScriptSource, /run\("git", \["fetch", "--prune"\]/u, "the external updater must reuse the commit already fetched and selected by the app");
assert.match(updaterSource, /"--expected-commit", String\(currentStatus\.upstreamCommit \|\| ""\)/u, "the app must pin the remotely verified commit for the external updater");
assert.match(
  writeBuildInfoSource,
  /rev-parse", "--path-format=absolute", "--git-common-dir/u,
  "manual builds from temporary worktrees must retain the durable primary checkout pointer"
);
assert.ok(
  updateScriptSource.indexOf("const defaultInstallOperations") < updateScriptSource.lastIndexOf("if (isDirectRun(import.meta.url)) await runUpdate()"),
  "the direct updater must start only after its default atomic install operations are initialized"
);
assert.match(updaterSource, /localCheckoutBuild \|\| remoteCheckOk !== false/u, "new local changes must remain runnable without a remote fetch");
assert.match(updaterSource, /currentSourceFingerprint !== appBuild\.sourceFingerprint/u, "local changes must be compared with the source built into the installed app");
assert.match(mainSource, /return status\.updateAvailable === true/u, "the tray must honor the updater controller's installability decision");
assert.match(mainSource, /maintenanceReady: status\?\.maintenanceReady !== false/u, "the tray must retain updater maintenance readiness");
assert.match(mainSource, /return "Update Setup Required"/u, "the tray must not relabel an incompatible updater as installable");
assert.match(mainSource, /appUpdateActionState\.maintenanceReady/u, "the tray must disable an update action that cannot pass protected maintenance");
assert.match(mainSource, /scheduleAppUpdateRefresh\(appUrl\)/u, "the tray must refresh a local build that leaves Vigil running");
assert.match(
  mainSource,
  /async function refreshTrayStatus[\s\S]*?appUpdateActionState\.checked[\s\S]*?refreshRunningAppUpdate\(appUrl\)/u,
  "the tray poll must clear cached updater failures after a transient branch or Git transition"
);
assert.match(updaterSource, /launchLocalChanges\(currentStatus, updateLock\)/u, "dirty source must use the local app launcher");
assert.match(updaterSource, /"--app-path", appPath/u, "the local launcher must receive the installed app path for recovery");
assert.match(
  updaterSource,
  /"--lock-path", updateLock\.path,[\s\S]*?"--lock-token", updateLock\.token/u,
  "the local launcher must receive the transferred authenticated updater lock"
);
assert.match(localLauncherSource, /exitCode = await buildLocalApp\(options, log\)/u, "the local launcher must remain alive through the packaged local build");
assert.match(localLauncherSource, /\["run", "build:mac"\]/u, "local changes must rebuild the Vigil app bundle instead of launching a second Electron app identity");
assert.ok(
  localLauncherSource.indexOf("exitCode = await buildLocalApp(options, log)") < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local changes must finish building before the running app is asked to quit"
);
assert.ok(
  updateScriptSource.indexOf("stagedBuild = await buildInIsolatedWorktree()")
    < updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "remote updates must finish staging before the running app is asked to quit"
);
assert.ok(
  updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")')
    < updateScriptSource.indexOf('await status("installing-runtime"'),
  "remote updates must wait for graceful shutdown before replacing the runtime or app"
);
assert.match(
  updateScriptSource,
  /catch \(error\) \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\);\s*throw error;\s*\}/u,
  "a timed-out remote update shutdown must restore restart supervision"
);
assert.match(localLauncherSource, /atomicInstallBuiltApp\(builtAppPath, options\.appPath, ""\)/u, "local changes must replace Vigil at the same installed app path");
const localInstallFailureStart = localLauncherSource.indexOf("} catch (error) {", localLauncherSource.indexOf("installation = await atomicInstallBuiltApp"));
const localInstallFailureEnd = localLauncherSource.indexOf("\n    try {\n      log.write", localInstallFailureStart + 1);
const localInstallFailureSource = localLauncherSource.slice(localInstallFailureStart, localInstallFailureEnd);
assert.ok(
  localInstallFailureSource.indexOf("await resumeEmbeddedRuntimeSupervisor(options.userDataDir)")
    < localInstallFailureSource.indexOf("await reopenInstalledApp(options.appPath, log)"),
  "a failed local install must restore persistent supervision before trying to reopen the previous app"
);
assert.match(
  localInstallFailureSource,
  /catch \(supervisorError\) \{[\s\S]*?await restoreLegacyLaunchAgent\(legacyAgent\)/u,
  "a failed supervisor-marker restore must fall back to the captured legacy background service"
);
assert.match(
  localInstallFailureSource,
  /try \{\s*await reopenInstalledApp\(options\.appPath, log\);\s*\} catch \(reopenError\)/u,
  "a failed reopen after an install error must leave the persistent recovery path in control"
);
assert.match(localLauncherSource, /await verifyReplacement\(options\.appPath\);[\s\S]*?await installation\.finalize\(\)/u, "the previous installed app must remain recoverable until the replacement stays healthy");
assert.match(localLauncherSource, /await terminateInstalledApp\(options\.appPath\);[\s\S]*?await installation\.rollback\(\)/u, "a failed replacement must stop before restoring and reopening the previous app");
assert.ok(
  localLauncherSource.indexOf("legacyAgent = await captureLegacyLaunchAgentRecovery()")
    < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local replacement must capture the legacy LaunchAgent before the candidate app can retire it"
);
assert.ok(
  localLauncherSource.indexOf("guardianMaintenance = await beginGuardianMaintenance(options.lockPath, options.lockToken)")
    < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local replacement must publish its authenticated guardian marker before Vigil or its supervisor can exit"
);
assert.ok(
  updateScriptSource.indexOf("guardianMaintenance = await beginGuardianMaintenance(options.lockPath, options.lockToken)")
    < updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "packaged replacement must publish its authenticated guardian marker before Vigil or its supervisor can exit"
);
assert.match(
  localLauncherSource,
  /finally \{[\s\S]*?guardianMaintenance\.release\(\)[\s\S]*?releaseOwnedUpdaterLock\(options\.lockPath, options\.lockToken\)/u,
  "local verification and rollback must retain guardian maintenance until the complete transaction settles"
);
assert.match(
  updateScriptSource,
  /finally \{[\s\S]*?guardianMaintenance\.release\(\)[\s\S]*?releaseOwnedUpdaterLock\(\)/u,
  "packaged verification and rollback must retain guardian maintenance until the complete transaction settles"
);
assert.match(
  localLauncherSource,
  /interface LegacyAgentRecovery \{[\s\S]*?plist: string;[\s\S]*?plistMode: number;[\s\S]*?plistPath: string;/u,
  "local rollback must preserve the legacy LaunchAgent plist and permissions"
);
assert.match(
  localLauncherSource,
  /async function restoreLegacyLaunchAgent[\s\S]*?writeFile\(recovery\.plistPath, recovery\.plist, \{ mode: recovery\.plistMode \}\)[\s\S]*?\["enable", `gui\/\$\{recovery\.uid\}\/com\.vigil\.agent`\][\s\S]*?\["bootstrap", `gui\/\$\{recovery\.uid\}`, recovery\.plistPath\][\s\S]*?\["kickstart", "-k", `gui\/\$\{recovery\.uid\}\/com\.vigil\.agent`\][\s\S]*?waitForLegacyLaunchAgent/u,
  "local rollback must recreate, enable, bootstrap, kickstart, and verify the legacy LaunchAgent"
);
const localRollbackIndex = localLauncherSource.indexOf("await installation.rollback()");
assert.ok(
  localRollbackIndex >= 0
    && localLauncherSource.indexOf("await restoreLegacyLaunchAgent(legacyAgent)", localRollbackIndex) > localRollbackIndex,
  "local rollback must restore the old bundle before restarting its legacy background service"
);
const localRollbackSource = localLauncherSource.slice(localRollbackIndex, localLauncherSource.indexOf("} catch (recoveryError)", localRollbackIndex));
assert.match(
  localRollbackSource,
  /if \(legacyAgent\) \{\s*await restoreLegacyLaunchAgent\(legacyAgent\);\s*\} else \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\);\s*\}\s*await reopenInstalledApp\(options\.appPath, log\)/u,
  "local rollback must resume embedded supervision before reopening when no legacy service can be restored"
);
assert.ok(
  localLauncherSource.indexOf("await suspendEmbeddedRuntimeSupervisor(options.userDataDir)")
    < localLauncherSource.indexOf("await terminateInstalledApp(options.appPath)"),
  "local rollback must suspend the embedded restart supervisor before terminating the rebuilt app"
);
assert.match(localLauncherSource, /await reopenInstalledApp\(options\.appPath, log\)/u, "a failed local launch must reopen the installed app");
assert.match(
  localLauncherSource,
  /spawn\("\/usr\/bin\/open", \["-g", appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG\]/u,
  "local rebuilds and rollback recovery must relaunch Vigil without activating it or opening a window"
);
assert.ok(
  localLauncherSource.indexOf("createWriteStream(options.logPath") < localLauncherSource.indexOf("await waitForExit(options.parentPid"),
  "the local launcher must create its log before waiting for the installed app to quit"
);
assert.match(localLauncherSource, /await waitForLogOpen\(log\)/u, "the local launcher must wait for its log descriptor before passing it to child processes");
assert.match(localLauncherSource, /The built app was not installed/u, "a stalled installed-app shutdown must leave the installed app untouched");

const noUpstreamRoot = await mkdtemp(join(tmpdir(), "vigil-updater-no-upstream-"));
try {
  await mkdir(join(noUpstreamRoot, "app"), { recursive: true });
  await writeFile(join(noUpstreamRoot, "package.json"), '{"name":"vigil"}\n');
  await writeFile(join(noUpstreamRoot, "app", "main.ts"), "export {};\n");
  const git = await gitExecutable(noUpstreamRoot);
  await execFile(git, ["init", "--quiet", noUpstreamRoot]);
  await execFile(git, ["-C", noUpstreamRoot, "config", "user.email", "vigil-test@example.invalid"]);
  await execFile(git, ["-C", noUpstreamRoot, "config", "user.name", "Vigil Test"]);
  await execFile(git, ["-C", noUpstreamRoot, "add", "package.json", "app/main.ts"]);
  await execFile(git, ["-C", noUpstreamRoot, "commit", "--quiet", "-m", "fixture"]);
  const repoWithoutUpstream = await readRepoInfoForTest(noUpstreamRoot);
  assert.equal(repoWithoutUpstream.ok, true, "a valid local Git checkout must remain verifiable without an upstream branch");
  assert.equal(repoWithoutUpstream.upstream, null, "missing branch tracking must remain distinct from repository verification");
} finally {
  await rm(noUpstreamRoot, { recursive: true, force: true });
}

const gitFallbackRoot = await mkdtemp(join(tmpdir(), "vigil-git-fallback-"));
try {
  const brokenGit = join(gitFallbackRoot, "broken-git");
  const workingGit = join(gitFallbackRoot, "working-git");
  await writeFile(brokenGit, "#!/bin/sh\nexit 69\n");
  await writeFile(workingGit, "#!/bin/sh\n[ \"$1\" = \"--version\" ]\n");
  await Promise.all([chmod(brokenGit, 0o755), chmod(workingGit, 0o755)]);
  assert.equal(
    await selectGitExecutable([brokenGit, workingGit], gitFallbackRoot),
    workingGit,
    "an unusable Apple Git shim must fall through to a working direct toolchain binary"
  );
} finally {
  await rm(gitFallbackRoot, { recursive: true, force: true });
}
assert.match(
  localLauncherSource,
  /catch \(error\) \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\);\s*log\.write/u,
  "a timed-out local update shutdown must restore restart supervision"
);
assert.match(localLauncherSource, /"Library", "Logs", "Vigil", "local-launch\.log"/u, "local launch output must remain available in a durable log");
assert.match(updateScriptSource, /await openAndVerifyReplacement\(/u);
const updaterSupervisorStopIndex = updateScriptSource.indexOf("await suspendEmbeddedRuntimeSupervisor(options.userDataDir)");
const updaterAppStopIndex = updateScriptSource.indexOf("await terminateInstalledApp()", updaterSupervisorStopIndex);
const updaterAppRollbackIndex = updateScriptSource.indexOf("appInstallation.rollback()", updaterAppStopIndex);
assert.ok(
  updaterSupervisorStopIndex >= 0 && updaterAppStopIndex > updaterSupervisorStopIndex && updaterAppRollbackIndex > updaterAppStopIndex,
  "failed packaged updates must suspend the embedded restart supervisor before terminating and restoring the app"
);
assert.match(updaterSource, /"--user-data-dir", userDataDir/u, "both replacement launchers must receive Electron's exact supervisor marker directory");
assert.match(updateScriptSource, /BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG/u, "remote replacement launches must expose Vigil's do-not-terminate safety boundary");
assert.match(localLauncherSource, /BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG/u, "local replacement launches must expose Vigil's do-not-terminate safety boundary");
assert.match(localLauncherSource, /userInfo\(\)[\s\S]*?HOME: account\.homedir[\s\S]*?PATH: `\$\{join\(account\.homedir, "\.local", "bin"\)\}/u, "local replacement launches must restore the signed-in user's home and tool path even after an admin guardian launch");
assert.ok(
  embeddedSupervisorSource.indexOf('rm(join(userDataDir, "supervisor", EMBEDDED_SUPERVISOR_MARKER)')
    < embeddedSupervisorSource.indexOf('["bootout", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`]'),
  "supervisor suspension must remove the reopen marker before booting out the launchd job"
);
assert.match(
  embeddedSupervisorSource,
  /\["print", `gui\/\$\{uid\}\/\$\{EMBEDDED_SUPERVISOR_LABEL\}`\][\s\S]*?restart supervisor remained loaded/u,
  "supervisor suspension must verify launchd no longer owns the restart job"
);
assert.match(
  embeddedSupervisorSource,
  /async function resumeEmbeddedRuntimeSupervisor[\s\S]*?\["enable", `gui\/\$\{uid\}\/\$\{EMBEDDED_SUPERVISOR_LABEL\}`\][\s\S]*?\["bootstrap", `gui\/\$\{uid\}`, plistPath\][\s\S]*?\["kickstart", "-k", `gui\/\$\{uid\}\/\$\{EMBEDDED_SUPERVISOR_LABEL\}`\][\s\S]*?waitForLaunchctlServiceRunning\(uid\)/u,
  "restoring supervision must bootstrap and verify launchd instead of only recreating its marker"
);
const failedUpdateRecoveryStart = updateScriptSource.indexOf("async function recoverFailedUpdate");
const failedUpdateRecoveryEnd = updateScriptSource.indexOf("\nasync function collectRecoveryError", failedUpdateRecoveryStart);
const failedUpdateRecoverySource = updateScriptSource.slice(failedUpdateRecoveryStart, failedUpdateRecoveryEnd);
assert.match(
  failedUpdateRecoverySource,
  /if \(launchAgentWasLoaded\) \{\s*await openAppInBackground\(\);\s*\} else \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\)[\s\S]*?await openAndVerifyRecoveredApp\(dataDir\)/u,
  "failed-update recovery must preserve legacy supervision or restore embedded supervision before reopening"
);
assert.match(updateScriptSource, /launchAgentRuntimePath\(\)/u);
assert.ok(
  updateScriptSource.indexOf("agentRuntimeInstallation = await atomicInstallBuiltApp(")
    < updateScriptSource.indexOf("await startLaunchAgentAfterStateTransition(launchAgentTransition)"),
  "the updater must replace the installed LaunchAgent runtime before restarting it"
);
assert.match(
  updateScriptSource,
  /run\("\/usr\/bin\/open", \["-g", options\.appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG\]\)/u,
  "updater verification must relaunch Vigil without activating it or opening a window"
);
assert.ok(
  updateScriptSource.indexOf("await openAndVerifyReplacement(")
    < updateScriptSource.indexOf("await run(\"git\", [\"merge\", \"--ff-only\", stagedBuild.expectedCommit]"),
  "the replacement must be healthy before the source checkout is fast-forwarded"
);
assert.ok(
  updateScriptSource.indexOf("launchAgentTransition = await stopLaunchAgentForStateTransition(launchAgentTransition)")
    < updateScriptSource.indexOf("stateSnapshot = await snapshotUpdateState(")
    && updateScriptSource.indexOf("stateSnapshot = await snapshotUpdateState(")
      < updateScriptSource.indexOf("await startLaunchAgentAfterStateTransition(launchAgentTransition)"),
  "the updater must stop the old backend, preserve pre-migration state, and only then start the replacement backend"
);
const recoveryStopIndex = updateScriptSource.indexOf("stoppedLaunchAgent = await stopLaunchAgentForStateTransition(launchAgentTransition)");
const stateRollbackIndex = updateScriptSource.indexOf("await stateSnapshot.rollback()", recoveryStopIndex);
const recoveryStartIndex = updateScriptSource.indexOf("startLaunchAgentAfterStateTransition(stoppedLaunchAgent)", stateRollbackIndex);
assert.ok(
  recoveryStopIndex >= 0 && stateRollbackIndex > recoveryStopIndex && recoveryStartIndex > stateRollbackIndex,
  "failed updates must stop the replacement backend, restore data, and only then restart the previous backend"
);
assert.match(
  updateScriptSource,
  /interface LaunchAgentRecovery \{[\s\S]*?plist: string;[\s\S]*?plistMode: number;[\s\S]*?plistPath: string;/u,
  "the updater must retain the original LaunchAgent plist and permissions for rollback"
);
assert.ok(
  updateScriptSource.indexOf("launchAgentTransition = await captureLoadedLaunchAgentRecovery()")
    < updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")')
    && updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")')
      < updateScriptSource.indexOf("launchAgentTransition = await stopLaunchAgentForStateTransition(launchAgentTransition)")
    && updateScriptSource.indexOf("launchAgentTransition = await stopLaunchAgentForStateTransition(launchAgentTransition)")
      < updateScriptSource.indexOf("await openAndVerifyReplacement(replacementDataDirectory)"),
  "LaunchAgent rollback metadata must be captured before the running app can retire the legacy service"
);
assert.match(
  updateScriptSource,
  /async function captureLoadedLaunchAgentRecovery[\s\S]*?\["print", `gui\/\$\{uid\}\/com\.vigil\.agent`\][\s\S]*?if \(!loaded\.ok\) return null;[\s\S]*?captureLaunchAgentRecovery\(\)/u,
  "a preserved plist must count as legacy supervision only when launchd still has the service loaded"
);
assert.doesNotMatch(
  updateScriptSource,
  /async function restartLaunchAgent/u,
  "early updater rollback must use the captured plist to bootstrap an unloaded legacy service instead of only kickstarting its label"
);
assert.ok(
  updateScriptSource.indexOf('await run("git", ["merge", "--ff-only", stagedBuild.expectedCommit]')
    < updateScriptSource.indexOf("await finalizeLegacyLaunchAgentRetirement(launchAgentTransition)"),
  "the updater must preserve the legacy plist until replacement verification and source acceptance both succeed"
);
assert.match(
  updateScriptSource,
  /async function finalizeLegacyLaunchAgentRetirement[\s\S]*?await rm\(recovery\.plistPath, \{ force: true \}\)/u,
  "only the successful external updater may retire the legacy rollback plist"
);
assert.match(
  updateScriptSource,
  /async function startLaunchAgentAfterStateTransition[\s\S]*?writeFile\(recovery\.plistPath, recovery\.plist, \{ mode: recovery\.plistMode \}\)[\s\S]*?\["bootstrap", `gui\/\$\{recovery\.uid\}`, recovery\.plistPath\]/u,
  "rollback must recreate the preserved LaunchAgent plist before bootstrapping the old service"
);
assert.match(
  updateScriptSource,
  /async function startLaunchAgentAfterStateTransition[\s\S]*?\["enable", `gui\/\$\{recovery\.uid\}\/com\.vigil\.agent`\][\s\S]*?\["bootstrap", `gui\/\$\{recovery\.uid\}`, recovery\.plistPath\]/u,
  "updater recovery must enable a previously disabled legacy LaunchAgent before bootstrapping it"
);

const lockRoot = await mkdtemp(join(tmpdir(), "vigil-updater-lock-"));
try {
  const lockPath = join(lockRoot, "update.lock");
  const attempts = await Promise.allSettled([
    acquireUpdaterLock(lockPath),
    acquireUpdaterLock(lockPath)
  ]);
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  const losers = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(winners.length, 1, "an atomic updater lock must have exactly one winner");
  assert.equal(losers.length, 1, "a concurrent updater must be rejected");
  const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireUpdaterLock>>>).value;
  await winner.release();
  assert.equal(existsSync(lockPath), false);

  const abandoned = await acquireUpdaterLock(lockPath);
  await abandoned.transferTo(2_147_483_647);
  const replacement = await acquireUpdaterLock(lockPath);
  await abandoned.release();
  assert.equal(existsSync(lockPath), true, "an old owner must not delete a replacement lock");
  await replacement.release();
  assert.equal(existsSync(lockPath), false);
} finally {
  await rm(lockRoot, { recursive: true, force: true });
}

await verifyOriginalSurvivesMoveFailure("backup", (source, installedApp) => source === installedApp);
await verifyOriginalSurvivesMoveFailure("replacement", (source) => source.endsWith(".vigil-next"));
await verifyUpdateStateRollback(false);
await verifyUpdateStateRollback(true);
await verifyUpdateStateFinalize();

const symlinkRoot = await mkdtemp(join(tmpdir(), "vigil-updater-symlinks-"));
try {
  const builtApp = join(symlinkRoot, "built", "Vigil.app");
  const installedApp = join(symlinkRoot, "installed", "Vigil.app");
  await mkdir(join(builtApp, "Versions", "A", "Resources"), { recursive: true });
  await writeFile(join(builtApp, "Versions", "A", "Resources", "icudtl.dat"), "icu");
  await symlink("A", join(builtApp, "Versions", "Current"));
  await symlink("Versions/Current/Resources", join(builtApp, "Resources"));
  const installation = await atomicInstallBuiltApp(builtApp, installedApp, "");
  assert.equal(await readlink(join(installedApp, "Resources")), "Versions/Current/Resources");
  assert.equal(await readFile(join(installedApp, "Resources", "icudtl.dat"), "utf8"), "icu");
  await installation.finalize();
} finally {
  await rm(symlinkRoot, { recursive: true, force: true });
}

async function verifyOriginalSurvivesMoveFailure(
  label: string,
  shouldFailMove: (source: string, installedApp: string) => boolean
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `vigil-updater-${label}-failure-`));
  try {
    const builtApp = join(root, "built", "Vigil.app");
    const installedApp = join(root, "installed", "Vigil.app");
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new");
    await writeFile(join(installedApp, "version.txt"), "old");

    const operations = failingMoveOperations((source) => shouldFailMove(source, installedApp));
    await assert.rejects(
      atomicInstallBuiltApp(builtApp, installedApp, "", operations),
      new RegExp(`${label} move failed`, "u")
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "old");
    assert.equal(existsSync(`${installedApp}.vigil-previous`), false);
    assert.equal(existsSync(`${installedApp}.vigil-next`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  function failingMoveOperations(shouldFail: (source: string) => boolean): AtomicInstallOperations {
    return {
      async pathExists(path) {
        try {
          await lstat(path);
          return true;
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }
      },
      async copy(source, destination) {
        await cp(source, destination, { recursive: true, preserveTimestamps: true });
      },
      async move(source, destination) {
        if (shouldFail(source)) throw new Error(`${label} move failed`);
        await rename(source, destination);
      },
      async remove(path) {
        await rm(path, { recursive: true, force: true });
      }
    };
  }
}

async function verifyUpdateStateRollback(preexistingJournalKey: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-update-state-rollback-"));
  const dataDir = join(root, "data");
  const snapshotParent = join(root, "snapshots");
  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(snapshotParent, { recursive: true });
    await writeFile(join(dataDir, "state.json"), "plaintext state before update");
    await writeFile(join(dataDir, "state.seal.json"), "seal before update");
    if (preexistingJournalKey) {
      await writeFile(join(dataDir, "state-seal.key"), "original seal key");
      await writeFile(join(dataDir, "journal-encryption.key"), "original journal key");
    }

    const snapshot = await snapshotUpdateState(dataDir, snapshotParent);
    await writeFile(join(dataDir, "state.json"), "encrypted state from replacement");
    await writeFile(join(dataDir, "state.seal.json"), "replacement seal");
    await writeFile(join(dataDir, "state-seal.key"), "replacement seal key");
    await writeFile(join(dataDir, "journal-encryption.key"), "replacement journal key");
    await snapshot.rollback();

    assert.equal(await readFile(join(dataDir, "state.json"), "utf8"), "plaintext state before update");
    assert.equal(await readFile(join(dataDir, "state.seal.json"), "utf8"), "seal before update");
    if (preexistingJournalKey) {
      assert.equal(await readFile(join(dataDir, "state-seal.key"), "utf8"), "original seal key");
      assert.equal(await readFile(join(dataDir, "journal-encryption.key"), "utf8"), "original journal key");
    } else {
      assert.equal(existsSync(join(dataDir, "state-seal.key")), false, "rollback must remove a seal key created only by the failed update");
      assert.equal(existsSync(join(dataDir, "journal-encryption.key")), false, "rollback must remove a key created only by the failed update");
    }
    assert.deepEqual(await readdir(snapshotParent), [], "rollback must remove its temporary data snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyUpdateStateFinalize(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-update-state-finalize-"));
  const dataDir = join(root, "data");
  const snapshotParent = join(root, "snapshots");
  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(snapshotParent, { recursive: true });
    await writeFile(join(dataDir, "state.json"), "state before update");
    const snapshot = await snapshotUpdateState(dataDir, snapshotParent);
    await writeFile(join(dataDir, "state.json"), "verified replacement state");
    await snapshot.finalize();
    assert.equal(await readFile(join(dataDir, "state.json"), "utf8"), "verified replacement state");
    assert.deepEqual(await readdir(snapshotParent), [], "a successful update must remove its temporary data snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
