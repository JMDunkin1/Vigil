import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  acquireUpdaterLock,
  prepareLocalUpdateReceipt,
  prepareRemoteUpdateReceipt,
  readRepoInfoForTest,
  shouldBuildLocalCheckout,
  shouldInstallRemoteUpdate,
  terminateUpdaterChildAndConfirm,
  updateMessage,
  updaterChildEnvironment,
  updaterExecutableSearchPath,
  waitForUpdaterBootstrap
} from "../app/updater.js";
import { localBuildIdentityMatches } from "../scripts/launch-local-app.mjs";
import { gitExecutable, selectGitExecutable } from "../scripts/git-executable.mjs";
import {
  designatedRequirementFromCodesignOutput,
  macSigningTimestamp,
  selectMacSigningIdentity,
  signingIdentityFromCodesignDetail
} from "../scripts/mac-signing-identity.mjs";
import {
  atomicInstallBuiltApp,
  reconcileAtomicInstallResidue,
  resolveInstalledRuntimeTarget,
  selectedSourceIdentityMatches,
  snapshotUpdateState
} from "../scripts/update-packaged-app.mjs";
import type { AtomicInstallOperations } from "../scripts/update-packaged-app.mjs";
import { beginUpdateReceipt, mergeWriteUpdateReceipt, newUpdateReceipt, readUpdateReceipt } from "../src/updateReceipt.js";
import type { UpdateRecoveryOutcome } from "../src/updateTransaction.js";

