import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_GUARDIAN_LABEL, SYSTEM_GUARDIAN_SAFETY_ARG, systemGuardianPlist, systemGuardianScript } from "../src/systemGuardian.js";
import { toPlist } from "../src/plist.js";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  assertGuardianMaintenanceActive,
  beginGuardianMaintenance,
  guardianRecoveryManifestSha256,
  guardianMaintenanceReadiness,
  guardianMaintenanceMarkerPath,
  waitForGuardianRecoveryAuthorization
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
await assertValidZsh(script);
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
assert.ok(script.includes(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH), "durable recovery must be bound to separate root-owned attestation evidence");
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
assert.match(script, /attest_update_recovery_snapshot\(\)[\s\S]*?recoveryManifestSha256/u, "the live root-authorized updater must bind the immutable recovery manifest before activation");
assert.match(script, /bounded_root_copy\(\)[\s\S]*?ulimit -f 512[\s\S]*?cp -P "\$source_path" "\$destination_path"[\s\S]*?copy_deadline[\s\S]*?kill -TERM "\$copy_pid"[\s\S]*?kill -KILL "\$copy_pid"[\s\S]*?copied_size[\s\S]*?-le 262144/u,
  "every user-file snapshot must be non-dereferencing, size-bounded, and time-bounded");
assert.match(script, /attest_update_recovery\(\)[\s\S]*?bounded_root_copy "\$global_update_manifest_path" "\$manifest_snapshot"[\s\S]*?attest_update_recovery_snapshot "\$manifest_snapshot"/u,
  "attestation must pin the mutable manifest into one private root-owned snapshot");
assert.match(script, /attest_update_recovery_snapshot\(\)[\s\S]*?private_root_file "\$manifest_path" 600[\s\S]*?policy_sha=\$\(json_value "\$manifest_path" recovery\.policySha256\)[\s\S]*?app_identity_matches_manifest "\$app_path" initial "\$manifest_path"[\s\S]*?app_identity_matches_manifest "\$app_path\.vigil-next" target "\$manifest_path"[\s\S]*?normalized_recovery_manifest_sha256 "\$manifest_path"[\s\S]*?json_value "\$manifest_path" app\.initialDev[\s\S]*?json_value "\$manifest_path" app\.targetFingerprint/u,
  "root recovery attestation must verify both exact app generations before activation");
assert.match(script, /appInitialDev[\s\S]*?appInitialIno[\s\S]*?appInitialCommit[\s\S]*?appInitialFingerprint[\s\S]*?appTargetDev[\s\S]*?appTargetIno[\s\S]*?appTargetCommit[\s\S]*?appTargetFingerprint/u,
  "the root-owned recovery attestation must retain every available initial and target app identity proof");
const activeMaintenanceCheck = script.indexOf('if authenticated_maintenance_active "$now"; then');
const recoveryAttestationCall = script.indexOf("if ! attest_update_recovery; then", activeMaintenanceCheck);
assert.ok(activeMaintenanceCheck >= 0 && recoveryAttestationCall > activeMaintenanceCheck,
  "only the updater PID/executable/start identity already bound to Vigil by the root grant may request durable recovery attestation");
assert.match(script, /root_recovery_attestation_present\(\)[\s\S]*?stat -f '%u' "\$root_recovery_authorization_path"[\s\S]*?== "0"[\s\S]*?vigil-root-update-recovery-authorization-v2/u,
  "only the separate root-owned v2 app attestation may influence availability arbitration");
assert.match(script, /attested_canonical_app_generation\(\)[\s\S]*?root_recovery_attestation_present[\s\S]*?stat -f '%d'[\s\S]*?stat -f '%i'[\s\S]*?for generation in Initial Target[\s\S]*?app_content_matches/u,
  "availability fallback must accept only a canonical app matching one exact root-attested generation");
assert.doesNotMatch(
  script.slice(script.indexOf("root_recovery_attestation_present() {"), script.indexOf("authorize_maintenance_request() {")),
  /expiresAtEpoch|authorization_expires/u,
  "durable recovery attestation must survive maintenance-grant expiry and reboot"
);
assert.doesNotMatch(script, /recover_root_attested_update|recoveryRuntime\.nodePath|global_recovery_script_path/u,
  "the root guardian must never execute or parse the mutable same-user recovery runtime or policy");
assert.doesNotMatch(script, /json_value "\$global_update_(?:manifest|policy)_path"|sha256_file "\$global_update_policy_path"/u,
  "root availability arbitration must not directly read mutable recovery control files after attestation");
const rootRecoveryGate = script.indexOf('global_update_manifest_present && root_recovery_attestation_present');
const rootKnownGeneration = script.indexOf("attested_canonical_app_generation", rootRecoveryGate);
const rootReopenBranch = script.indexOf('if [[ "$recovery_waiting" == true ]]', rootKnownGeneration);
const rootReopen = script.indexOf("reopen_vigil", rootReopenBranch);
assert.ok(rootRecoveryGate >= 0 && rootKnownGeneration > rootRecoveryGate && rootReopenBranch > rootKnownGeneration && rootReopen > rootReopenBranch,
  "root app-generation arbitration must complete before any repair launch decision");
assert.match(script, /if \[\[ "\$recovery_waiting" == true \]\]; then[\s\S]*?: # Preserve exact attested evidence[\s\S]*?elif \[\[ "\$maintenance_active" == false/u,
  "unknown attested app generations must gate both root relaunch branches");
