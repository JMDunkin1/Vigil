import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_GUARDIAN_LABEL, SYSTEM_GUARDIAN_SAFETY_ARG, systemGuardianPlist, systemGuardianScript } from "../src/systemGuardian.js";
import { toPlist } from "../src/plist.js";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  beginGuardianMaintenance,
  guardianMaintenanceMarkerPath
} from "../src/updateMaintenance.js";

const sourceRoot = existsSync(join(process.cwd(), "scripts", "install-system-guardian.mts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const installerSource = await readFile(join(sourceRoot, "scripts", "install-system-guardian.mts"), "utf8");

const script = systemGuardianScript({
  appPath: "/Applications/Vigil.app",
  targetHome: "/Users/test-user",
  targetUid: 501,
  targetUser: "test-user"
});
assert.match(script, /VIGIL SAFETY BOUNDARY/u);
assert.match(script, /pgrep -U "\$target_uid"/u, "the root guardian must verify the app under the protected login account");
assert.match(script, /launchctl print "\$supervisor_service"/u, "the root guardian must detect an unloaded user supervisor even while Vigil remains alive");
assert.match(script, /sudo -H -u "\$target_user"[\s\S]*?HOME="\$target_home"[\s\S]*?PATH="\$target_home\/\.local\/bin:/u, "system relaunches must enter the GUI session with the protected user's home and tool path");
assert.match(script, /open -gn "\$app_path" --args --vigil-background/u, "the guardian must create a singleton repair launch in the GUI session");
assert.ok(script.includes(SYSTEM_GUARDIAN_SAFETY_ARG), "the guardian repair launch must expose the safety boundary in its process arguments");
assert.match(script, /now - offline_since >= 15/u, "the system backstop must leave a bounded transactional-update grace period");
assert.match(script, /guardian-maintenance\.json/u, "the system guardian must observe the updater's maintenance marker");
assert.match(script, /marker_token[\s\S]*?lock_token[\s\S]*?marker_pid[\s\S]*?lock_pid/u, "maintenance must be bound to the transferred updater lock token and pid");
assert.match(script, /stat -f '%u'[\s\S]*?stat -f '%Lp'/u, "maintenance files must have the protected user's ownership and private permissions");
assert.ok(script.includes(SYSTEM_GUARDIAN_AUTHORIZATION_PATH), "the user-owned request must be mediated by a grant in the root guardian directory");
assert.match(script, /stat -f '%u' "\$root_authorization_path"[\s\S]*?== "0"/u, "only a root-owned authorization may suppress guardian repair");
assert.match(script, /authorization_expires <= authorization_modified \+ 600/u, "the root-created suppression grant must remain time-bounded even if cleanup fails");
assert.match(script, /granted_token[\s\S]*?return 0[\s\S]*?ps -p "\$marker_pid" -o comm=/u, "an existing grant must not be refreshed from a rewritten user request");
assert.match(script, /ps -p "\$marker_pid" -o ppid=/u, "root authorization must bind the updater to its live parent");
assert.match(script, /ps -p "\$owner_ppid" -o comm=[\s\S]*?parent_executable" == "\$executable_path"/u, "root authorization must verify the parent from its kernel-reported executable path");
assert.match(script, /owner_executable" == "\$authorization_executable"/u, "active maintenance must remain bound to the updater executable root authorized");
assert.match(script, /owner_started" == "\$authorization_started"/u, "PID reuse must not inherit a prior updater authorization");
assert.match(script, /ps -p "\$marker_pid" -o uid=/u, "the guardian must verify that the lock owner is still a protected-user process");
assert.match(script, /--lock-path \$update_lock_path[\s\S]*?--lock-token \$marker_token/u, "the live updater command must authenticate the exact lock path and token");
assert.match(script, /maintenance_active" == false && "\$supervisor_loaded" == false/u, "authenticated maintenance must suppress supervisor repair during replacement and rollback");
assert.match(script, /maintenance_active" == false && "\$app_running" == false/u, "authenticated maintenance must suppress app reopen during replacement and rollback");

const plist = systemGuardianPlist();
assert.ok(plist.includes(`<string>${SYSTEM_GUARDIAN_LABEL}</string>`));
assert.ok(plist.includes(`<string>${SYSTEM_GUARDIAN_SAFETY_ARG}</string>`));
assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u);
assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);

const stagedScriptValidation = installerSource.indexOf('execFileAsync("/bin/zsh", ["-n", files[0].stagedPath]');
const stagedPlistValidation = installerSource.indexOf('execFileAsync("/usr/bin/plutil", ["-lint", files[1].stagedPath]');
const liveActivation = installerSource.indexOf("for (const file of files) await activateStagedFile(file)");
const guardianBootout = installerSource.indexOf("await bootoutSystemGuardianIfLoaded()", liveActivation);
assert.ok(
  stagedScriptValidation >= 0
    && stagedPlistValidation > stagedScriptValidation
    && liveActivation > stagedPlistValidation
    && guardianBootout > liveActivation,
  "guardian candidates must be fully staged and validated before the live files or launchd job are touched"
);
assert.match(installerSource, /rename\(file\.path, file\.backupPath\)[\s\S]*?file\.hadPrevious = true/u, "the installer must retain each prior root-owned file before replacement");
assert.match(installerSource, /for \(const file of \[\.\.\.files\]\.reverse\(\)\)[\s\S]*?restorePreviousFile\(file\)/u, "failed installation must restore both prior files in reverse activation order");
assert.match(installerSource, /files\[1\]\.hadPrevious[\s\S]*?bootstrapSystemGuardian\(\)/u, "failed replacement must re-bootstrap and health-check the restored guardian");

const markerRoot = await mkdtemp(join(tmpdir(), "vigil-guardian-maintenance-"));
try {
  const lockPath = join(markerRoot, "update.lock");
  const authorizationPath = join(markerRoot, "maintenance-authorization.plist");
  const token = "12345678-1234-1234-1234-123456789abc";
  await writeFile(lockPath, `${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  const startedAt = Date.now();
  await writeFile(authorizationPath, toPlist({
    kind: "vigil-root-maintenance-authorization-v2",
    token,
    pid: process.pid,
    lockPath,
    updaterExecutable: process.execPath,
    updaterStarted: new Date(startedAt).toUTCString(),
    expiresAtEpoch: Math.floor(startedAt / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
  }), { mode: 0o644 });
  const maintenance = await beginGuardianMaintenance(lockPath, token, process.pid, startedAt, {
    authorizationPath,
    expectedAuthorizationUid: process.getuid?.() ?? 0
  });
  const markerPath = guardianMaintenanceMarkerPath(lockPath);
  const payload = JSON.parse(await readFile(markerPath, "utf8")) as {
    expiresAtEpoch: number;
    kind: string;
    lockPath: string;
    pid: number;
    token: string;
  };
  assert.equal(payload.kind, "vigil-maintenance-request-v2");
  assert.equal(payload.lockPath, lockPath);
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.token, token);
  assert.equal(payload.expiresAtEpoch, Math.floor(startedAt / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS);
  assert.equal((await lstat(markerPath)).mode & 0o777, 0o600);
  await maintenance.release();
  assert.equal(existsSync(markerPath), false, "the transaction owner must remove its marker after verification or rollback");

  await chmod(lockPath, 0o644);
  await assert.rejects(
    beginGuardianMaintenance(lockPath, token, process.pid, Date.now(), { authorizationPath: null }),
    /permissions are too broad/u,
    "a same-user but non-private lock must not authenticate guardian suppression"
  );
  assert.equal(existsSync(markerPath), false, "failed authentication must not leave a suppressing marker");
} finally {
  await rm(markerRoot, { recursive: true, force: true });
}
