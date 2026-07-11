import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireUpdaterLock } from "../app/updater.js";
import { atomicInstallBuiltApp } from "../scripts/update-packaged-app.mjs";
import type { AtomicInstallOperations } from "../scripts/update-packaged-app.mjs";

const sourceRoot = existsSync(join(process.cwd(), "app", "updater.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const updateScriptSource = await readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8");

const preflightIndex = updaterSource.indexOf("await assertLocallyRebuildableApp(appPath)");
const quitIndex = updaterSource.indexOf("setTimeout(quitForUpdate");
assert.ok(preflightIndex >= 0 && quitIndex > preflightIndex, "signature preflight must finish before the app is told to quit");
assert.match(updaterSource, /let startInFlight: Promise<unknown> \| null = null/u);
assert.match(
  updaterSource,
  /plistStringForKey\(plist, "SentinelSourceRoot"\) \|\| plistStringForKey\(plist, "WorkingDirectory"\)/u,
  "updater discovery must retain a repository pointer when the agent runs from its installed runtime"
);
assert.match(updateScriptSource, /\["worktree", "add", "--detach"/u);
assert.match(updateScriptSource, /await openAndVerifyReplacement\(/u);
assert.match(updateScriptSource, /launchAgentRuntimePath\(\)/u);
assert.ok(
  updateScriptSource.indexOf("agentRuntimeInstallation = await atomicInstallBuiltApp(")
    < updateScriptSource.indexOf("const backend = launchAgentWasPresent ? await restartLaunchAgent()"),
  "the updater must replace the installed LaunchAgent runtime before restarting it"
);
assert.match(
  updateScriptSource,
  /run\("\/usr\/bin\/open", \["-g", options\.appPath, "--args", BACKGROUND_LAUNCH_ARG\]\)/u,
  "updater verification must relaunch Sentinel without activating it or opening a window"
);
assert.ok(
  updateScriptSource.indexOf("await openAndVerifyReplacement(")
    < updateScriptSource.indexOf("await run(\"git\", [\"merge\", \"--ff-only\", stagedBuild.expectedCommit]"),
  "the replacement must be healthy before the source checkout is fast-forwarded"
);

const lockRoot = await mkdtemp(join(tmpdir(), "sentinel-updater-lock-"));
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
await verifyOriginalSurvivesMoveFailure("replacement", (source) => source.endsWith(".sentinel-next"));

const symlinkRoot = await mkdtemp(join(tmpdir(), "sentinel-updater-symlinks-"));
try {
  const builtApp = join(symlinkRoot, "built", "Sentinel.app");
  const installedApp = join(symlinkRoot, "installed", "Sentinel.app");
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
  const root = await mkdtemp(join(tmpdir(), `sentinel-updater-${label}-failure-`));
  try {
    const builtApp = join(root, "built", "Sentinel.app");
    const installedApp = join(root, "installed", "Sentinel.app");
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
    assert.equal(existsSync(`${installedApp}.sentinel-previous`), false);
    assert.equal(existsSync(`${installedApp}.sentinel-next`), false);
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