assert.match(script, /if \[\[ "\$maintenance_active" == false \]\] && global_update_manifest_present && root_recovery_attestation_present; then[\s\S]*?attested_canonical_app_generation \|\| recovery_waiting=true/u,
  "corrupt recovery inputs must permit repair for an exact attested canonical app but fail closed for an unknown bundle");
assert.match(script, /elif ! global_update_manifest_present; then[\s\S]*?clear_recovery_attestation[\s\S]*?recovery_waiting=false/u,
  "a stale root attestation without a transaction must be cleared before repair arbitration");

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
  const guardianScriptPath = join(markerRoot, "guardian.sh");
  const token = "12345678-1234-1234-1234-123456789abc";
  await writeFile(guardianScriptPath, "#!/bin/zsh\nwhile true; do sleep 2; done\n", { mode: 0o755 });
  assert.deepEqual(
    await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0),
    {
      ready: false,
      guardianInstalled: true,
      message: "Vigil's system guardian predates authenticated app updates. Refresh it through Vigil's protected maintenance setup before installing this update."
    },
    "an old guardian must block before the updater spends time rebuilding the app"
  );
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\nauthorize_maintenance_request() { :; }\nattest_update_recovery() { :; }\n# vigil-root-maintenance-authorization-v2\n# ${authorizationPath}\n`,
    { mode: 0o755 }
  );
  assert.equal(
    (await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0)).ready,
    false,
    "a guardian without root-attested canonical-app fallback must not authorize an update"
  );
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\nauthorize_maintenance_request() { :; }\nattest_update_recovery() { :; }\nattested_canonical_app_generation() { :; }\nbounded_root_copy() { :; }\n# vigil-root-maintenance-authorization-v2\n# vigil-root-update-recovery-authorization-v2\n# ${authorizationPath}\n`,
    { mode: 0o755 }
  );
  assert.equal(
    (await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0)).ready,
    true,
    "a guardian with the authenticated-maintenance protocol must pass the cheap updater preflight"
  );
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
  const authorizationOptions = {
    authorizationPath,
    recoveryAuthorizationPath: join(markerRoot, "update-recovery-authorization.plist"),
    authorizationTimeoutMs: 150,
    expectedAuthorizationUid: process.getuid?.() ?? 0
  };
  await assertGuardianMaintenanceActive(lockPath, token, process.pid, startedAt + 1_000, authorizationOptions);
  await assert.rejects(
    assertGuardianMaintenanceActive(lockPath, token, process.pid + 1, startedAt + 1_000, authorizationOptions),
    /lock ownership/u,
    "an unrelated signal sender cannot authorize the app's protected updater quit path"
  );
  const recoveryPolicySha256 = "a".repeat(64);
  const recoveryManifestPath = join(markerRoot, "update-recovery.json");
  await writeFile(recoveryManifestPath, `${JSON.stringify({
    version: 1,
    attemptId: token,
    state: "pending",
    source: { initialCommit: "1".repeat(40), targetCommit: "1".repeat(40), syncPending: false },
    immutableEvidence: "root-attested",
    timestamps: { startedAt: new Date(startedAt).toISOString() }
  })}\n`, { mode: 0o600 });
  const recoveryManifestSha256 = await guardianRecoveryManifestSha256(recoveryManifestPath);
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /did not attest update recovery/u,
    "same-user transaction files without separate root attestation must not authorize activation"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    kind: "vigil-root-update-recovery-authorization-v2",
    recoveryAttemptId: "forged-attempt",
    recoveryPolicySha256,
    recoveryManifestSha256
  }), { mode: 0o644 });
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a forged attestation for another manifest attempt must fail closed"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    kind: "vigil-root-update-recovery-authorization-v2",
    recoveryAttemptId: token,
    recoveryPolicySha256,
    recoveryManifestSha256: "b".repeat(64)
  }), { mode: 0o644 });
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a root file for a different immutable manifest must not authorize activation"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    kind: "vigil-root-update-recovery-authorization-v2",
    recoveryAttemptId: token,
    recoveryPolicySha256,
    recoveryManifestSha256
  }), { mode: 0o666 });
  await chmod(authorizationOptions.recoveryAuthorizationPath, 0o666);
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a writable same-user recovery attestation must not authorize canonical activation"
  );
  await chmod(authorizationOptions.recoveryAuthorizationPath, 0o644);
  await waitForGuardianRecoveryAuthorization(
    lockPath,
    token,
    recoveryPolicySha256,
    process.pid,
    authorizationOptions
  );
  await writeFile(authorizationPath, toPlist({
    kind: "vigil-root-maintenance-authorization-v2",
    token: "wrong-token",
    pid: process.pid,
    lockPath,
    updaterExecutable: process.execPath,
    updaterStarted: new Date(startedAt).toUTCString(),
    expiresAtEpoch: Math.floor(startedAt / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
  }), { mode: 0o644 });
  await assert.rejects(
    assertGuardianMaintenanceActive(lockPath, token, process.pid, startedAt + 1_000, authorizationOptions),
    /does not match this updater/u,
    "the app must not quit until the root guardian grant matches the exact updater"
  );
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

async function assertValidZsh(value: string): Promise<void> {
  await new Promise<void>((resolveSyntax, rejectSyntax) => {
    const child = spawn("/bin/zsh", ["-n"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectSyntax);
    child.once("close", (code) => code === 0
      ? resolveSyntax()
      : rejectSyntax(new Error(stderr.trim() || `zsh syntax validation exited with status ${code}`)));
    child.stdin.end(value);
  });
}
