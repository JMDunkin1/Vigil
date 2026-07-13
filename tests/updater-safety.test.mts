import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireUpdaterLock } from "../app/updater.js";
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
const packageMacSource = await readFile(join(sourceRoot, "scripts", "package-mac.mjs"), "utf8");
const writeBuildInfoSource = await readFile(join(sourceRoot, "scripts", "write-build-info.mts"), "utf8");

assert.equal(macSigningTimestamp("Vigil Local Code Signing"), "none", "local self-signing must not depend on Apple's timestamp service");
assert.equal(macSigningTimestamp("Apple Development: Example"), undefined, "Apple Development signing must keep its normal timestamp behavior");
assert.match(packageMacSource, /-c\.mac\.timestamp=\$\{timestamp\}/u, "local app builds must pass the safe timestamp policy to electron-builder");
assert.match(updateScriptSource, /-c\.mac\.timestamp=\$\{signingTimestamp\}/u, "isolated updater builds must use the same timestamp policy");

const preflightIndex = updaterSource.indexOf("await assertLocallyRebuildableApp(appPath)");
const quitIndex = updaterSource.indexOf("setTimeout(quitForUpdate");
assert.ok(preflightIndex >= 0 && quitIndex > preflightIndex, "signature preflight must finish before the app is told to quit");
assert.match(updaterSource, /let startInFlight: Promise<unknown> \| null = null/u);
assert.match(
  updaterSource,
  /plistStringForKey\(plist, "VigilSourceRoot"\) \|\| plistStringForKey\(plist, "WorkingDirectory"\)/u,
  "updater discovery must retain a repository pointer when the agent runs from its installed runtime"
);
assert.match(updateScriptSource, /\["worktree", "add", "--detach"/u);
assert.match(updaterSource, /packagedBuildRepoRoot\(app\)/u, "the installed app must retain its source checkout pointer");
assert.match(updateScriptSource, /VIGIL_BUILD_SOURCE_ROOT: options\.repoRoot/u, "staged update builds must preserve the real checkout pointer");
assert.match(
  writeBuildInfoSource,
  /rev-parse", "--path-format=absolute", "--git-common-dir/u,
  "manual builds from temporary worktrees must retain the durable primary checkout pointer"
);
assert.ok(
  updateScriptSource.indexOf("const defaultInstallOperations") < updateScriptSource.lastIndexOf("if (isDirectRun(import.meta.url)) await runUpdate()"),
  "the direct updater must start only after its default atomic install operations are initialized"
);
assert.match(updaterSource, /localChanges \|\| remoteCheckOk !== false/u, "new local changes must remain runnable without a remote fetch");
assert.match(updaterSource, /currentSourceFingerprint !== appBuild\.sourceFingerprint/u, "local changes must be compared with the source built into the installed app");
assert.match(mainSource, /return status\.updateAvailable === true/u, "the tray must honor the updater controller's installability decision");
assert.match(mainSource, /scheduleAppUpdateRefresh\(appUrl\)/u, "the tray must refresh a local build that leaves Vigil running");
assert.match(updaterSource, /launchLocalChanges\(currentStatus, updateLock\)/u, "dirty source must use the local app launcher");
assert.match(updaterSource, /"--app-path", appPath/u, "the local launcher must receive the installed app path for recovery");
assert.match(localLauncherSource, /exitCode = await buildLocalApp\(options, log\)/u, "the local launcher must remain alive through the packaged local build");
assert.match(localLauncherSource, /\["run", "build:mac"\]/u, "local changes must rebuild the Vigil app bundle instead of launching a second Electron app identity");
assert.ok(
  localLauncherSource.indexOf("exitCode = await buildLocalApp(options, log)") < localLauncherSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "local changes must finish building before the running app is asked to quit"
);
assert.match(localLauncherSource, /atomicInstallBuiltApp\(builtAppPath, options\.appPath, ""\)/u, "local changes must replace Vigil at the same installed app path");
assert.match(localLauncherSource, /await verifyReplacement\(options\.appPath\);[\s\S]*?await installation\.finalize\(\)/u, "the previous installed app must remain recoverable until the replacement stays healthy");
assert.match(localLauncherSource, /await terminateInstalledApp\(options\.appPath\);[\s\S]*?await installation\.rollback\(\)/u, "a failed replacement must stop before restoring and reopening the previous app");
assert.match(localLauncherSource, /await reopenInstalledApp\(options\.appPath, log\)/u, "a failed local launch must reopen the installed app");
assert.ok(
  localLauncherSource.indexOf("createWriteStream(options.logPath") < localLauncherSource.indexOf("await waitForExit(options.parentPid"),
  "the local launcher must create its log before waiting for the installed app to quit"
);
assert.match(localLauncherSource, /await waitForLogOpen\(log\)/u, "the local launcher must wait for its log descriptor before passing it to child processes");
assert.match(localLauncherSource, /The built app was not installed/u, "a stalled installed-app shutdown must leave the installed app untouched");
assert.match(localLauncherSource, /"Library", "Logs", "Vigil", "local-launch\.log"/u, "local launch output must remain available in a durable log");
assert.match(updateScriptSource, /await openAndVerifyReplacement\(/u);
assert.match(updateScriptSource, /launchAgentRuntimePath\(\)/u);
assert.ok(
  updateScriptSource.indexOf("agentRuntimeInstallation = await atomicInstallBuiltApp(")
    < updateScriptSource.indexOf("await startLaunchAgentAfterStateTransition(launchAgentTransition)"),
  "the updater must replace the installed LaunchAgent runtime before restarting it"
);
assert.match(
  updateScriptSource,
  /run\("\/usr\/bin\/open", \["-g", options\.appPath, "--args", BACKGROUND_LAUNCH_ARG\]\)/u,
  "updater verification must relaunch Vigil without activating it or opening a window"
);
assert.ok(
  updateScriptSource.indexOf("await openAndVerifyReplacement(")
    < updateScriptSource.indexOf("await run(\"git\", [\"merge\", \"--ff-only\", stagedBuild.expectedCommit]"),
  "the replacement must be healthy before the source checkout is fast-forwarded"
);
assert.ok(
  updateScriptSource.indexOf("launchAgentTransition = launchAgentWasPresent ? await stopLaunchAgentForStateTransition()")
    < updateScriptSource.indexOf("stateSnapshot = await snapshotUpdateState(")
    && updateScriptSource.indexOf("stateSnapshot = await snapshotUpdateState(")
      < updateScriptSource.indexOf("await startLaunchAgentAfterStateTransition(launchAgentTransition)"),
  "the updater must stop the old backend, preserve pre-migration state, and only then start the replacement backend"
);
const recoveryStopIndex = updateScriptSource.indexOf("stoppedLaunchAgent = await stopLaunchAgentForStateTransition()");
const stateRollbackIndex = updateScriptSource.indexOf("await stateSnapshot.rollback()", recoveryStopIndex);
const recoveryStartIndex = updateScriptSource.indexOf("startLaunchAgentAfterStateTransition(stoppedLaunchAgent)", stateRollbackIndex);
assert.ok(
  recoveryStopIndex >= 0 && stateRollbackIndex > recoveryStopIndex && recoveryStartIndex > stateRollbackIndex,
  "failed updates must stop the replacement backend, restore data, and only then restart the previous backend"
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