const sourceRoot = existsSync(join(process.cwd(), "app", "updater.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const mainSource = await readFile(join(sourceRoot, "app", "main.ts"), "utf8");
const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const updateScriptSource = await readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8");
const localLauncherSource = await readFile(join(sourceRoot, "scripts", "launch-local-app.mts"), "utf8");
const updateViewSource = await readFile(join(sourceRoot, "public", "app-update-state.ts"), "utf8");
const embeddedSupervisorSource = await readFile(join(sourceRoot, "src", "embeddedSupervisor.ts"), "utf8");
const packageMacSource = await readFile(join(sourceRoot, "scripts", "package-mac.mjs"), "utf8");
const writeBuildInfoSource = await readFile(join(sourceRoot, "scripts", "write-build-info.mts"), "utf8");
const buildHumanIdleSource = await readFile(join(sourceRoot, "scripts", "build-human-idle-helper.mjs"), "utf8");
const atomicSwapSource = await readFile(join(sourceRoot, "app", "vigil-atomic-swap.c"), "utf8");
const execFile = promisify(execFileCallback);

assert.equal(macSigningTimestamp("Vigil Local Code Signing"), "none", "local self-signing must not depend on Apple's timestamp service");
assert.equal(macSigningTimestamp("Apple Development: Example"), "none", "local Apple Development signing must not wait on network timestamping");
assert.equal(macSigningTimestamp("Developer ID Application: Example"), undefined, "distributable identities must retain normal timestamping");
const localRequirement = 'identifier "tech.caseline.vigil" and anchor trusted';
assert.equal(
  designatedRequirementFromCodesignOutput(`designated => ${localRequirement}\n`, "Executable=/Applications/Vigil.app"),
  localRequirement,
  "guardian signature checks must accept the macOS codesign requirement on stdout"
);
assert.equal(
  designatedRequirementFromCodesignOutput("", `designated => ${localRequirement}\n`),
  localRequirement,
  "guardian signature checks must remain compatible with codesign versions that report requirements on stderr"
);
assert.equal(
  signingIdentityFromCodesignDetail("Authority=Vigil Local Code Signing\nAuthority=Example Root\n"),
  "Vigil Local Code Signing",
  "protocol bridges must preserve the installed leaf signing identity"
);
assert.equal(
  signingIdentityFromCodesignDetail("Signature=adhoc\nTeamIdentifier=not set\n"),
  "-",
  "protocol bridges must preserve an installed ad-hoc identity"
);
const mixedSigningIdentities = [
  "Vigil Local Code Signing",
  "Apple Development: Example"
];
assert.equal(
  selectMacSigningIdentity(mixedSigningIdentities, "Vigil Local Code Signing"),
  "Vigil Local Code Signing",
  "an installed local identity must remain selected even when Apple Development is also available"
);
assert.equal(
  selectMacSigningIdentity(mixedSigningIdentities, "Apple Development: Example"),
  "Apple Development: Example",
  "an installed Apple Development identity must remain selected when the local identity is also available"
);
assert.equal(selectMacSigningIdentity(mixedSigningIdentities, "-"), "-", "an ad-hoc installed app must remain ad-hoc");
assert.throws(
  () => selectMacSigningIdentity(mixedSigningIdentities, "Vigil Missing Signing Identity"),
  /installed Vigil app uses Vigil Missing Signing Identity[\s\S]*not available/u,
  "a missing installed identity must fail instead of rotating the app to another available certificate"
);
assert.match(packageMacSource, /-c\.mac\.timestamp=\$\{timestamp\}/u, "local app builds must pass the safe timestamp policy to electron-builder");
assert.match(updateScriptSource, /join\(repoRoot, "scripts", "package-mac\.mjs"\)/u, "remote and local updates must share the universal signing and packaging policy");
assert.match(updateScriptSource, /join\(outputPath, "mac-universal", "Vigil\.app"\)/u, "remote updates must install the fresh universal artifact");

const preflightIndex = updaterSource.indexOf("const sourcePreflight = await collectSourceUpdatePreflight({");
const remoteQuitHandlerIndex = updaterSource.indexOf('process.on("SIGUSR2", requestQuit)');
assert.ok(preflightIndex >= 0 && remoteQuitHandlerIndex > preflightIndex,
  "the complete named preflight, including strict signature verification, must finish before the updater can ask the app to quit");
assert.match(updaterSource, /code: "vigil\.update\.app\.signature"[\s\S]*?assertLocallyRebuildableApp\(appPath\)/u);
assert.match(
  updaterSource,
  /assertGuardianMaintenanceActive\([\s\S]*?await quitForUpdate\(\);[\s\S]*?process\.off\("SIGUSR2", requestQuit\)/u,
  "a signal may request replacement only after the updater and live restart supervisor are both authenticated"
);
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
assert.equal(
  shouldBuildLocalCheckout({ upstream: "upstream-commit", ahead: 1 }, true, false),
  true,
  "a clean checkout ahead of upstream must rebuild its checked-out HEAD instead of trying to fast-forward to an older commit"
);
assert.equal(
  shouldBuildLocalCheckout({ upstream: "upstream-commit", ahead: 1 }, false, false),
  false,
  "an ahead checkout already represented by the installed app must not rebuild unnecessarily"
);
assert.equal(
  shouldBuildLocalCheckout({ upstream: null, ahead: 0 }, true, false),
  true,
  "a clean checkout without an upstream must remain a valid local build source"
);
assert.equal(
  shouldInstallRemoteUpdate({ upstream: "upstream-commit", ahead: 1, behind: 1, dirty: false }, false),
  false,
  "a diverged checkout must not offer a remote update that cannot fast-forward"
);
assert.equal(
  shouldInstallRemoteUpdate({ upstream: "upstream-commit", ahead: 0, behind: 1, dirty: false }, false),
  true,
  "a clean checkout strictly behind upstream must remain eligible for remote installation"
);
assert.equal(
  shouldInstallRemoteUpdate({ upstream: "upstream-commit", ahead: 0, behind: 1, dirty: false }, true, true),
  false,
  "an app already verified at upstream must not be reinstalled merely because checkout synchronization lagged"
);
const newerRemoteTopology = {
  ok: true,
  error: null,
  repoRoot: "/vigil",
  branch: "main",
  head: "1".repeat(40),
  upstream: "2".repeat(40),
  ahead: 0,
  behind: 1,
  dirty: false
};
const historicalCompleteReceipt = newUpdateReceipt({
  attemptId: "historical-complete",
  kind: "remote",
  phase: "complete",
  message: "Vigil update complete",
  sourceCommit: "0".repeat(40),
  targetCommit: "1".repeat(40)
});
const historicalCompleteOutcome: UpdateRecoveryOutcome = {
  version: 1,
  attemptId: historicalCompleteReceipt.attemptId,
  status: "complete",
  message: "Vigil completed the interrupted update transaction.",
  recoveredAt: "2026-07-22T12:00:00.000Z",
  installedIdentity: null,
  sourceSyncPending: false
};
const historicalMessageBase = {
  repo: newerRemoteTopology,
  sourceFingerprintOk: true,
  appBundleOutdated: true,
  appMatchesUpstream: false,
  localChanges: false,
  running: false,
  recoveryPending: false,
  recoveryBlocked: false,
  recoveryMessage: null,
  activeAttemptStatus: null,
  remoteCheckError: false,
  maintenance: { ready: true, guardianInstalled: false, message: null },
  orphanedAttempt: false,
  orphanedAttemptInstalled: false
};
assert.equal(updateMessage({
  ...historicalMessageBase,
  recoveryOutcome: historicalCompleteOutcome,
  lastUpdate: historicalCompleteReceipt,
  lastUpdateCorrectedComplete: true,
  lastUpdateSuperseded: true
}), "1 remote commit ready", "a persisted complete recovery outcome must not mask a newly fetched upstream update");

const supersededFailureReceipt = newUpdateReceipt({
  attemptId: "superseded-failure",
  kind: "remote",
  phase: "failed",
  message: "An older update failed",
  sourceCommit: "0".repeat(40),
  targetCommit: "1".repeat(40)
});
assert.equal(updateMessage({
  ...historicalMessageBase,
  recoveryOutcome: null,
  lastUpdate: supersededFailureReceipt,
  lastUpdateCorrectedComplete: true,
  lastUpdateSuperseded: true
}), "1 remote commit ready", "a superseded failed receipt must not claim Vigil is current when a newer upstream update is ready");
assert.equal(updateMessage({
  ...historicalMessageBase,
  repo: { ...newerRemoteTopology, dirty: true },
  appBundleOutdated: false,
  recoveryOutcome: null,
  lastUpdate: supersededFailureReceipt,
  lastUpdateCorrectedComplete: false,
  lastUpdateSuperseded: false
}), "Commit or stash local edits before installing remote updates", "a historical failure must not mask the checkout's current dirty-and-behind blocker");
assert.equal(updateMessage({
  ...historicalMessageBase,
  repo: { ...newerRemoteTopology, ahead: 1 },
  appBundleOutdated: false,
  recoveryOutcome: null,
  lastUpdate: supersededFailureReceipt,
  lastUpdateCorrectedComplete: false,
  lastUpdateSuperseded: false
}), "This checkout has diverged from its upstream; remote updates are not auto-installed", "a historical failure must not mask the checkout's current divergence blocker");
assert.equal(updateMessage({
  ...historicalMessageBase,
  localChanges: true,
  remoteCheckError: true,
  recoveryOutcome: null,
  lastUpdate: null,
  lastUpdateCorrectedComplete: false,
  lastUpdateSuperseded: false
}), "Local changes ready to run", "a failed remote fetch must not contradict an independently verified local-build action");
assert.deepEqual(
  updaterExecutableSearchPath("/Users/vigil", "/custom/bin:/usr/bin").split(":"),
  [
    "/Users/vigil/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/custom/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ],
  "updater tool discovery must survive a sanitized LaunchServices environment"
);
const shebangRoot = await mkdtemp(join(tmpdir(), "vigil-updater-shebang-"));
try {
  const npmFixture = join(shebangRoot, "npm-fixture");
  await writeFile(npmFixture, "#!/usr/bin/env node\nprocess.stdout.write('canonical-node-found')\n");
  await chmod(npmFixture, 0o755);
  const sanitizedEnv = updaterChildEnvironment("/Users/vigil", process.execPath, npmFixture, {
    PATH: "/usr/bin:/bin"
  });
  const fixtureResult = await execFile(npmFixture, [], { env: sanitizedEnv });
  assert.equal(fixtureResult.stdout, "canonical-node-found", "the propagated updater PATH must run an npm-style env-node shebang");
  assert.equal(sanitizedEnv.PATH?.split(":")[0], resolve(process.execPath, ".."));
} finally {
  await rm(shebangRoot, { recursive: true, force: true });
}
assert.match(updaterSource, /await gitExecutable\(repoRoot\)/u, "repository verification must resolve a working Git binary");
assert.match(updaterSource, /const canonicalPath = await realpath\(path\)/u, "the updater must launch the canonical Node executable rather than a user-path symlink rejected by the root guardian");
assert.match(updateScriptSource, /command === "git" \? await gitExecutable\(cwd\) : command/u, "the external updater must use the same verified Git binary");
assert.match(
  updateScriptSource,
  /optionsForRun\.cwd \|\| options\?\.repoRoot \|\| process\.cwd\(\)/u,
  "installed-topology preflight must not read CLI options before direct updater argument parsing"
);
assert.match(
  buildHumanIdleSource,
  /resolveDeveloperTools\(\)[\s\S]*?CommandLineTools\/usr\/bin[\s\S]*?XcodeDefault\.xctoolchain[\s\S]*?\/usr\/bin/u,
  "local rebuilds must bypass unusable Apple compiler shims after an Xcode update"
);
assert.match(updateScriptSource, /VIGIL_BUILD_SOURCE_ROOT: options\.repoRoot/u, "staged update builds must preserve the real checkout pointer");
assert.match(
  updateScriptSource,
  /const installedRuntimePath = await resolveInstalledRuntimeTarget\(options\.repoRoot\)/u,
  "the remote updater must bind the intentionally symlinked dist runtime to a canonical durable recovery target"
);
const runtimeMappingRoot = await realpath(await mkdtemp(join(tmpdir(), "vigil-runtime-mapping-")));
try {
  const intendedRuntimePath = join(runtimeMappingRoot, "dist.nosync", "runtime");
  await mkdir(intendedRuntimePath, { recursive: true });
  await symlink("dist.nosync", join(runtimeMappingRoot, "dist"), "dir");
  assert.equal(
    await resolveInstalledRuntimeTarget(runtimeMappingRoot),
    intendedRuntimePath,
    "the standard dist -> dist.nosync mapping must select the canonical runtime target"
  );

  await rm(join(runtimeMappingRoot, "dist"));
  await mkdir(join(runtimeMappingRoot, "retargeted-output", "runtime"), { recursive: true });
  await symlink("retargeted-output", join(runtimeMappingRoot, "dist"), "dir");
  await assert.rejects(
    resolveInstalledRuntimeTarget(runtimeMappingRoot),
    /does not resolve to its authorized dist\.nosync runtime target/u,
    "an ignored dist link must not redirect update replacement to another directory"
  );
} finally {
  await rm(runtimeMappingRoot, { recursive: true, force: true });
}
assert.ok(
  updateScriptSource.indexOf("await guardianMaintenanceReadiness()")
    < updateScriptSource.indexOf("stagedBuild = await buildInIsolatedWorktree()"),
  "guardian compatibility must fail before dependency installation, compilation, and signing"
);
assert.doesNotMatch(updateScriptSource, /run\("git", \["fetch", "--prune"\]/u, "the external updater must reuse the commit already fetched and selected by the app");
assert.match(updaterSource, /"--expected-commit", String\(currentStatus\.upstreamCommit \|\| ""\)/u, "the app must pin the remotely verified commit for the external updater");
assert.match(
  updaterSource,
  /"--expected-initial-commit", String\(currentStatus\.currentCommit \|\| ""\),[\s\S]*?"--expected-branch", String\(currentStatus\.branch \|\| ""\),[\s\S]*?"--expected-commit", String\(currentStatus\.upstreamCommit \|\| ""\)/u,
  "the remote child must receive the controller-selected initial HEAD and branch as well as its target"
);
assert.equal(
  selectedSourceIdentityMatches("a".repeat(40), "main", "a".repeat(40), "release"),
  false,
  "a same-commit branch switch must invalidate the selected remote source"
);
assert.equal(
  selectedSourceIdentityMatches("a".repeat(40), "HEAD", "a".repeat(40), "HEAD"),
  true,
  "an explicitly selected detached HEAD must retain its detached identity"
);
assert.ok(
  updateScriptSource.indexOf("await assertSelectedSourceIdentity()")
    < updateScriptSource.indexOf('const dirty = (await capture("git", ["status"')
    && updateScriptSource.indexOf("await assertActiveCheckoutUnchanged(stagedBuild)")
      < updateScriptSource.indexOf("await stageUpdateArtifactCandidate("),
  "initial source/ref mismatches must fail before artifact staging or the authenticated shutdown"
);
assert.match(
  writeBuildInfoSource,
  /rev-parse", "--path-format=absolute", "--git-common-dir/u,
  "manual builds from temporary worktrees must retain the durable primary checkout pointer"
);
assert.ok(
  updateScriptSource.indexOf("const defaultInstallOperations") < updateScriptSource.lastIndexOf("if (isDirectRun(import.meta.url)) await runPackagedUpdate()"),
  "the direct updater must start only after its default atomic install operations are initialized"
);
assert.match(updaterSource, /localCheckoutBuild \|\| remoteCheckOk !== false/u, "new local changes must remain runnable without a remote fetch");
assert.match(updaterSource, /if \(updateAvailable\) displayPhase = "available"/u, "current actionable topology must not inherit a historical terminal receipt phase");
assert.ok(
  updaterSource.indexOf("if (currentStatus.checkOk !== true)")
    < updaterSource.indexOf("await prepareLocalUpdateReceipt(statusPath, updateLock.token, currentStatus)"),
  "local receipt creation must follow repository, setup, and exact source-identity validation"
);
const guardianSetupIndex = updaterSource.indexOf("await setupGuardian({");
const postSetupStatusIndex = updaterSource.indexOf(
  "currentStatus = await readStatusPayload({ ownedLockToken: updateLock.token })",
  guardianSetupIndex
);
const localReceiptIndex = updaterSource.indexOf(
  "await prepareLocalUpdateReceipt(statusPath, updateLock.token, currentStatus)"
);
assert.ok(
  guardianSetupIndex >= 0
    && postSetupStatusIndex > guardianSetupIndex
    && localReceiptIndex > postSetupStatusIndex,
  "one-time guardian setup must complete and revalidate readiness before any local update receipt is committed"
);
assert.ok(
  updaterSource.indexOf("if (!setupResult.ok)", guardianSetupIndex) < postSetupStatusIndex,
  "canceling one-time setup must return before update state is revalidated or an update receipt can begin"
);
assert.match(
  updaterSource,
  /const updateCandidateAvailable = Boolean\(checkOk && supported && \([\s\S]*?\)\);[\s\S]*?const updateAvailable = updateCandidateAvailable/u,
  "a verified candidate must remain visible while repairable guardian setup is pending"
);
assert.ok(
  updaterSource.indexOf("readStatusPayload({ checkRemote: true, ownedLockToken: updateLock.token })")
    < updaterSource.indexOf("await prepareRemoteUpdateReceipt(statusPath, updateLock.token, currentStatus)"),
  "remote receipt creation must follow the second fetch and target revalidation"
);
assert.match(updaterSource, /appBuild\?\.sourceFingerprint === currentSourceFingerprint/u, "the installed app must match both commit and source fingerprint, even after a dirty build is cleaned");
assert.match(mainSource, /deriveAppUpdateViewState\(status\)\.installable/u, "the tray must use the shared updater view-state decision");
assert.match(
  mainSource,
  /quitForUpdate: async \(\) => \{[\s\S]*?await assertEmbeddedRuntimeSupervisorArmedForUpdate\(\)[\s\S]*?quitForUpdate = true;[\s\S]*?app\.quit\(\)/u,
  "authenticated replacement must leave the maintenance-aware restart supervisor online"
);
const armedSupervisorCheck = mainSource.slice(
  mainSource.indexOf("function assertEmbeddedRuntimeSupervisorArmedForUpdate"),
  mainSource.indexOf("function resumeEmbeddedRuntimeSupervisor")
);
assert.doesNotMatch(armedSupervisorCheck, /rmSync\(markerPath/u, "the update quit path must not remove its persistent recovery marker");
assert.match(mainSource, /maintenanceReady: status(?:\?\.|\.)maintenanceReady !== false/u, "the tray must retain updater maintenance readiness");
assert.match(updateViewSource, /actionLabel = "Update Setup Required"/u, "neither UI may relabel an incompatible updater as installable");
assert.match(mainSource, /appUpdateActionState\.maintenanceReady/u, "the tray must disable an update action that cannot pass protected maintenance");
assert.match(mainSource, /scheduleAppUpdateRefresh\(appUrl\)/u, "the tray must refresh a local build that leaves Vigil running");
assert.match(
  mainSource,
  /async function refreshTrayStatus[\s\S]*?if \(!appUpdateOperation\) await refreshRunningAppUpdate\(appUrl\)/u,
  "every replacement app launch and tray poll must rehydrate the durable updater state"
);
assert.match(
  updaterSource,
  /launchLocalChanges\(currentStatus, updateLock, sourcePreflight\)/u,
  "dirty source must use the local app launcher with the verified preflight toolchain"
);
assert.match(updaterSource, /"--app-path", appPath/u, "the local launcher must receive the installed app path for recovery");
assert.match(updaterSource, /"--status-path", statusPath/u, "local and remote updates must share one durable receipt");
assert.match(updaterSource, /"--expected-fingerprint", String\(currentStatus\.currentSourceFingerprint \|\| ""\)/u, "local builds must pin the selected source fingerprint");
assert.match(
  updaterSource,
  /"--lock-path", updateLock\.path,[\s\S]*?"--lock-token", updateLock\.token/u,
  "the local launcher must receive the transferred authenticated updater lock"
);
assert.match(localLauncherSource, /exitCode = await buildLocalApp\(options, snapshotRoot, packageOutputRoot, log\)/u, "the local launcher must remain alive through the packaged local build");
assert.match(localLauncherSource, /\["run", "build"\]/u, "local changes must rebuild the Vigil runtime before packaging");
assert.match(
  localLauncherSource,
  /mkdtemp\(join\(dirname\(options\.statusPath\), "local-build-"\)\)[\s\S]*?"mac-universal", "Vigil\.app"/u,
  "the local launcher must install a universal artifact from a fresh attempt-specific output directory"
);
assert.match(localLauncherSource, /\["worktree", "add", "--detach", snapshotRoot, options\.expectedCommit\]/u, "local changes must build from a pinned isolated source worktree");
assert.match(
  localLauncherSource,
  /\["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"\]/u,
  "tracked local edits must be reproduced exactly without invoking repository-configured diff programs or text converters"
);
assert.match(localLauncherSource, /\["ls-files", "--others", "--exclude-standard", "-z"\]/u, "untracked local source must be copied into the isolated worktree");
assert.match(localLauncherSource, /snapshotFingerprint !== options\.expectedFingerprint/u, "the reconstructed isolated source must match the pinned fingerprint before build");
assert.match(atomicSwapSource, /renameatx_np\([\s\S]*?RENAME_SWAP/u, "macOS bundle replacement must use an atomic filesystem swap");
assert.match(buildHumanIdleSource, /vigil-atomic-swap/u, "the atomic swap helper must be built as a universal runtime executable");
assert.match(
  localLauncherSource,
  /timedOut = true;[\s\S]*?stopBuildCommand\(child\.pid, "SIGTERM"\);[\s\S]*?terminationGrace = setTimeout\([\s\S]*?stopBuildCommand\(child\.pid, "SIGKILL"\);[\s\S]*?waitForKillConfirmation\(\)/u,
  "a timed-out local build must allow graceful termination, escalate the process group, and await kill confirmation"
);
assert.match(
  updaterSource,
  /timedOut = true;[\s\S]*?signalUpdaterChild\(child\.pid, "SIGTERM"\);[\s\S]*?terminationGrace = setTimeout\([\s\S]*?signalUpdaterChild\(child\.pid, "SIGKILL"\);[\s\S]*?awaitKillConfirmation\(\)/u,
  "a timed-out update check must reap its Git process group before another check or install can proceed"
);
assert.match(
  localLauncherSource,
  /finishTimedOutCommandWhenStopped[\s\S]*?processGroupStillExists\(\)[\s\S]*?childClosed \|\| killConfirmationReached/u,
  "local build cleanup must not begin until the timed-out child process group is gone"
);
assert.match(
  updateScriptSource,
  /timedOut = true;[\s\S]*?stopChild\(child\.pid, "SIGTERM"\);[\s\S]*?terminationGrace = setTimeout\([\s\S]*?stopChild\(child\.pid, "SIGKILL"\);[\s\S]*?waitForKillConfirmation\(\)/u,
  "a timed-out packaged-update command must allow graceful termination, escalate the process group, and await kill confirmation"
);
assert.match(
  updateScriptSource,
  /finishTimedOutCommandWhenStopped[\s\S]*?processGroupStillExists\(\)[\s\S]*?childClosed \|\| killConfirmationReached/u,
  "packaged-update cleanup must not begin until the timed-out child process group is gone"
);
assert.equal(
  localBuildIdentityMatches({
    builtAt: "2026-07-22T12:00:01.000Z",
    commit: "1".repeat(40),
    sourceFingerprint: "a".repeat(64)
  }, "1".repeat(40), "a".repeat(64), Date.parse("2026-07-22T12:00:00.000Z")),
  true,
  "a freshly built candidate with the pinned commit and fingerprint must be accepted"
);
assert.equal(
  localBuildIdentityMatches({
    builtAt: "2026-07-22T12:00:01.000Z",
    commit: "1".repeat(40),
    sourceFingerprint: "b".repeat(64)
  }, "1".repeat(40), "a".repeat(64), Date.parse("2026-07-22T12:00:00.000Z")),
  false,
  "a stale or mismatched local artifact must never be installed"
);
assert.match(localLauncherSource, /if \(buildError \|\| exitCode !== 0\)/u, "candidate identity failures must stop installation even after packaging exited successfully");
assert.ok(
  localLauncherSource.indexOf("exitCode = await buildLocalApp(options, snapshotRoot, packageOutputRoot, log)") < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local changes must finish building before the running app is asked to quit"
);
assert.ok(
  updateScriptSource.indexOf("stagedBuild = await buildInIsolatedWorktree()")
    < updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "remote updates must finish staging before the running app is asked to quit"
);
assert.ok(
  updateScriptSource.indexOf("runtimePlan = await stageUpdateArtifactCandidate(")
    < updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")')
    && updateScriptSource.indexOf('process.kill(options.parentPid, "SIGUSR2")')
      < updateScriptSource.indexOf("await activateStagedUpdateArtifact("),
  "remote updates may durably copy candidates while Vigil runs but must not activate them before graceful shutdown"
);
assert.match(
  updateScriptSource,
  /catch \(error\) \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\);\s*throw error;\s*\}/u,
  "a timed-out remote update shutdown must restore restart supervision"
);
assert.match(
  localLauncherSource,
  /appPlan = await stageUpdateArtifactCandidate\([\s\S]*?builtAppPath,[\s\S]*?options\.appPath,[\s\S]*?"app"/u,
  "local changes must durably stage the exact installed app target"
);
assert.ok(
  localLauncherSource.indexOf("await stopLegacyLaunchAgentForUpdate(legacyAgent)")
    < localLauncherSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
    && localLauncherSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
      < localLauncherSource.indexOf("await activateStagedUpdateArtifact("),
  "the local updater must quiesce legacy state writers, persist the global WAL, and only then activate the app"
);
assert.match(
  localLauncherSource,
  /await verifyReplacement\(options\.appPath, recoveryPolicy\.expectedDataDir, legacyAgent\?\.context\);[\s\S]*?await markUpdateRecoveryCommitIntent\(recoveryPolicy, options\.lockToken, recoveryDependencies\)[\s\S]*?await markUpdateRecoveryCommitted\(recoveryPolicy, options\.lockToken, recoveryDependencies\)[\s\S]*?recoverUpdateTransaction\(recoveryPolicy, \{\s*\.\.\.recoveryDependencies,\s*allowRollback: false\s*\}\)/u,
  "local replacement must pass sustained signed health before the attempt-bound durable commit"
);
assert.match(
  localLauncherSource,
  /async function settleLocalGlobalUpdateAfterFailure[\s\S]*?terminateLocalInstalledCandidate\(options\.appPath, appPlan\)[\s\S]*?recoverUpdateTransaction\(recoveryPolicy, activeRecoveryDependencies\)[\s\S]*?outcome\.status === "failed-recovered"/u,
  "a pending local transaction must stop only its identified candidate before global rollback"
);
assert.match(
  localLauncherSource,
  /await recoveryDependenciesForStableHelper\(recoveryPolicy, recoveryManifest\)[\s\S]*?activateStagedUpdateArtifact\([\s\S]*?"app",\s*recoveryDependencies\s*\)/u,
  "local activation and finalization must use the recovery helper copy that survives app replacement"
);
assert.match(
  localLauncherSource,
  /reconcileStagedUpdateArtifactCandidate\(recoveryPolicy, recoveryPolicy\.expectedAppPath, "app"\)/u,
  "a local failure before the global manifest must reconcile its journaled target even when staging threw before returning a plan"
);
assert.ok(
  localLauncherSource.indexOf("legacyAgent = await captureLegacyLaunchAgentRecovery()")
    < localLauncherSource.indexOf("exitCode = await buildLocalApp(")
    && localLauncherSource.indexOf("exitCode = await buildLocalApp(")
      < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local replacement must capture rollback topology before building and before the candidate app can retire it"
);
assert.match(
  localLauncherSource,
  /async function captureLegacyLaunchAgentRecovery[\s\S]*?\["print", `gui\/\$\{uid\}\/com\.vigil\.agent`\][\s\S]*?if \(!loaded\.ok\) \{[\s\S]*?launchctlServiceMissing\(loaded\.stderr\)[\s\S]*?return null;[\s\S]*?readFile\(plistPath/u,
  "a preserved local plist must count as recovery state only when launchd confirms the legacy service is loaded"
);
assert.ok(
  localLauncherSource.indexOf("await waitForExit(options.parentPid, 45_000)")
    < localLauncherSource.indexOf("await stopLegacyLaunchAgentForUpdate(legacyAgent)")
    && localLauncherSource.indexOf("await stopLegacyLaunchAgentForUpdate(legacyAgent)")
      < localLauncherSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
    && localLauncherSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
      < localLauncherSource.indexOf("await activateStagedUpdateArtifact("),
  "the local updater must stop and verify a loaded legacy backend before the global state snapshot or app activation"
);
assert.match(
  localLauncherSource,
  /async function stopLegacyLaunchAgentForUpdate[\s\S]*?\["bootout", `gui\/\$\{recovery\.uid\}\/com\.vigil\.agent`\][\s\S]*?\["print", `gui\/\$\{recovery\.uid\}\/com\.vigil\.agent`\][\s\S]*?waitForLegacyBackendStopped/u,
  "the local updater must verify both launchd ownership and authenticated backend health are gone before snapshotting"
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
const localRollbackSource = localLauncherSource.slice(
  localLauncherSource.indexOf("async function settleLocalGlobalUpdateAfterFailure"),
  localLauncherSource.indexOf("\nasync function terminateLocalInstalledCandidate")
);
assert.match(
  localRollbackSource,
  /outcome\.status === "failed-recovered"[\s\S]*?await restoreLegacyLaunchAgent\(legacyAgent\)[\s\S]*?await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\)[\s\S]*?await reopenInstalledApp\(options\.appPath, log\)/u,
  "local rollback must restore legacy or embedded supervision only after the global transaction restores a coherent generation"
);
assert.doesNotMatch(localRollbackSource, /suspendEmbeddedRuntimeSupervisor/u,
  "local rollback must keep the maintenance-aware external recovery supervisor online");
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
  /catch \(error\) \{\s*await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\);[\s\S]*?The built app was not installed/u,
  "a timed-out local update shutdown must restore restart supervision"
);
assert.match(localLauncherSource, /"Library", "Logs", "Vigil", "local-launch\.log"/u, "local launch output must remain available in a durable log");
assert.match(updateScriptSource, /await openAndVerifyReplacement\(/u);
assert.match(
  updateScriptSource,
  /async function settleGlobalUpdateAfterFailure[\s\S]*?await terminateInstalledCandidate\(appPlan\)[\s\S]*?outcome = await recoverUpdateTransaction\(recoveryPolicy, activeRecoveryDependencies\)/u,
  "failed packaged updates must stop only the exact installed candidate before global rollback"
);
assert.match(
  updateScriptSource,
  /await recoveryDependenciesForStableHelper\(recoveryPolicy, recoveryManifest\)[\s\S]*?activateStagedUpdateArtifact\([\s\S]*?"runtime",\s*recoveryDependencies\s*\)[\s\S]*?activateStagedUpdateArtifact\([\s\S]*?"app",\s*recoveryDependencies\s*\)/u,
  "packaged runtime and app activation must use the recovery helper copy that survives app replacement"
);
assert.match(
  updateScriptSource,
  /markUpdateRecoveryCommitted\(recoveryPolicy, options\.lockToken, recoveryDependencies\)[\s\S]*?recoverUpdateTransaction\(recoveryPolicy, \{\s*\.\.\.recoveryDependencies,\s*allowRollback: false\s*\}\)/u,
  "packaged durable finalization must retain the policy-bound stable helper"
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
const failedUpdateRecoveryStart = updateScriptSource.indexOf("async function settleGlobalUpdateAfterFailure");
const failedUpdateRecoveryEnd = updateScriptSource.indexOf("\nasync function terminateInstalledCandidate", failedUpdateRecoveryStart);
const failedUpdateRecoverySource = updateScriptSource.slice(failedUpdateRecoveryStart, failedUpdateRecoveryEnd);
assert.match(
  failedUpdateRecoverySource,
  /recoverUpdateTransaction\(recoveryPolicy, \{\s*\.\.\.activeRecoveryDependencies,\s*allowRollback: false\s*\}\)[\s\S]*?recoverUpdateTransaction\(recoveryPolicy, activeRecoveryDependencies\)/u,
  "packaged failure settlement must retain the stable helper for roll-forward and rollback"
);
assert.doesNotMatch(
  failedUpdateRecoverySource,
  /suspendEmbeddedRuntimeSupervisor/u,
  "packaged rollback must keep the maintenance-aware external recovery supervisor online"
);
assert.match(
  failedUpdateRecoverySource,
  /outcome\.status === "failed-recovered"[\s\S]*?await startLaunchAgentAfterStateTransition\(launchAgentTransition\)[\s\S]*?await resumeEmbeddedRuntimeSupervisor\(options\.userDataDir\)[\s\S]*?await openAndVerifyRecoveredApp\(dataDir/u,
  "failed-update recovery must restore legacy or embedded supervision only after a coherent global rollback"
);
assert.doesNotMatch(updateScriptSource, /agentRuntimeInstallation|launchAgentRuntimePath/u,
  "the retiring legacy runtime must stay stopped instead of becoming a second independently updated writer");
assert.match(
  updateScriptSource,
  /run\("\/usr\/bin\/open", \["-g", options\.appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG\]\)/u,
  "updater verification must relaunch Vigil without activating it or opening a window"
);
assert.ok(
  updateScriptSource.indexOf("await openAndVerifyReplacement(")
    < updateScriptSource.indexOf("await markUpdateRecoveryCommitIntent(recoveryPolicy, options.lockToken")
    && updateScriptSource.indexOf("await markUpdateRecoveryCommitIntent(recoveryPolicy, options.lockToken")
      < updateScriptSource.indexOf("[\"merge\", \"--ff-only\", stagedBuild.expectedCommit]"),
  "the replacement must be healthy before the source checkout is fast-forwarded"
);
assert.match(
  updateScriptSource,
  /outcome\.status !== "complete"[\s\S]*?outcome\.sourceSyncPending[\s\S]*?Durable finalization subsequently verified the source checkout/u,
  "a complete transaction must prove source synchronization and must not publish an obsolete initial Git warning"
);
assert.ok(
  updateScriptSource.indexOf("launchAgentTransition = await stopLaunchAgentForStateTransition(launchAgentTransition)")
    < updateScriptSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
    && updateScriptSource.indexOf("await beginUpdateRecoveryTransaction(recoveryPolicy")
      < updateScriptSource.indexOf("await activateStagedUpdateArtifact("),
  "the updater must stop the old backend, persist the coherent global state WAL, and only then activate artifacts"
);
assert.match(
  failedUpdateRecoverySource,
  /expectedRuntimePaths\.map[\s\S]*?expectedAppPath[\s\S]*?reconcileStagedUpdateArtifactCandidate/u,
  "a pre-manifest failure must reconcile every fixed target even if staging threw before returning a plan"
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
      < updateScriptSource.indexOf("await openAndVerifyReplacement(replacementDataDirectory"),
  "LaunchAgent rollback metadata must be captured before the running app can retire the legacy service"
);
assert.match(
  updateScriptSource,
  /async function captureLoadedLaunchAgentRecovery[\s\S]*?\["print", `gui\/\$\{uid\}\/com\.vigil\.agent`\][\s\S]*?if \(!loaded\.ok\) \{[\s\S]*?launchctlServiceMissingDetail\(loaded\.stderr\)[\s\S]*?return null;[\s\S]*?captureLaunchAgentRecovery\(\)/u,
  "a preserved plist must count as legacy supervision only when launchd still has the service loaded"
);
assert.doesNotMatch(
  updateScriptSource,
  /async function restartLaunchAgent/u,
  "early updater rollback must use the captured plist to bootstrap an unloaded legacy service instead of only kickstarting its label"
);
assert.ok(
  updateScriptSource.indexOf('["merge", "--ff-only", stagedBuild.expectedCommit]')
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
  const liveLock = JSON.parse(await readFile(lockPath, "utf8")) as { ownerStartedAt?: unknown };
  assert.equal(typeof liveLock.ownerStartedAt, "string", "new locks must bind liveness to the owner's process start time");
  await winner.release();
  assert.equal(existsSync(lockPath), false);

  const abandoned = await acquireUpdaterLock(lockPath);
  await abandoned.transferTo(2_147_483_647);
  const replacement = await acquireUpdaterLock(lockPath);
  await abandoned.release();
  assert.equal(existsSync(lockPath), true, "an old owner must not delete a replacement lock");
  await replacement.release();
  assert.equal(existsSync(lockPath), false);

  const releaseSnapshotted = deferred();
  const continueRelease = deferred();
  const racedOwner = await acquireUpdaterLock(lockPath, process.pid, {
    async afterReleaseSnapshot() {
      releaseSnapshotted.resolve();
      await continueRelease.promise;
    }
  });
  const racedRelease = racedOwner.release();
  await releaseSnapshotted.promise;
  await rename(lockPath, `${lockPath}.superseded-owner`);
  const racedReplacement = await acquireUpdaterLock(lockPath);
  continueRelease.resolve();
  await racedRelease;
  const racedCanonical = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
  assert.equal(
    racedCanonical.token,
    racedReplacement.token,
    "an old owner's delayed release must restore rather than unlink a replacement acquired after its snapshot"
  );
  await racedReplacement.release();
  assert.equal(existsSync(lockPath), false);

  await writeFile(lockPath, "{malformed\n", { mode: 0o600 });
  const afterMalformed = await acquireUpdaterLock(lockPath);
  await afterMalformed.release();
  assert.equal((await readdir(lockRoot)).some((name) => name.startsWith("update.lock.invalid.")), true, "a malformed private stale lock must be quarantined rather than wedging updates forever");

  await verifyIdentityBoundUpdaterRecovery(lockPath, `${JSON.stringify({
    token: "stale-race",
    pid: 2_147_483_647,
    startedAt: "2026-07-22T12:00:00.000Z",
    ownerStartedAt: "2026-07-22T12:00:00.000Z"
  })}\n`, "stale");
  await verifyIdentityBoundUpdaterRecovery(lockPath, "{malformed-race\n", "malformed");

  await writeFile(lockPath, `${JSON.stringify({
    token: "legacy-reused-pid",
    pid: process.pid,
    startedAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });
  const afterLegacyPidReuse = await acquireUpdaterLock(lockPath);
  await afterLegacyPidReuse.release();
  assert.equal(existsSync(lockPath), false, "a pre-identity lock must not wedge forever when its PID belongs to an unrelated live process");

  const legacyToken = "legacy-live-owner";
  const legacyOwner = spawn(process.execPath, [
    "-e", "setInterval(() => {}, 1000)",
    "--",
    "--lock-path", lockPath,
    "--lock-token", legacyToken
  ], { stdio: "ignore" });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    legacyOwner.once("spawn", resolveSpawn);
    legacyOwner.once("error", rejectSpawn);
  });
  try {
    await writeFile(lockPath, `${JSON.stringify({
      token: legacyToken,
      pid: legacyOwner.pid,
      startedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      acquireUpdaterLock(lockPath),
      /already running/u,
      "a live legacy updater whose argv owns the exact path and token must retain its lock"
    );
  } finally {
    if (legacyOwner.exitCode === null && legacyOwner.signalCode === null) {
      legacyOwner.kill("SIGKILL");
      await new Promise<void>((resolveClose) => legacyOwner.once("close", () => resolveClose()));
    }
    await rm(lockPath, { force: true });
  }
} finally {
  await rm(lockRoot, { recursive: true, force: true });
}

const remotePreparationRoot = await mkdtemp(join(tmpdir(), "vigil-remote-revalidation-"));
try {
  const statusPath = join(remotePreparationRoot, "update-status.json");
  const priorSuccess = newUpdateReceipt({
    attemptId: "prior-success",
    kind: "remote",
    phase: "complete",
    message: "Vigil update complete",
    sourceCommit: "0".repeat(40),
    targetCommit: "1".repeat(40)
  });
  await beginUpdateReceipt(statusPath, priorSuccess);
  const priorBytes = await readFile(statusPath, "utf8");
  await assert.rejects(
    prepareLocalUpdateReceipt(statusPath, "invalid-local-identity", {
      currentCommit: "1".repeat(40),
      currentSourceFingerprint: "not-a-fingerprint"
    }),
    /stable identity/u,
    "a local attempt must not begin before its exact commit and fingerprint are verified"
  );
  assert.equal(await readFile(statusPath, "utf8"), priorBytes, "invalid local identity must preserve prior success evidence");
  await assert.rejects(
    prepareRemoteUpdateReceipt(statusPath, "invalid-remote-identity", {
      checkOk: true,
      remoteCheckOk: true,
      updateAvailable: true,
      currentCommit: "1".repeat(40),
      currentSourceFingerprint: "not-a-fingerprint",
      upstreamCommit: "2".repeat(40)
    }),
    /selected remote update identity/u,
    "a remote attempt must not begin before its exact selected identities are verified"
  );
  assert.equal(await readFile(statusPath, "utf8"), priorBytes, "invalid remote identity must preserve prior success evidence");
  await assert.rejects(
    prepareRemoteUpdateReceipt(statusPath, "failed-fetch", {
      checkOk: false,
      remoteCheckOk: false,
      remoteCheckError: "fatal: authentication failed",
      updateAvailable: false
    }),
    /could not verify the remote update target.*authentication failed/u,
    "a failed fetch must never be flattened into a successful no-update result"
  );
  assert.equal(await readFile(statusPath, "utf8"), priorBytes, "failed remote refresh must preserve prior success evidence");
  const noUpdate = await prepareRemoteUpdateReceipt(statusPath, "vanished-target", {
    ok: true,
    checkOk: true,
    remoteCheckOk: true,
    running: false,
    updateAvailable: false,
    currentCommit: "1".repeat(40),
    currentSourceFingerprint: "a".repeat(64),
    upstreamCommit: "1".repeat(40),
    lastUpdate: priorSuccess
  });
  assert.equal(noUpdate.started, false);
  assert.equal(noUpdate.status.noUpdate, true);
  assert.equal(noUpdate.status.phase, "", "a disappeared remote target must return an idle no-op instead of a failed attempt");
  assert.equal(
    await readFile(statusPath, "utf8"),
    priorBytes,
    "a no-update race must preserve the exact prior successful receipt bytes"
  );

  const selected = await prepareRemoteUpdateReceipt(statusPath, "confirmed-target", {
    ok: true,
    checkOk: true,
    remoteCheckOk: true,
    running: false,
    updateAvailable: true,
    currentCommit: "1".repeat(40),
    currentSourceFingerprint: "a".repeat(64),
    upstreamCommit: "2".repeat(40)
  });
  assert.equal(selected.started, true, "a revalidated remote target must begin its durable attempt receipt");
  const selectedReceipt = await readUpdateReceipt(statusPath);
  assert.equal(selectedReceipt.status, "valid");
  if (selectedReceipt.status === "valid") {
    assert.equal(selectedReceipt.receipt.attemptId, "confirmed-target");
    assert.equal(selectedReceipt.receipt.kind, "remote");
    assert.equal(selectedReceipt.receipt.targetCommit, "2".repeat(40));
  }
} finally {
  await rm(remotePreparationRoot, { recursive: true, force: true });
}

const bootstrapRoot = await mkdtemp(join(tmpdir(), "vigil-updater-bootstrap-"));
try {
  const statusPath = join(bootstrapRoot, "status.json");
  const successfulAttempt = "bootstrap-success";
  await beginUpdateReceipt(statusPath, newUpdateReceipt({
    attemptId: successfulAttempt,
    kind: "local",
    message: "Starting",
    startedAt: new Date()
  }));
  const advancePhase = async () => {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    await mergeWriteUpdateReceipt(statusPath, successfulAttempt, {
      phase: "building",
      message: "Child bootstrapped"
    });
  };
  await Promise.all([
    waitForUpdaterBootstrap(statusPath, successfulAttempt, process.pid, 1_000),
    advancePhase()
  ]);

  const failedAttempt = "bootstrap-failure";
  await beginUpdateReceipt(statusPath, newUpdateReceipt({
    attemptId: failedAttempt,
    kind: "remote",
    phase: "failed",
    message: "Preflight failed",
    startedAt: new Date()
  }));
  await assert.rejects(
    waitForUpdaterBootstrap(statusPath, failedAttempt, process.pid, 250),
    /Preflight failed/u,
    "a terminal child failure must never satisfy the startup handshake"
  );

  const vanishedAttempt = "bootstrap-vanished";
  await beginUpdateReceipt(statusPath, newUpdateReceipt({
    attemptId: vanishedAttempt,
    kind: "local",
    message: "Starting",
    startedAt: new Date()
  }));
  await assert.rejects(
    waitForUpdaterBootstrap(statusPath, vanishedAttempt, 2_147_483_647, 250),
    /exited before confirming startup/u,
    "a vanished child must fail the handoff instead of leaving a false running state"
  );

  let terminationSignals = 0;
  assert.equal(await terminateUpdaterChildAndConfirm(12_345, 0, {
    signal() { terminationSignals += 1; },
    processGroupExists: () => true,
    wait: async () => undefined
  }), false, "an unconfirmed live updater group must fail closed instead of authorizing lock release");
  assert.equal(terminationSignals, 1);
  assert.equal(await terminateUpdaterChildAndConfirm(12_345, 0, {
    signal() { terminationSignals += 1; },
    processGroupExists: () => false,
    wait: async () => undefined
  }), true, "confirmed updater group exit may release the transferred lock");
} finally {
  await rm(bootstrapRoot, { recursive: true, force: true });
}

assert.match(
  updaterSource,
  /if \(!terminated && updaterLockTransferred\) \{[\s\S]*?preserveUpdateLock = true;[\s\S]*?if \(!handedOff && !preserveUpdateLock\) await updateLock\.release\(\)/u,
  "remote bootstrap failure must preserve a transferred lock until process-group termination is confirmed"
);
assert.match(
  updaterSource,
  /finally \{[\s\S]*?if \(!handedOff && !preserveUpdateLock && downloadedPrebuiltRelease\)[\s\S]*?if \(!handedOff && !preserveUpdateLock\) await updateLock\.release\(\)/u,
  "an unconfirmed child owner must retain both its updater lock and private prebuilt candidate"
);
assert.match(
  updaterSource,
  /if \(!await terminateUpdaterChildAndConfirm\(child\.pid\) && updateLockTransferred\)[\s\S]*?UpdaterBootstrapOwnershipError/u,
  "local bootstrap failure must use the same fail-closed transferred-lock ownership boundary"
);
assert.match(
  updaterSource,
  /if \(preserveUpdateLock\) \{[\s\S]*?phase: "waiting"[\s\S]*?running: preserveUpdateLock/u,
  "an unconfirmed updater owner must retain a nonterminal polling state instead of publishing a false terminal failure"
);

await verifyOriginalSurvivesMoveFailure("backup", (source, installedApp) => source === installedApp);
await verifyOriginalSurvivesMoveFailure("replacement", (source) => source.endsWith(".vigil-next"));
await verifyAtomicInstallResidueRecovery(true);
await verifyAtomicInstallResidueRecovery(false);
await verifyPreparingStageResidueRecovery();
await verifyPartialCopyIsQuarantinedAndRetryable();
await verifyIncompleteRollbackIdentityEvidenceFailsClosed();
await verifyRollbackResidueRecoveryIsIdempotent();
await verifyCompletedSwapReportedAsFailureRollsBackByIdentity();
await verifyRacedPreviousGenerationIsPreserved();
await verifyVerifiedGenerationRacesArePreserved();
await verifyTargetOnlyUnverifiedIdentityRules();
await verifyFinalizeResidueDoesNotBlockNextUpdate();
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
  await installation.markVerified();
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
      },
      async identity(path) {
        const value = await lstat(path);
        return { dev: value.dev, ino: value.ino };
      }
    };
  }
}

async function verifyIdentityBoundUpdaterRecovery(
  lockPath: string,
  staleContents: string,
  label: string
): Promise<void> {
  await writeFile(lockPath, staleContents, { mode: 0o600, flag: "wx" });
  const firstSnapshotted = deferred();
  const secondSnapshotted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const firstAttempt = acquireUpdaterLock(lockPath, process.pid, {
    async afterSnapshot() {
      firstSnapshotted.resolve();
      await releaseFirst.promise;
    }
  });
  await firstSnapshotted.promise;
  const secondAttempt = acquireUpdaterLock(lockPath, process.pid, {
    async afterSnapshot() {
      secondSnapshotted.resolve();
      await releaseSecond.promise;
    }
  });
  await secondSnapshotted.promise;

  releaseFirst.resolve();
  const winner = await firstAttempt;
  releaseSecond.resolve();
  await assert.rejects(secondAttempt, /already running/u, `${label} recovery must reject a delayed second reaper`);
  const canonical = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
  assert.equal(canonical.token, winner.token, `${label} recovery must restore the displaced live winner by identity`);
  await winner.release();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function verifyAtomicInstallResidueRecovery(canonicalPresent: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-residue-"));
  const installedApp = join(root, "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  const nextApp = `${installedApp}.vigil-next`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    let candidateIdentity: { dev: number; ino: number };
    if (canonicalPresent) {
      await mkdir(installedApp, { recursive: true });
      await writeFile(join(installedApp, "version.txt"), "unverified-candidate");
      const candidateStat = await lstat(installedApp);
      candidateIdentity = { dev: candidateStat.dev, ino: candidateStat.ino };
    } else {
      await mkdir(nextApp, { recursive: true });
      const candidateStat = await lstat(nextApp);
      candidateIdentity = { dev: candidateStat.dev, ino: candidateStat.ino };
      await rm(nextApp, { recursive: true });
    }
    await mkdir(previousApp, { recursive: true });
    await writeFile(join(previousApp, "version.txt"), "recoverable-previous");
    const initialStat = await lstat(previousApp);
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "interrupted-update",
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "installed",
      hadPrevious: true,
      initialPresent: true,
      initialDevice: initialStat.dev,
      initialInode: initialStat.ino,
      candidateDevice: candidateIdentity.dev,
      candidateInode: candidateIdentity.ino,
      updatedAt: new Date().toISOString()
    })}\n`);

    await reconcileAtomicInstallResidue(installedApp);
    assert.equal(
      await readFile(join(installedApp, "version.txt"), "utf8"),
      "recoverable-previous",
      "reconciliation must restore the known-good copy instead of committing an unverified canonical target"
    );
    assert.equal(existsSync(previousApp), false);
    assert.equal(existsSync(nextApp), false);
    assert.equal(existsSync(journalPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyPreparingStageResidueRecovery(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-preparing-residue-"));
  const installedApp = join(root, "Vigil.app");
  const nextApp = `${installedApp}.vigil-next`;
  const previousApp = `${installedApp}.vigil-previous`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "known-good-initial");
    const initial = await lstat(installedApp);
    await mkdir(nextApp, { recursive: true });
    await writeFile(join(nextApp, "partial.txt"), "power-loss-during-copy");
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "prestage-power-loss",
      attemptId: "prestage-power-loss",
      kind: "app",
      globalManifestPath: join(root, "updater", "update-recovery.json"),
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "preparing",
      hadPrevious: false,
      initialPresent: true,
      initialCommit: null,
      initialFingerprint: null,
      initialDevice: initial.dev,
      initialInode: initial.ino,
      updatedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });

    await reconcileAtomicInstallResidue(installedApp);
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "known-good-initial");
    assert.equal(existsSync(nextApp), false, "a partial preactivation copy must be discarded");
    assert.equal(existsSync(journalPath), false, "the reconciled preparation journal must not wedge the next update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyPartialCopyIsQuarantinedAndRetryable(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-partial-copy-"));
  const builtApp = join(root, "built", "Vigil.app");
  const installedApp = join(root, "installed", "Vigil.app");
  const nextApp = `${installedApp}.vigil-next`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  const quarantined: string[] = [];
  let copyAttempts = 0;
  try {
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new");
    await writeFile(join(installedApp, "version.txt"), "old");
    const operations: AtomicInstallOperations = {
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
        copyAttempts += 1;
        if (copyAttempts === 1) {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "partial.txt"), "incomplete clone");
          throw new Error("simulated interrupted app clone");
        }
        await cp(source, destination, { recursive: true, preserveTimestamps: true });
      },
      async move(source, destination) {
        await rename(source, destination);
      },
      async remove(path) {
        await rm(path, { recursive: true, force: true });
      },
      async identity(path) {
        const value = await lstat(path);
        return { dev: value.dev, ino: value.ino };
      },
      async quarantinePartial(path, quarantinePath) {
        await rename(path, quarantinePath);
        quarantined.push(quarantinePath);
      }
    };

    await assert.rejects(
      atomicInstallBuiltApp(builtApp, installedApp, "", operations),
      /simulated interrupted app clone/u
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "old");
    assert.equal(existsSync(nextApp), false, "an unpinned partial copy must leave the canonical staging name");
    assert.equal(existsSync(journalPath), false, "a quarantined pre-copy journal must not wedge retry");
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(join(quarantined[0], "partial.txt"), "utf8"), "incomplete clone",
      "partial bytes must remain available as noncanonical diagnostic evidence");

    const retry = await atomicInstallBuiltApp(builtApp, installedApp, "", operations);
    await retry.markVerified();
    await retry.finalize();
    assert.equal(copyAttempts, 2, "quarantined residue must not block the immediate retry");
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "new");
    assert.equal(existsSync(quarantined[0]), true, "successful retry must not silently erase quarantined evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyRollbackResidueRecoveryIsIdempotent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-rollback-retry-"));
  const installedApp = join(root, "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  const nextApp = `${installedApp}.vigil-next`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  let failCandidateCleanup = true;
  let swapCount = 0;
  try {
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "unverified-candidate");
    const candidateStat = await lstat(installedApp);
    await mkdir(previousApp, { recursive: true });
    await writeFile(join(previousApp, "version.txt"), "known-good-previous");
    const initialStat = await lstat(previousApp);
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "rollback-power-loss",
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "rolling-back",
      hadPrevious: true,
      initialPresent: true,
      initialDevice: initialStat.dev,
      initialInode: initialStat.ino,
      candidateDevice: candidateStat.dev,
      candidateInode: candidateStat.ino,
      updatedAt: new Date().toISOString()
    })}\n`);

    const operations: AtomicInstallOperations = {
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
        await rename(source, destination);
      },
      async remove(path) {
        if (path === previousApp && failCandidateCleanup) {
          failCandidateCleanup = false;
          throw new Error("simulated power loss after rollback swap");
        }
        await rm(path, { recursive: true, force: true });
      },
      async identity(path) {
        const value = await lstat(path);
        return { dev: value.dev, ino: value.ino };
      },
      async swap(left, right) {
        swapCount += 1;
        const temporary = `${left}.test-swap`;
        await rename(left, temporary);
        await rename(right, left);
        await rename(temporary, right);
      }
    };

    await assert.rejects(
      reconcileAtomicInstallResidue(installedApp, nextApp, previousApp, journalPath, operations),
      /simulated power loss after rollback swap/u
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "known-good-previous");
    assert.equal(await readFile(join(previousApp, "version.txt"), "utf8"), "unverified-candidate");
    assert.equal(existsSync(journalPath), true, "the journal must survive incomplete candidate cleanup for retry");

    await reconcileAtomicInstallResidue(installedApp, nextApp, previousApp, journalPath, operations);
    assert.equal(swapCount, 1, "a retry must not swap the displaced candidate back into service");
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "known-good-previous");
    assert.equal(existsSync(previousApp), false);
    assert.equal(existsSync(journalPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyIncompleteRollbackIdentityEvidenceFailsClosed(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-incomplete-rollback-evidence-"));
  const installedApp = join(root, "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  const nextApp = `${installedApp}.vigil-next`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "unverified-candidate");
    const candidate = await lstat(installedApp);
    await mkdir(previousApp, { recursive: true });
    await writeFile(join(previousApp, "version.txt"), "unproven-previous");
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "incomplete-rollback-evidence",
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "rolling-back",
      hadPrevious: true,
      candidateDevice: candidate.dev,
      candidateInode: candidate.ino,
      updatedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      reconcileAtomicInstallResidue(installedApp),
      /invalid replacement journal/u,
      "rollback must not infer that an unclassified previous sidecar is the initial generation"
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "unverified-candidate");
    assert.equal(await readFile(join(previousApp, "version.txt"), "utf8"), "unproven-previous");
    assert.equal((await readdir(root)).some((name) => name.startsWith("Vigil.app.vigil-transaction.json.invalid.")), true,
      "invalid identity evidence must be archived while both generations remain untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyCompletedSwapReportedAsFailureRollsBackByIdentity(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-unknown-swap-"));
  const builtApp = join(root, "built", "Vigil.app");
  const installedApp = join(root, "installed", "Vigil.app");
  let swaps = 0;
  try {
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new");
    await writeFile(join(installedApp, "version.txt"), "old");
    const operations = realIdentityOperations(async (left, right) => {
      swaps += 1;
      await exchangeDirectories(left, right);
      if (swaps === 1) throw new Error("helper exited after completed exchange");
    });
    await assert.rejects(
      atomicInstallBuiltApp(builtApp, installedApp, "", operations),
      /helper exited after completed exchange/u
    );
    assert.equal(swaps, 2,
      "an ambiguous helper error must be reconciled by the journal's observed generation identities");
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "old");
    assert.equal(existsSync(`${installedApp}.vigil-next`), false);
    assert.equal(existsSync(`${installedApp}.vigil-previous`), false);
    assert.equal(existsSync(`${installedApp}.vigil-transaction.json`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyRacedPreviousGenerationIsPreserved(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-raced-previous-"));
  const builtApp = join(root, "built", "Vigil.app");
  const installedApp = join(root, "installed", "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new");
    await writeFile(join(installedApp, "version.txt"), "old");
    const operations = realIdentityOperations(exchangeDirectories);
    const installation = await atomicInstallBuiltApp(builtApp, installedApp, "", operations);
    await rm(previousApp, { recursive: true, force: true });
    await mkdir(previousApp, { recursive: true });
    await writeFile(join(previousApp, "version.txt"), "raced-untrusted");

    await assert.rejects(
      installation.rollback(),
      /cannot identify|cannot prove|recovery evidence was preserved/iu,
      "rollback must never restore a path that no longer has the pinned initial inode"
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "new",
      "the verified candidate generation must remain canonical when the rollback copy is ambiguous");
    assert.equal(await readFile(join(previousApp, "version.txt"), "utf8"), "raced-untrusted",
      "ambiguous evidence must be preserved for diagnosis instead of moved into service");
    assert.equal(existsSync(journalPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyVerifiedGenerationRacesArePreserved(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-verified-race-"));
  const builtApp = join(root, "built", "Vigil.app");
  const installedApp = join(root, "installed", "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new");
    await writeFile(join(installedApp, "version.txt"), "old");
    const operations = realIdentityOperations(exchangeDirectories);
    const installation = await atomicInstallBuiltApp(builtApp, installedApp, "", operations);
    await installation.markVerified();

    const savedPrevious = join(root, "verified-previous-preserved.app");
    await rename(previousApp, savedPrevious);
    await mkdir(previousApp, { recursive: true });
    await writeFile(join(previousApp, "version.txt"), "unrecognized-sidecar");
    await assert.rejects(
      installation.finalize(),
      /unrecognized replacement sidecar/u,
      "verified cleanup must not delete a sidecar whose inode is not one of the pinned generations"
    );
    assert.equal(existsSync(previousApp), true);
    assert.equal(existsSync(journalPath), true);

    await rm(previousApp, { recursive: true, force: true });
    await rename(savedPrevious, previousApp);
    const displacedCandidate = join(root, "verified-candidate-preserved.app");
    await rename(installedApp, displacedCandidate);
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "raced-canonical");
    await assert.rejects(
      reconcileAtomicInstallResidue(installedApp),
      /exact canonical candidate|verified candidate/u,
      "a verified phase string must not authorize cleanup around a replaced canonical inode"
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "raced-canonical");
    assert.equal(existsSync(journalPath), true, "ambiguous verified evidence must remain durable");

    await rm(installedApp, { recursive: true, force: true });
    await assert.rejects(
      reconcileAtomicInstallResidue(installedApp),
      /verified candidate is missing/u,
      "a missing verified candidate must never be replaced with an older previous generation"
    );
    assert.equal(existsSync(installedApp), false);
    assert.equal(await readFile(join(previousApp, "version.txt"), "utf8"), "old",
      "the exact old generation must remain a sidecar rather than being substituted as verified");
    assert.equal(existsSync(journalPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyTargetOnlyUnverifiedIdentityRules(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-target-only-"));
  const installedApp = join(root, "Vigil.app");
  const nextApp = `${installedApp}.vigil-next`;
  const previousApp = `${installedApp}.vigil-previous`;
  const journalPath = `${installedApp}.vigil-transaction.json`;
  try {
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "initial");
    const initial = await lstat(installedApp);
    const savedInitial = join(root, "saved-initial.app");
    await rename(installedApp, savedInitial);
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "unknown");
    const unknown = await lstat(installedApp);
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "target-only-unknown",
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "prepared",
      hadPrevious: false,
      initialPresent: true,
      initialDevice: initial.dev,
      initialInode: initial.ino,
      candidateDevice: unknown.dev,
      candidateInode: unknown.ino + 1,
      updatedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      reconcileAtomicInstallResidue(installedApp),
      /exact initial generation/u,
      "target-only recovery must not infer that every noncandidate directory is the initial app"
    );
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "unknown");
    assert.equal(existsSync(journalPath), true);

    await rm(installedApp, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(installedApp, "version.txt"), "candidate-with-no-initial");
    const candidate = await lstat(installedApp);
    await writeFile(journalPath, `${JSON.stringify({
      version: 2,
      id: "target-only-new-install",
      targetPath: installedApp,
      nextPath: nextApp,
      previousPath: previousApp,
      phase: "installed",
      hadPrevious: false,
      initialPresent: false,
      candidateDevice: candidate.dev,
      candidateInode: candidate.ino,
      updatedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    await reconcileAtomicInstallResidue(installedApp);
    assert.equal(existsSync(installedApp), false,
      "an exact unverified candidate may be removed only when the journal proves there was no initial app");
    assert.equal(existsSync(journalPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function realIdentityOperations(
  swap: (left: string, right: string) => Promise<void>
): AtomicInstallOperations {
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
      await rename(source, destination);
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async identity(path) {
      const value = await lstat(path);
      return { dev: value.dev, ino: value.ino };
    },
    swap
  };
}

async function exchangeDirectories(left: string, right: string): Promise<void> {
  const temporary = `${left}.test-exchange`;
  await rename(left, temporary);
  await rename(right, left);
  await rename(temporary, right);
}

async function verifyFinalizeResidueDoesNotBlockNextUpdate(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-updater-finalize-residue-"));
  const builtApp = join(root, "built", "Vigil.app");
  const installedApp = join(root, "installed", "Vigil.app");
  const previousApp = `${installedApp}.vigil-previous`;
  let failPreviousCleanup = true;
  try {
    await mkdir(builtApp, { recursive: true });
    await mkdir(installedApp, { recursive: true });
    await writeFile(join(builtApp, "version.txt"), "new-verified");
    await writeFile(join(installedApp, "version.txt"), "old-recovery");
    const operations: AtomicInstallOperations = {
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
        await rename(source, destination);
      },
      async remove(path) {
        if (path === previousApp && failPreviousCleanup && existsSync(path)) {
          failPreviousCleanup = false;
          throw new Error("simulated recovery-copy cleanup failure");
        }
        await rm(path, { recursive: true, force: true });
      },
      async identity(path) {
        const value = await lstat(path);
        return { dev: value.dev, ino: value.ino };
      }
    };
    const installation = await atomicInstallBuiltApp(builtApp, installedApp, "", operations);
    await installation.markVerified();
    await assert.rejects(installation.finalize(), /simulated recovery-copy cleanup failure/u);
    assert.equal(existsSync(previousApp), true, "the failed cleanup fixture must leave recoverable residue");
    await reconcileAtomicInstallResidue(installedApp);
    assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "new-verified");
    assert.equal(existsSync(previousApp), false, "the next attempt must self-heal a prior finalize residue");
    assert.equal(existsSync(`${installedApp}.vigil-transaction.json`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(dataDir, "usage.json"), "usage before update");
    await writeFile(join(dataDir, "usage.seal.json"), "usage seal before update");
    await writeFile(join(dataDir, "runtime-effects.json"), "outbox before update");
    if (preexistingJournalKey) {
      await writeFile(join(dataDir, "state-seal.key"), "original seal key");
      await writeFile(join(dataDir, "journal-encryption.key"), "original journal key");
    }

    const snapshot = await snapshotUpdateState(dataDir, snapshotParent);
    await writeFile(join(dataDir, "state.json"), "encrypted state from replacement");
    await writeFile(join(dataDir, "state.seal.json"), "replacement seal");
    await writeFile(join(dataDir, "usage.json"), "replacement usage");
    await writeFile(join(dataDir, "usage.seal.json"), "replacement usage seal");
    await writeFile(join(dataDir, "runtime-effects.json"), "replacement outbox");
    await writeFile(join(dataDir, "runtime-snapshot.wal.json"), "replacement wal");
    await writeFile(join(dataDir, "state-seal.key"), "replacement seal key");
    await writeFile(join(dataDir, "journal-encryption.key"), "replacement journal key");
    await snapshot.rollback();

    assert.equal(await readFile(join(dataDir, "state.json"), "utf8"), "plaintext state before update");
    assert.equal(await readFile(join(dataDir, "state.seal.json"), "utf8"), "seal before update");
    assert.equal(await readFile(join(dataDir, "usage.json"), "utf8"), "usage before update");
    assert.equal(await readFile(join(dataDir, "usage.seal.json"), "utf8"), "usage seal before update");
    assert.equal(await readFile(join(dataDir, "runtime-effects.json"), "utf8"), "outbox before update");
    assert.equal(existsSync(join(dataDir, "runtime-snapshot.wal.json")), false, "rollback must remove a replacement-only persistence WAL");
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
