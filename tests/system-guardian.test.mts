import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SYSTEM_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_PLIST_PATH as GENERATED_SYSTEM_GUARDIAN_PLIST_PATH,
  SYSTEM_GUARDIAN_SAFETY_ARG,
  SYSTEM_GUARDIAN_SCRIPT_PATH as GENERATED_SYSTEM_GUARDIAN_SCRIPT_PATH,
  systemGuardianPlist,
  systemGuardianScript
} from "../src/systemGuardian.js";
import { toPlist } from "../src/plist.js";
import {
  LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256,
  PREVIOUS_SYSTEM_GUARDIAN_PROGRAM_SHA256,
  SYSTEM_GUARDIAN_STABILITY_MS,
  observeGuardianRunningStability,
  predecessorAvailabilityProgramMatches,
  predecessorGuardianContentMatches,
  predecessorGuardianProgramFingerprint,
  predecessorLaunchctlTopologyMatches
} from "../scripts/install-system-guardian.mjs";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_LABEL as UPDATE_MAINTENANCE_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_PLIST_PATH,
  SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  SYSTEM_GUARDIAN_SCRIPT_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_LABEL,
  PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH,
  PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  LEGACY_SYSTEM_GUARDIAN_LABEL,
  LEGACY_SYSTEM_GUARDIAN_PLIST_PATH,
  LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH,
  SYSTEM_GUARDIAN_REVISION,
  SYSTEM_GUARDIAN_REVISION_MARKER,
  SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX,
  UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND,
  assertGuardianMaintenanceActive,
  beginGuardianMaintenance,
  bootstrapWorkerRequestPath,
  guardianScriptRevision,
  guardianRecoveryManifestSha256,
  guardianMaintenanceReadiness,
  guardianMaintenanceMarkerPath,
  guardianServiceAllowsParallelSetup,
  publishBootstrapWorkerAuthorizationRequest,
  waitForBootstrapWorkerAuthorization,
  waitForGuardianRecoveryAuthorization
} from "../src/updateMaintenance.js";

const sourceRoot = existsSync(join(process.cwd(), "scripts", "install-system-guardian.mts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const [installerSource, packagedUpdaterSource, localUpdaterSource, maintenanceSource, bridgePackagerSource] = await Promise.all([
  readFile(join(sourceRoot, "scripts", "install-system-guardian.mts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "launch-local-app.mts"), "utf8"),
  readFile(join(sourceRoot, "src", "updateMaintenance.ts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "package-update-protocol-bridge.mts"), "utf8")
]);

assert.equal(SYSTEM_GUARDIAN_LABEL, UPDATE_MAINTENANCE_GUARDIAN_LABEL,
  "the generator and readiness controller must agree on the parallel v4 label");
assert.equal(GENERATED_SYSTEM_GUARDIAN_SCRIPT_PATH, SYSTEM_GUARDIAN_SCRIPT_PATH,
  "the generator and readiness controller must agree on the parallel v4 script path");
assert.equal(GENERATED_SYSTEM_GUARDIAN_PLIST_PATH, SYSTEM_GUARDIAN_PLIST_PATH,
  "the generator and readiness controller must agree on the parallel v4 launchd path");
assert.ok(
  SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS >= 45_000,
  "the client wait must cover heavyweight root bridge attestation plus the stable-authorization window"
);
assert.match(bridgePackagerSource, /import \{ SYSTEM_GUARDIAN_LABEL \} from "\.\.\/src\/systemGuardian\.js"/u,
  "the signed bridge installer wrapper must use the canonical v4 service label");
assert.notEqual(SYSTEM_GUARDIAN_LABEL, PREVIOUS_SYSTEM_GUARDIAN_LABEL,
  "the v4 guardian must be added without replacing the loaded v3 guardian");
assert.notEqual(SYSTEM_GUARDIAN_LABEL, LEGACY_SYSTEM_GUARDIAN_LABEL,
  "parallel setup must use a distinct launchd label and leave the legacy job untouched");
assert.notEqual(SYSTEM_GUARDIAN_SCRIPT_PATH, PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH,
  "parallel v4 setup must never replace the loaded v3 guardian script");
assert.notEqual(SYSTEM_GUARDIAN_SCRIPT_PATH, LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH,
  "parallel setup must never replace the legacy guardian script");
assert.notEqual(SYSTEM_GUARDIAN_PLIST_PATH, PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH,
  "parallel v4 setup must never replace the loaded v3 launchd plist");
assert.notEqual(SYSTEM_GUARDIAN_PLIST_PATH, LEGACY_SYSTEM_GUARDIAN_PLIST_PATH,
  "parallel setup must never replace the legacy launchd plist");
assert.notEqual(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH, PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  "the v4 guardian must isolate recovery authorization from the loaded v3 guardian");
assert.notEqual(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH, LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  "the parallel guardian must use recovery authorization isolated from the legacy job");
assert.notEqual(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND, PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  "v4 recovery evidence must retain a distinct schema identity from v3");
assert.notEqual(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND, LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  "v4 recovery evidence must retain a distinct schema identity from the legacy guardian");
assert.notEqual(UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH, PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  "the v4 guardian must isolate its strict bootstrap claim from the loaded v3 writer");
assert.equal(guardianServiceAllowsParallelSetup({ loaded: true, running: false }, true), false,
  "a loaded-but-not-running v4 service must never be replaced or restarted by setup");
assert.equal(guardianServiceAllowsParallelSetup({ loaded: false, running: false }, true), true,
  "an absent v4 service may be added alongside an independently safe predecessor guardian");
assert.equal(guardianServiceAllowsParallelSetup({ loaded: false, running: false }, false), false,
  "an absent v4 service is insufficient without a safe guardian preserving availability during setup");
assert.match(maintenanceSource, /legacyGuardianSupportsParallelMigration[\s\S]*?inspectLiveGuardianService\(guardian\.label\)[\s\S]*?service\.loaded && service\.running/u,
  "parallel v4 setup must prove an exact predecessor guardian is still loaded and running");

const predecessorOptions = {
  appPath: "/Applications/Vigil.app",
  targetHome: "/Users/test-user",
  targetUid: 501,
  targetUser: "test-user"
};
const legacyPredecessorScript = `#!/bin/zsh
# VIGIL SAFETY BOUNDARY: keep enforcement online
set -u
target_uid=501
target_user='test-user'
target_home='/Users/test-user'
app_path='/Applications/Vigil.app'
executable_path='/Applications/Vigil.app/Contents/MacOS/Vigil'
process_pattern='^/Applications/Vigil\\.app/Contents/MacOS/Vigil($| )'
supervisor_service='gui/501/tech.caseline.vigil.supervisor'
update_lock_path='/Users/test-user/Library/Application Support/Vigil/updater/update.lock'
maintenance_marker_path='/Users/test-user/Library/Application Support/Vigil/updater/guardian-maintenance.json'
root_authorization_path='/Library/Application Support/Vigil/System Guardian/maintenance-authorization.plist'
root_recovery_authorization_path='${LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH}'
global_update_manifest_path='/Users/test-user/Library/Application Support/Vigil/updater/update-recovery.json'
global_update_policy_path='/Users/test-user/Library/Application Support/Vigil/updater/update-recovery-policy.json'
offline_since=0
# ${LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}
reopen_vigil() {
  /bin/launchctl asuser "$target_uid" /usr/bin/sudo -H -u "$target_user" /usr/bin/open -gn "$app_path" --args --vigil-background ${SYSTEM_GUARDIAN_SAFETY_ARG}
}
authorize_maintenance_request() {
  local now="$1"
  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$maintenance_marker_path")" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path")" == "$target_uid" ]] || return 1
  local marker_kind="$(json_value "$maintenance_marker_path" kind)"
  local marker_token="$(json_value "$maintenance_marker_path" token)"
  local marker_pid="$(json_value "$maintenance_marker_path" pid)"
  local marker_lock_path="$(json_value "$maintenance_marker_path" lockPath)"
  local marker_expires="$(json_value "$maintenance_marker_path" expiresAtEpoch)"
  local lock_token="$(json_value "$update_lock_path" token)"
  local lock_pid="$(json_value "$update_lock_path" pid)"
  [[ "$marker_kind" == "vigil-maintenance-request-v2" ]] || return 1
  [[ -n "$marker_token" && "$marker_token" == "$lock_token" ]] || return 1
  [[ "$marker_pid" == <-> && "$marker_pid" == "$lock_pid" ]] || return 1
  [[ "$marker_lock_path" == "$update_lock_path" ]] || return 1
  (( marker_expires >= now )) || return 1
  local owner_executable="$executable_path"
  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart=)"
  local authorization_tmp="${SYSTEM_GUARDIAN_AUTHORIZATION_PATH}.tmp.$$"
  /usr/bin/plutil -create xml1 "$authorization_tmp" || return 1
  /usr/bin/plutil -insert kind -string "vigil-root-maintenance-authorization-v2" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert token -string "$marker_token" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert pid -integer "$marker_pid" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert lockPath -string "$update_lock_path" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterExecutable -string "$owner_executable" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterStarted -string "$owner_started" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert expiresAtEpoch -integer "$marker_expires" "$authorization_tmp" || return 1
  /usr/sbin/chown 0:0 "$authorization_tmp" || return 1
  /bin/chmod 0644 "$authorization_tmp" || return 1
  /bin/mv -f "$authorization_tmp" "$root_authorization_path"
}
authenticated_maintenance_active() {
  local now="$1"
  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  [[ -f "$root_authorization_path" && ! -L "$root_authorization_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$maintenance_marker_path")" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path")" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$root_authorization_path")" == "0" ]] || return 1
  local marker_kind="$(json_value "$maintenance_marker_path" kind)"
  local marker_token="$(json_value "$maintenance_marker_path" token)"
  local marker_pid="$(json_value "$maintenance_marker_path" pid)"
  local marker_lock_path="$(json_value "$maintenance_marker_path" lockPath)"
  local marker_expires="$(json_value "$maintenance_marker_path" expiresAtEpoch)"
  local lock_token="$(json_value "$update_lock_path" token)"
  local lock_pid="$(json_value "$update_lock_path" pid)"
  local authorization_kind="$(json_value "$root_authorization_path" kind)"
  local authorization_token="$(json_value "$root_authorization_path" token)"
  local authorization_pid="$(json_value "$root_authorization_path" pid)"
  local authorization_lock_path="$(json_value "$root_authorization_path" lockPath)"
  local authorization_executable="$(json_value "$root_authorization_path" updaterExecutable)"
  local authorization_started="$(json_value "$root_authorization_path" updaterStarted)"
  local authorization_expires="$(json_value "$root_authorization_path" expiresAtEpoch)"
  [[ "$marker_kind" == "vigil-maintenance-request-v2" ]] || return 1
  [[ -n "$marker_token" && "$marker_token" == "$lock_token" ]] || return 1
  [[ "$marker_pid" == <-> && "$marker_pid" == "$lock_pid" ]] || return 1
  [[ "$marker_lock_path" == "$update_lock_path" ]] || return 1
  [[ "$authorization_kind" == "vigil-root-maintenance-authorization-v2" ]] || return 1
  [[ "$authorization_token" == "$marker_token" ]] || return 1
  [[ "$authorization_pid" == "$marker_pid" ]] || return 1
  [[ "$authorization_lock_path" == "$update_lock_path" ]] || return 1
  (( authorization_expires >= now )) || return 1
  local owner_uid="$(/bin/ps -p "$marker_pid" -o uid=)"
  local owner_executable="$(/bin/ps -p "$marker_pid" -o comm=)"
  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart=)"
  local owner_command="$(/bin/ps -p "$marker_pid" -o command=)"
  [[ "$owner_uid" == "$target_uid" ]] || return 1
  [[ "$owner_executable" == "$authorization_executable" ]] || return 1
  [[ "$owner_started" == "$authorization_started" ]] || return 1
  [[ "$owner_command" == *"--lock-path $update_lock_path"* ]] || return 1
  [[ "$owner_command" == *"--lock-token $marker_token"* ]] || return 1
  return 0
}
attest_update_recovery() {
  global_update_manifest_present || { clear_recovery_attestation; return $?; }
  private_target_file "$global_update_manifest_path" 600 || return 1
  local manifest_snapshot="/tmp/recovery-manifest.$$"
  bounded_root_copy "$global_update_manifest_path" "$manifest_snapshot" || return 1
  attest_update_recovery_snapshot "$manifest_snapshot"
  local attestation_status=$?
  /bin/rm -f "$manifest_snapshot"
  return "$attestation_status"
}
root_recovery_attestation_present() {
  [[ -f "$root_recovery_authorization_path" && ! -L "$root_recovery_authorization_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$root_recovery_authorization_path")" == "0" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$root_recovery_authorization_path")" == "644" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" kind)" == "${LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryManifestPath)" == "$global_update_manifest_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryPolicyPath)" == "$global_update_policy_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryAppPath)" == "$app_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialPresent)" == "true" ]]
}
attested_canonical_app_generation() {
  root_recovery_attestation_present || return 1
  [[ -e "$app_path" && ! -L "$app_path" ]] || return 1
  local observed_dev=$(/usr/bin/stat -f '%d' "$app_path")
  local observed_ino=$(/usr/bin/stat -f '%i' "$app_path")
  for generation in Initial Target; do
    local expected_dev=$(json_value "$root_recovery_authorization_path" "app\${generation}Dev")
    local expected_ino=$(json_value "$root_recovery_authorization_path" "app\${generation}Ino")
    [[ "$observed_dev" == "$expected_dev" && "$observed_ino" == "$expected_ino" ]] || continue
    local expected_commit=$(json_value "$root_recovery_authorization_path" "app\${generation}Commit")
    local expected_fingerprint=$(json_value "$root_recovery_authorization_path" "app\${generation}Fingerprint")
    app_content_matches "$app_path" "$expected_commit" "$expected_fingerprint" || continue
    return 0
  done
  return 1
}
while true; do
  now=$(/bin/date +%s)
  app_running=false
  supervisor_loaded=false
  if /usr/bin/pgrep -U "$target_uid" -f "$process_pattern" >/dev/null 2>&1; then
    app_running=true
    offline_since=0
  elif [[ "$offline_since" -eq 0 ]]; then
    offline_since="$now"
  fi
  if /bin/launchctl print "$supervisor_service" >/dev/null 2>&1; then
    supervisor_loaded=true
  fi
  authorize_maintenance_request "$now" >/dev/null 2>&1 || true
  maintenance_active=false
  if authenticated_maintenance_active "$now"; then
    maintenance_active=true
    offline_since=0
    if ! attest_update_recovery; then
      /usr/bin/printf '%s\n' "recovery pending" >&2
    fi
  elif ! global_update_manifest_present; then
    clear_recovery_attestation >/dev/null 2>&1 || true
  fi
  recovery_waiting=false
  if [[ "$maintenance_active" == false ]] && global_update_manifest_present && root_recovery_attestation_present; then
    attested_canonical_app_generation || recovery_waiting=true
  fi
  if [[ "$recovery_waiting" == true ]]; then
    : # Retry without reopening mid-swap.
  elif [[ "$maintenance_active" == false && "$supervisor_loaded" == false ]]; then
    reopen_vigil
  elif [[ "$maintenance_active" == false && "$app_running" == false ]] && (( now - offline_since >= 15 )); then
    reopen_vigil
    offline_since="$now"
  fi
  /bin/sleep 2
done
`;
const legacyPredecessorCandidate = {
  label: LEGACY_SYSTEM_GUARDIAN_LABEL,
  plistPath: LEGACY_SYSTEM_GUARDIAN_PLIST_PATH,
  scriptPath: LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH
};
const legacyPredecessorPlist = toPlist({
  Label: LEGACY_SYSTEM_GUARDIAN_LABEL,
  ProgramArguments: [LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH, SYSTEM_GUARDIAN_SAFETY_ARG],
  KeepAlive: true,
  RunAtLoad: true,
  ProcessType: "Background",
  ThrottleInterval: 5,
  StandardErrorPath: "/Library/Application Support/Vigil/System Guardian/guardian.log",
  StandardOutPath: "/Library/Application Support/Vigil/System Guardian/guardian.log"
});
const legacyLaunchctlOutput = `system/${LEGACY_SYSTEM_GUARDIAN_LABEL} = {
  path = ${LEGACY_SYSTEM_GUARDIAN_PLIST_PATH}
  type = LaunchDaemon
  state = running
  program = ${LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH}
  arguments = {
    ${LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH}
    ${SYSTEM_GUARDIAN_SAFETY_ARG}
  }
  stdout path = /Library/Application Support/Vigil/System Guardian/guardian.log
  stderr path = /Library/Application Support/Vigil/System Guardian/guardian.log
  default environment = {
    PATH => /usr/bin:/bin:/usr/sbin:/sbin
  }
  environment = {
    OSLogRateLimit => 64
    XPC_SERVICE_NAME => ${LEGACY_SYSTEM_GUARDIAN_LABEL}
  }
  domain = system
  minimum runtime = 5
  spawn type = background (5)
  pid = 123
  properties = keepalive | runatload | inferred program
}
`;
assert.equal(predecessorLaunchctlTopologyMatches(legacyLaunchctlOutput, legacyPredecessorCandidate), true,
  "an exact root LaunchDaemon topology must qualify as the live predecessor");
assert.equal(
  predecessorLaunchctlTopologyMatches(
    legacyLaunchctlOutput.replace(
      "properties = keepalive | runatload | inferred program",
      "properties = keepalive | runatload | inferred program | managed LWCR"
    ),
    legacyPredecessorCandidate
  ),
  true,
  "launchd-added guardian properties must not invalidate otherwise exact protected topology"
);
for (const weakenedTopology of [
  legacyLaunchctlOutput.replace("minimum runtime = 5", "minimum runtime = 3600"),
  legacyLaunchctlOutput.replace("domain = system", "username = test-user\n  domain = system"),
  legacyLaunchctlOutput.replace("OSLogRateLimit => 64", "ATTACKER_OVERRIDE => 1\n    OSLogRateLimit => 64"),
  legacyLaunchctlOutput.replace(
    "properties = keepalive | runatload | inferred program",
    "properties = runatload | inferred program | managed LWCR"
  )
]) {
  assert.equal(predecessorLaunchctlTopologyMatches(weakenedTopology, legacyPredecessorCandidate), false,
    "cached launchd semantics that differ from the exact root availability job must fail closed");
}
assert.equal(predecessorAvailabilityProgramMatches(legacyPredecessorScript), true,
  "the structural validator must recognize a materially enforcing predecessor loop");
assert.notEqual(
  predecessorGuardianProgramFingerprint(legacyPredecessorScript, false),
  LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256,
  "a structurally plausible imitation must not match the exact known legacy program"
);
assert.equal(
  predecessorGuardianContentMatches(
    legacyPredecessorScript,
    legacyPredecessorPlist,
    legacyPredecessorCandidate,
    predecessorOptions
  ),
  false,
  "parallel setup must require an exact known predecessor template, not only plausible control flow"
);
const localUser = userInfo();
const installedPredecessors = [
  {
    candidate: {
      label: PREVIOUS_SYSTEM_GUARDIAN_LABEL,
      plistPath: PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH,
      scriptPath: PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH
    },
    fingerprint: PREVIOUS_SYSTEM_GUARDIAN_PROGRAM_SHA256,
    previous: true
  },
  {
    candidate: legacyPredecessorCandidate,
    fingerprint: LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256,
    previous: false
  }
] as const;
for (const installed of installedPredecessors) {
  if (!existsSync(installed.candidate.scriptPath) || !existsSync(installed.candidate.plistPath)) continue;
  const installedScript = await readFile(installed.candidate.scriptPath, "utf8");
  const installedPlist = await readFile(installed.candidate.plistPath, "utf8");
  assert.equal(predecessorGuardianProgramFingerprint(installedScript, installed.previous), installed.fingerprint,
    "a locally installed known predecessor must match its pinned normalized template fingerprint");
  assert.equal(
    predecessorGuardianContentMatches(
      installedScript,
      installedPlist,
      installed.candidate,
      {
        appPath: "/Applications/Vigil.app",
        targetHome: localUser.homedir,
        targetUid: localUser.uid,
        targetUser: localUser.username
      }
    ),
    true,
    "the exact locally installed predecessor must remain eligible without being stopped or replaced"
  );
  assert.equal(
    predecessorGuardianContentMatches(
      installedScript,
      installedPlist.replace("</dict>", "<key>UserName</key><string>test-user</string></dict>"),
      installed.candidate,
      {
        appPath: "/Applications/Vigil.app",
        targetHome: localUser.homedir,
        targetUid: localUser.uid,
        targetUser: localUser.username
      }
    ),
    false,
    "an otherwise exact predecessor plist must reject a non-root UserName override"
  );
  assert.equal(
    predecessorGuardianContentMatches(
      installedScript,
      installedPlist.replace("<integer>5</integer>", "<integer>3600</integer>"),
      installed.candidate,
      {
        appPath: "/Applications/Vigil.app",
        targetHome: localUser.homedir,
        targetUid: localUser.uid,
        targetUser: localUser.username
      }
    ),
    false,
    "an otherwise exact predecessor plist must reject a weakened relaunch throttle"
  );
}
assert.equal(
  predecessorGuardianContentMatches(
    legacyPredecessorScript
      .replace(/while true; do[\s\S]*?done\n/u, "")
      .replace(/authorize_maintenance_request\(\) \{[\s\S]*?\n\}/u, "authorize_maintenance_request() { :;\n}"),
    legacyPredecessorPlist,
    legacyPredecessorCandidate,
    predecessorOptions
  ),
  false,
  "an inert marker-only predecessor must not authorize the privileged availability window"
);
for (const [description, inertScript] of [
  [
    "an unconditional maintenance success",
    legacyPredecessorScript.replace(
      "authenticated_maintenance_active() {\n",
      "authenticated_maintenance_active() {\n  return 0\n"
    )
  ],
  [
    "an early recovery-attestation failure",
    legacyPredecessorScript.replace(
      "root_recovery_attestation_present() {\n",
      "root_recovery_attestation_present() {\n  return 1\n"
    )
  ],
  [
    "a dead availability loop",
    legacyPredecessorScript.replace("while true; do\n", "while true; do\n  continue\n")
  ],
  [
    "a disabled reopen function",
    legacyPredecessorScript.replace("reopen_vigil() {\n", "reopen_vigil() {\n  return 1\n")
  ],
  [
    "a top-level successful return",
    legacyPredecessorScript.replace("set -u\n", "set -u\nreturn 0\n")
  ],
  [
    "a successful return at the head of the availability loop",
    legacyPredecessorScript.replace("while true; do\n", "while true; do\n  return 0\n")
  ],
  [
    "an arithmetic successful return before full maintenance validation",
    legacyPredecessorScript.replace(
      'authenticated_maintenance_active() {\n  local now="$1"\n  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1\n',
      'authenticated_maintenance_active() {\n  local now="$1"\n  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1\n  return "$((0))"\n'
    )
  ]
] as const) {
  assert.equal(
    predecessorAvailabilityProgramMatches(inertScript),
    false,
    `${description} must fail the executable control-flow validator`
  );
  assert.notEqual(predecessorGuardianProgramFingerprint(inertScript, false), LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256,
    `${description} must not match the pinned legacy program fingerprint`);
}
assert.equal(
  predecessorGuardianContentMatches(
    legacyPredecessorScript,
    legacyPredecessorPlist.replace("<true/>", "<false/>"),
    legacyPredecessorCandidate,
    predecessorOptions
  ),
  false,
  "a predecessor without KeepAlive must not authorize parallel installation"
);

const firstRunningObservation = observeGuardianRunningStability(
  { pid: null, since: 0 },
  { loaded: true, running: true, pid: 200 },
  100,
  1_000
);
assert.equal(firstRunningObservation.stable, false, "one instantaneous replacement PID must not pass guardian health verification");
assert.deepEqual(firstRunningObservation.state, { pid: 200, since: 1_000 });
assert.equal(observeGuardianRunningStability(
  firstRunningObservation.state,
  { loaded: true, running: true, pid: 200 },
  100,
  1_000 + SYSTEM_GUARDIAN_STABILITY_MS - 1
).stable, false, "the replacement guardian must remain stable for the full bounded window");
assert.equal(observeGuardianRunningStability(
  firstRunningObservation.state,
  { loaded: true, running: true, pid: 200 },
  100,
  1_000 + SYSTEM_GUARDIAN_STABILITY_MS
).stable, true, "the same running replacement PID may pass after the bounded stability window");
const changedPidObservation = observeGuardianRunningStability(
  firstRunningObservation.state,
  { loaded: true, running: true, pid: 201 },
  100,
  1_400
);
assert.deepEqual(changedPidObservation, {
  stable: false,
  state: { pid: 201, since: 1_400 }
}, "a second launchd PID must restart the stability window");
assert.deepEqual(observeGuardianRunningStability(
  changedPidObservation.state,
  { loaded: true, running: false, pid: 201 },
  100,
  1_500
), {
  stable: false,
  state: { pid: null, since: 0 }
}, "any non-running observation must reset continuity");
assert.equal(observeGuardianRunningStability(
  { pid: 100, since: 0 },
  { loaded: true, running: true, pid: 100 },
  100,
  10_000
).stable, false, "the pre-kickstart PID can never satisfy replacement health verification");

const script = systemGuardianScript({
  appPath: "/Applications/Vigil.app",
  targetHome: "/Users/test-user",
  targetUid: 501,
  targetUser: "test-user"
});
await assertValidZsh(script);
assert.equal(script.split("\n")[1], SYSTEM_GUARDIAN_REVISION_MARKER,
  "every generated guardian must carry its exact monotonic revision immediately after the shebang");
assert.equal(guardianScriptRevision(script), SYSTEM_GUARDIAN_REVISION);
assert.ok(script.includes(`# ${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}`),
  "the current guardian revision must declare its exact recovery-authorization protocol");
const oldControllerReadinessPredicate = (candidate: string): boolean => candidate.includes("authorize_maintenance_request()")
  && candidate.includes("vigil-root-maintenance-authorization-v2")
  && candidate.includes("attest_update_recovery()")
  && candidate.includes("attested_canonical_app_generation()")
  && candidate.includes("bounded_root_copy()")
  && candidate.includes("vigil-root-update-recovery-authorization-v2")
  && candidate.includes(SYSTEM_GUARDIAN_AUTHORIZATION_PATH);
assert.equal(oldControllerReadinessPredicate(script), true,
  "a controller already loaded with the v2 readiness predicate must accept the hot-installed v4 guardian");
assert.match(script, /READINESS-ONLY COMPATIBILITY MARKER[\s\S]*?vigil-root-update-recovery-authorization-v2/u,
  "the retired v2 literal must remain visibly scoped to readiness compatibility only");
const recoveryAttestationFunction = shellFunction(script, "attest_update_recovery_snapshot");
assert.match(recoveryAttestationFunction, /pending_manifest_sha=\$\(sha256_file "\$manifest_path"\)/u,
  "root recovery authorization must hash the exact pinned pending-manifest bytes");
assert.doesNotMatch(script, /normalized_recovery_manifest_sha256|plutil -convert (?:binary1|xml1)/u,
  "recovery authorization must never depend on cross-process plist reserialization");
assert.equal(guardianScriptRevision(`${SYSTEM_GUARDIAN_REVISION_MARKER}\n${SYSTEM_GUARDIAN_REVISION_MARKER}\n`), null,
  "duplicate revision claims must fail closed");
assert.equal(guardianScriptRevision(`${SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX}not-a-number\n`), null,
  "malformed revision claims must fail closed");
assert.equal(
  guardianScriptRevision(`${SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX}${SYSTEM_GUARDIAN_REVISION + 1}\n`),
  SYSTEM_GUARDIAN_REVISION + 1,
  "a newer safe guardian revision must not be downgraded by an older app"
);
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
assert.match(script, /granted_token[\s\S]*?authenticated_maintenance_active "\$now" && return 0[\s\S]*?legacy_maintenance_authorization_expires[\s\S]*?ps -p "\$marker_pid" -o comm=/u,
  "a complete grant must remain one-shot while an exact sparse predecessor grant is revalidated before upgrade");
assert.match(shellFunction(script, "legacy_maintenance_authorization_expires"), /for current_key in authorizationMode[\s\S]*?\[\[ -z[\s\S]*?expires <= modified \+ 600/u,
  "v4 must upgrade only the sparse legacy schema within its original root-created deadline");
assert.match(shellFunction(script, "authorize_maintenance_request"), /legacy_grant_expires < bootstrap_grant_expires[\s\S]*?legacy_grant_expires < normal_grant_expires/u,
  "both bootstrap and normal upgrades must retain the predecessor grant's one-shot expiry");
assert.match(maintenanceSource, /stableIdentity[\s\S]*?SYSTEM_GUARDIAN_AUTHORIZATION_STABILITY_MS[\s\S]*?readPinnedGuardianAuthorization/u,
  "userland must observe one pinned full authorization generation across a guardian polling interval");
assert.match(
  maintenanceSource,
  /readPinnedGuardianAuthorization[\s\S]*?handle\.readFile\(\)[\s\S]*?Promise\.all\(\[handle\.stat\(\), lstat\(path\)\]\)[\s\S]*?after\.ino !== pathname\.ino[\s\S]*?after\.mtimeMs !== pathname\.mtimeMs/u,
  "a stable open authorization inode must still be the exact safe generation reachable through the live pathname"
);
assert.match(
  maintenanceSource,
  /recoveryAuthorizationRequirements[\s\S]*?inspectLiveGuardianService\(predecessor\.label\)[\s\S]*?launchctlOutputFieldMatches\(service\.output, "path"[\s\S]*?requirements\.push/u,
  "activation must discover every still-loaded predecessor through its exact live launchd topology"
);
assert.match(
  maintenanceSource,
  /Promise\.all\(requirements\.map[\s\S]*?assertGuardianRecoveryAttestation/u,
  "activation must wait for all current and predecessor recovery attestations as one barrier"
);
assert.match(script, /ps -p "\$marker_pid" -o ppid=/u, "root authorization must bind the updater to its live parent");
assert.match(script, /unique_exact_main_pid\(\)[\s\S]*?pgrep -U "\$target_uid" -f "\$process_pattern"[\s\S]*?candidate_command" == "\$exact_main_command" \|\| "\$candidate_command" == "\$canonical_main_command"[\s\S]*?matching_count" == "1"/u,
  "normal authorization must require one and only one exact canonical or background Vigil main process");
assert.match(script, /main_command_for_pid\(\)[\s\S]*?main_command" == "\$exact_main_command" \|\| "\$main_command" == "\$canonical_main_command"/u,
  "normal authorization must accept the ordinary canonical launch without accepting script-bearing launcher commands");
assert.match(script, /owner_ppid" == "\$main_pid"[\s\S]*?main_command_for_pid "\$main_pid"[\s\S]*?process_identity_matches "\$main_pid"[\s\S]*?"\$parent_command"[\s\S]*?unique_exact_main_pid/u,
  "normal authorization must bracket the updater's direct parent with exact PID/start/executable/command and uniqueness checks");
assert.match(script, /normal_updater_script_for_command\(\)[\s\S]*?packaged_updater_script_path[\s\S]*?local_updater_script_path/u,
  "normal authorization must accept only the two fixed signed updater wrapper paths");
assert.match(script, /verified_signed_script_hash\(\)[\s\S]*?verified_code_directory_hash[\s\S]*?sha256_file[\s\S]*?verified_code_directory_hash/u,
  "the exact updater wrapper must be hash-pinned between stable full-bundle signature checks");
assert.match(script, /write_maintenance_authorization\(\)[\s\S]*?updaterCommand[\s\S]*?parentPid[\s\S]*?parentStarted[\s\S]*?parentCommand/u,
  "the root grant must retain the exact updater and parent process identities it observed");
assert.match(script, /owner_executable" == "\$authorization_executable"/u, "active maintenance must remain bound to the updater executable root authorized");
assert.match(script, /owner_started" == "\$authorization_started"/u, "PID reuse must not inherit a prior updater authorization");
assert.match(script, /owner_command" == "\$authorization_command"/u, "argv substitution must not inherit a prior updater authorization");
assert.match(script, /ps -p "\$marker_pid" -o uid=/u, "the guardian must verify that the lock owner is still a protected-user process");
assert.match(script, /--lock-path \$update_lock_path[\s\S]*?--lock-token \$marker_token/u, "the live updater command must authenticate the exact lock path and token");
assert.match(script, /attest_bootstrap_worker_request "\$now"[\s\S]*?authorize_maintenance_request "\$now"/u,
  "the root guardian must claim the exact bootstrap worker before setup may transfer the updater lock");
assert.ok(script.includes(PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH),
  "v4 must retain a distinct compatibility claim for the still-running v3 guardian");
assert.match(
  shellFunction(script, "attest_bootstrap_worker_request"),
  /ensure_bootstrap_claim_at_path "\$previous_bootstrap_claim_path"[\s\S]*?ensure_bootstrap_claim_at_path "\$bootstrap_claim_path"[\s\S]*?previous_bootstrap_claim_matches[\s\S]*?bootstrap_claim_matches/u,
  "the historical claim must be atomically verified before the isolated v4 go-signal"
);
assert.match(
  shellFunction(script, "ensure_bootstrap_claim_at_path"),
  /bootstrap_claim_matches_at_path[\s\S]*?bootstrap_claim_path_is_replaceable[\s\S]*?write_bootstrap_claim_at_path[\s\S]*?bootstrap_claim_matches_at_path/u,
  "an exact same-token claim must be reused while a mismatch fails closed before atomic replacement"
);
assert.match(
  shellFunction(script, "authorize_maintenance_request"),
  /previous_bootstrap_claim_matches[\s\S]*?bootstrap_claim_matches[\s\S]*?previous_bootstrap_claim_expires[\s\S]*?previous_bootstrap_claim_expires < bootstrap_grant_expires/u,
  "the shared bootstrap grant must require both claims and retain the shorter compatibility deadline"
);
assert.match(
  shellFunction(script, "authenticated_maintenance_active"),
  /for active_claim_path in "\$previous_bootstrap_claim_path" "\$bootstrap_claim_path"[\s\S]*?private_root_file "\$active_claim_path" 644/u,
  "v4 must keep both the predecessor and current claim active throughout bootstrap maintenance"
);
assert.match(script, /bootstrap_processes_match_request\(\)[\s\S]*?expected_worker_command[\s\S]*?expected_relay_command[\s\S]*?worker_ppid" == "\$request_relay_pid"/u,
  "bootstrap authorization must independently match exact relay and worker commands and parentage");
assert.match(script, /validate_bootstrap_authorization\(\)[\s\S]*?bridgeManifestSha256[\s\S]*?bridgeEquivalentTreeSha256[\s\S]*?bridgePayloadTreeSha256[\s\S]*?bridgeWrappersSha256[\s\S]*?bridgeBaselineBuildInfoSha256/u,
  "root bootstrap authorization must retain every privileged A-equivalence proof");
assert.match(script, /bridge-equivalence-v1\.json[\s\S]*?sha256_file "\$bridge_manifest"[\s\S]*?payloadRoot[\s\S]*?VigilUpdater\/v3\/\$bridge_payload_tree_sha/u,
  "the root guardian must bind the signed bridge manifest to its exact digest-addressed payload directory");
assert.match(script, /bootstrapToken\)" != "\$request_bootstrap_token"/u,
  "a second relay or worker under the same one-shot bootstrap token must fail closed");
assert.match(script, /maintenance_active" == false && "\$supervisor_loaded" == false/u, "authenticated maintenance must suppress supervisor repair during replacement and rollback");
assert.match(script, /maintenance_active" == false && "\$app_running" == false/u, "authenticated maintenance must suppress app reopen during replacement and rollback");
assert.match(script, /attest_update_recovery_snapshot\(\)[\s\S]*?recoveryPendingManifestSha256/u, "the live root-authorized updater must bind the exact pending recovery manifest before activation");
assert.match(script, /bounded_root_copy\(\)[\s\S]*?ulimit -f 512[\s\S]*?cp -P "\$source_path" "\$destination_path"[\s\S]*?copy_deadline[\s\S]*?kill -TERM "\$copy_pid"[\s\S]*?kill -KILL "\$copy_pid"[\s\S]*?copied_size[\s\S]*?-le 262144/u,
  "every user-file snapshot must be non-dereferencing, size-bounded, and time-bounded");
assert.match(script, /attest_update_recovery\(\)[\s\S]*?bounded_root_copy "\$global_update_manifest_path" "\$manifest_snapshot"[\s\S]*?attest_update_recovery_snapshot "\$manifest_snapshot"/u,
  "attestation must pin the mutable manifest into one private root-owned snapshot");
assert.match(script, /attest_update_recovery_snapshot\(\)[\s\S]*?private_root_file "\$manifest_path" 600[\s\S]*?policy_sha=\$\(json_value "\$manifest_path" recovery\.policySha256\)[\s\S]*?app_identity_matches_manifest "\$app_path" initial "\$manifest_path"[\s\S]*?app_identity_matches_manifest "\$app_path\.vigil-next" target "\$manifest_path"[\s\S]*?pending_manifest_sha=\$\(sha256_file "\$manifest_path"\)[\s\S]*?json_value "\$manifest_path" app\.initialDev[\s\S]*?json_value "\$manifest_path" app\.targetFingerprint/u,
  "root recovery attestation must verify both exact app generations before activation");
const existingAttestationStart = recoveryAttestationFunction.indexOf('if [[ -n "$existing_attempt" ]]; then', recoveryAttestationFunction.indexOf('if [[ -n "$existing_attempt" ]]; then') + 1);
const firstAttestationStart = recoveryAttestationFunction.indexOf('[[ "$(json_value "$manifest_path" state)" == "pending" ]]');
const existingAttestationBranch = recoveryAttestationFunction.slice(existingAttestationStart, firstAttestationStart);
assert.match(existingAttestationBranch, /recoveryPolicySha256[\s\S]*?recoveryPendingManifestSha256[\s\S]*?attested_app_fields_match_manifest/u,
  "later guardian loops must revalidate the same policy and explicit app generations from the root attestation");
assert.doesNotMatch(existingAttestationBranch, /sha256_file "\$manifest_path"/u,
  "legitimate post-activation manifest state changes must not invalidate the pinned pending-manifest handshake");
assert.match(script, /appInitialDev[\s\S]*?appInitialIno[\s\S]*?appInitialCommit[\s\S]*?appInitialFingerprint[\s\S]*?appTargetDev[\s\S]*?appTargetIno[\s\S]*?appTargetCommit[\s\S]*?appTargetFingerprint/u,
  "the root-owned recovery attestation must retain every available initial and target app identity proof");
const activeMaintenanceCheck = script.indexOf('if authenticated_maintenance_active "$now"; then');
const recoveryAttestationCall = script.indexOf("if ! attest_update_recovery; then", activeMaintenanceCheck);
assert.ok(activeMaintenanceCheck >= 0 && recoveryAttestationCall > activeMaintenanceCheck,
  "only the updater PID/executable/start identity already bound to Vigil by the root grant may request durable recovery attestation");
assert.match(script, new RegExp(`root_recovery_attestation_present\\(\\)[\\s\\S]*?stat -f '%u' "\\$root_recovery_authorization_path"[\\s\\S]*?== "0"[\\s\\S]*?${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}`, "u"),
  "only the separate root-owned v4 app attestation may influence availability arbitration");
assert.match(script, /attested_canonical_app_generation\(\)[\s\S]*?root_recovery_attestation_present[\s\S]*?stat -f '%d'[\s\S]*?stat -f '%i'[\s\S]*?for generation in Initial Target[\s\S]*?app_content_matches/u,
  "availability fallback must accept only a canonical app matching one exact root-attested generation");
assert.match(script, /app_content_matches\(\)[\s\S]*?\[\[ -n "\$expected_commit" \|\| -n "\$expected_fingerprint" \]\] \|\| return 1/u,
  "a directory inode without packaged build identity must never become root availability evidence");
assert.match(
  script,
  /verified_code_directory_hash\(\)[\s\S]*?codesign --verify --deep --strict[\s\S]*?CDHash=[\s\S]*?codesign --verify --deep --strict[\s\S]*?confirmed_cdhash" == "\$cdhash"/u,
  "root must bracket CodeDirectory capture with full signature verification and require a stable exact hash"
);
assert.match(
  script,
  /verified_code_directory_hash\(\)[\s\S]*?before_dev[\s\S]*?before_ino[\s\S]*?expected_dev[\s\S]*?expected_ino[\s\S]*?codesign --verify[\s\S]*?stat -f '%d'[\s\S]*?before_dev[\s\S]*?stat -f '%i'[\s\S]*?before_ino/u,
  "root must pin the exact attested directory generation across signature and CodeDirectory inspection"
);
assert.match(
  script,
  /app_content_matches\(\)[\s\S]*?expected_cdhash[\s\S]*?verified_code_directory_hash "\$artifact_path"[\s\S]*?== "\$expected_cdhash"/u,
  "availability recovery must recompute the signed bundle hash rather than trusting mutable build metadata"
);
assert.match(script, /appInitialCdHash[\s\S]*?appTargetCdHash/u,
  "the root-owned recovery authorization must retain both exact signed bundle hashes");
for (const [label, source] of [["packaged", packagedUpdaterSource], ["local", localUpdaterSource]] as const) {
  assert.match(source, /verifiedAppCodeDirectoryHash[\s\S]*?initialCdHash[\s\S]*?targetCdHash/u,
    `${label} updater must capture both exact signed app hashes before manifest publication`);
  assert.match(source, /waitForGuardianRecoveryAuthorization\([\s\S]*?expectedAppInitialCdHash[\s\S]*?expectedAppTargetCdHash/u,
    `${label} updater must compare root attestation with its in-memory signed hashes before activation`);
  assert.match(source, /assert[A-Za-z]*CodeDirectoryHashes\([^,]+, false\)[\s\S]*?activateStagedUpdateArtifact[\s\S]*?assert[A-Za-z]*CodeDirectoryHashes\([^,]+, true\)/u,
    `${label} updater must bracket activation with exact signed-generation verification`);
}
assert.doesNotMatch(
  shellFunction(script, "root_recovery_attestation_present"),
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

const projectionRoot = await mkdtemp(join(tmpdir(), "vigil-guardian-pending-manifest-"));
try {
  const projectionManifestPath = join(projectionRoot, "update-recovery.json");
  await writeFile(projectionManifestPath, `${JSON.stringify({
    version: 1,
    attemptId: "91f29d88-3f1b-4d95-8a15-509fa068577a",
    state: "pending",
    source: {
      initialCommit: "a".repeat(40),
      initialBranch: null,
      targetCommit: "b".repeat(40),
      syncPending: false
    },
    app: {
      targetPath: "/Applications/Vigil.app",
      nextPath: "/Applications/Vigil.app.vigil-next",
      previousPath: "/Applications/Vigil.app.vigil-previous",
      journalPath: "/Applications/.Vigil.app.vigil-update-journal.json",
      initialPresent: true,
      initialCommit: "a".repeat(40),
      initialFingerprint: "c".repeat(64),
      initialCdHash: "1".repeat(40),
      initialDev: 16_777_234,
      initialIno: 10_845_749,
      targetCommit: "b".repeat(40),
      targetFingerprint: "d".repeat(64),
      targetCdHash: "2".repeat(40),
      targetDev: 16_777_234,
      targetIno: 10_900_001
    },
    runtimes: [{
      targetPath: "/tmp/runtime",
      nextPath: "/tmp/runtime.vigil-next",
      previousPath: "/tmp/runtime.vigil-previous",
      journalPath: "/tmp/.runtime.vigil-update-journal.json",
      initialPresent: false,
      initialCommit: null,
      initialFingerprint: null,
      initialDev: null,
      initialIno: null,
      targetCommit: "b".repeat(40),
      targetFingerprint: "e".repeat(64),
      targetDev: 16_777_234,
      targetIno: 10_900_002
    }],
    stateSnapshot: {
      dataDir: "/tmp/data",
      root: "/tmp/state-before-update",
      manifestPath: "/tmp/state-before-update/state-rollback-wal.json"
    },
    recovery: {
      policyPath: "/tmp/update-recovery-policy.json",
      policySha256: "f".repeat(64),
      bundleRoot: "/tmp/recovery-runtime",
      nodePath: "/usr/local/bin/node",
      gitPath: "/usr/bin/git",
      packagePath: "/tmp/recovery-runtime/package.json",
      scriptPath: "/tmp/recovery-runtime/recover.mjs",
      modulePath: "/tmp/recovery-runtime/updateTransaction.js",
      helperPath: "/tmp/recovery-runtime/vigil-atomic-swap"
    },
    timestamps: {
      startedAt: "2026-07-22T22:11:05.928Z",
      updatedAt: "2026-07-22T22:11:05.928Z",
      commitIntentAt: null,
      committedAt: null
    }
  }, null, 2)}\n`, { mode: 0o600 });

  const originalManifestBytes = await readFile(projectionManifestPath);
  const expectedDigest = createHash("sha256").update(originalManifestBytes).digest("hex");
  const nodeDigests: string[] = [];
  const guardianDigests: string[] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    nodeDigests.push(await guardianRecoveryManifestSha256(projectionManifestPath));
    guardianDigests.push(await guardianShellFileDigest(script, projectionManifestPath));
  }
  assert.deepEqual(nodeDigests, Array(8).fill(expectedDigest),
    "the updater must attest the exact owned pending-manifest bytes without reserialization");
  assert.deepEqual(guardianDigests, nodeDigests,
    "the updater and generated zsh guardian must hash the exact same pending-manifest bytes");

  await writeFile(
    projectionManifestPath,
    Buffer.from(originalManifestBytes.toString("utf8").replace('"state": "pending"', '"state": "commit-intent"')),
    { mode: 0o600 }
  );
  assert.notEqual(await guardianRecoveryManifestSha256(projectionManifestPath), expectedDigest,
    "a legitimate later state transition must change the raw pending-manifest digest rather than silently normalize it");
  await chmod(projectionManifestPath, 0o644);
  await assert.rejects(
    guardianRecoveryManifestSha256(projectionManifestPath),
    /unsafe for root attestation/u,
    "the updater must refuse to hash a pending manifest writable by another account"
  );
} finally {
  await rm(projectionRoot, { recursive: true, force: true });
}

const plist = systemGuardianPlist();
assert.ok(plist.includes(`<string>${SYSTEM_GUARDIAN_LABEL}</string>`));
assert.ok(plist.includes(`<string>${SYSTEM_GUARDIAN_SAFETY_ARG}</string>`));
assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u);
assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);

const bootstrapClaimRoot = await mkdtemp(join(tmpdir(), "vigil-bootstrap-worker-claim-"));
try {
  const lockPath = join(bootstrapClaimRoot, "update.lock");
  const claimPath = join(bootstrapClaimRoot, "bootstrap-worker-claim.plist");
  const previousClaimPath = join(bootstrapClaimRoot, "bootstrap-worker-claim-previous.plist");
  const now = Date.now();
  const request = {
    bootstrapToken: "12345678-1234-4123-8123-123456789abc",
    lockPath,
    lockToken: "bootstrap-lock-token",
    sourceAppPath: "/private/tmp/Vigil-Bridge.app",
    targetAppPath: "/Applications/Vigil.app",
    expectedUpdateCommit: "a".repeat(40),
    workerPid: 901,
    relayPid: 900
  };
  const workerRequest = await publishBootstrapWorkerAuthorizationRequest(request, now);
  assert.equal(workerRequest.requestPath, bootstrapWorkerRequestPath(lockPath));
  const exactClaim = toPlist({
    kind: UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND,
    bootstrapToken: request.bootstrapToken,
    lockPath: request.lockPath,
    lockToken: request.lockToken,
    sourceAppPath: request.sourceAppPath,
    targetAppPath: request.targetAppPath,
    expectedUpdateCommit: request.expectedUpdateCommit,
    workerPid: request.workerPid,
    relayPid: request.relayPid,
    workerStarted: "Wed Jul 22 18:00:00 2026",
    workerCommand: "exact signed bootstrap worker command",
    relayStarted: "Wed Jul 22 17:59:59 2026",
    relayCommand: "exact installed relay command",
    bootstrapAuthorizationSha256: "b".repeat(64),
    expiresAtEpoch: Math.floor(now / 1_000) + 30
  });
  await writeFile(claimPath, exactClaim, { mode: 0o644 });
  await waitForBootstrapWorkerAuthorization(
    request,
    25,
    process.getuid?.() ?? 0,
    claimPath
  );
  await assert.rejects(
    waitForBootstrapWorkerAuthorization(
      request,
      25,
      process.getuid?.() ?? 0,
      previousClaimPath
    ),
    /did not attest the bootstrap worker/u,
    "the isolated v4 claim alone must not prove compatibility with the still-running predecessor"
  );
  await writeFile(previousClaimPath, exactClaim, { mode: 0o644 });
  await Promise.all([
    waitForBootstrapWorkerAuthorization(request, 25, process.getuid?.() ?? 0, previousClaimPath),
    waitForBootstrapWorkerAuthorization(request, 25, process.getuid?.() ?? 0, claimPath)
  ]);
  await assert.rejects(
    waitForBootstrapWorkerAuthorization(
      { ...request, relayPid: request.relayPid + 2 },
      25,
      process.getuid?.() ?? 0,
      claimPath
    ),
    /did not attest the bootstrap worker/u,
    "a root claim for one exact relay/worker pair must reject a second matching-looking parent"
  );
  await workerRequest.release();
  assert.equal(existsSync(workerRequest.requestPath), false,
    "the exact bridge worker must remove its short-lived user request on completion");
} finally {
  await rm(bootstrapClaimRoot, { recursive: true, force: true });
}

const stagedScriptValidation = installerSource.indexOf('execFileAsync("/bin/zsh", ["-n", files[0].stagedPath]');
const stagedPlistValidation = installerSource.indexOf('execFileAsync("/usr/bin/plutil", ["-lint", files[1].stagedPath]');
const predecessorCapture = installerSource.indexOf("await runningPredecessorGuardian(options)");
const predecessorBeforeActivation = installerSource.indexOf(
  "await assertPredecessorGuardianContinuity(predecessor, options)",
  predecessorCapture
);
const liveActivation = installerSource.indexOf("for (const file of files) await activateStagedFile(file)");
const parallelBootstrap = installerSource.indexOf("await bootstrapSystemGuardian()", liveActivation);
const predecessorAfterBootstrap = installerSource.indexOf(
  "await assertPredecessorGuardianContinuity(predecessor, options)",
  predecessorBeforeActivation + 1
);
assert.ok(
  stagedScriptValidation >= 0
    && stagedPlistValidation > stagedScriptValidation
    && liveActivation > stagedPlistValidation
    && parallelBootstrap > liveActivation,
  "parallel guardian candidates must be fully staged and validated before their new files or launchd job are touched"
);
assert.ok(
  predecessorCapture >= 0
    && predecessorBeforeActivation > predecessorCapture
    && predecessorBeforeActivation < liveActivation
    && predecessorAfterBootstrap > parallelBootstrap,
  "the privileged helper must pin one exact predecessor and recheck the same identity before activation and after v4 is stable"
);
assert.match(installerSource, /runningPredecessorGuardian[\s\S]*?refused to add its parallel v4 guardian without one exact, safe predecessor/u,
  "the privileged helper must fail closed when no exact predecessor preserves availability");
assert.match(installerSource, /inspectPredecessorGuardian[\s\S]*?predecessorProcessIdentity\(service\.pid, candidate\)[\s\S]*?predecessorLaunchctlTopologyMatches\(service\.output, candidate\)/u,
  "predecessor continuity must bind the complete cached launchd topology and root process identity");
assert.match(installerSource, /predecessorProcessIdentity[\s\S]*?"uid="[\s\S]*?"gid="[\s\S]*?"ppid="[\s\S]*?"comm="[\s\S]*?"command="[\s\S]*?"lstart="[\s\S]*?\["0", "0", "1", "\/bin\/zsh", expectedCommand\]/u,
  "the live predecessor must be the exact root-owned zsh process launched directly by launchd with a pinned start identity");
assert.match(installerSource, /rootOwnedFilePredatesProcess\(scriptFile\.identity, processBefore\)[\s\S]*?rootOwnedFilePredatesProcess\(plistFile\.identity, processBefore\)[\s\S]*?processAfter\.started !== processBefore\.started/u,
  "the exact root-owned script and plist must predate the same live process generation before and after their pinned reads");
assert.match(installerSource, /confirmedService = await inspectSystemGuardianService\(candidate\.label\)[\s\S]*?confirmedService\.pid !== service\.pid/u,
  "predecessor service continuity must bracket validation of its root-owned files");
assert.match(installerSource, /readPinnedRootOwnedFile\(candidate\.scriptPath, 1024 \* 1024, 0o755\)[\s\S]*?readPinnedRootOwnedFile\(candidate\.plistPath, 1024 \* 1024, 0o644\)/u,
  "a predecessor must retain executable script permissions and an immutable launchd configuration");
assert.match(installerSource, /link\(file\.path, file\.backupPath\)[\s\S]*?backupStat\.ino !== previousStat\.ino[\s\S]*?file\.hadPrevious = true/u,
  "the installer must retain and verify each prior root-owned inode before replacement");
assert.match(installerSource, /file\.hadPrevious = true[\s\S]*?rename\(file\.stagedPath, file\.path\)/u,
  "the staged guardian must atomically replace the live pathname only after rollback is secured");
assert.match(installerSource, /for \(const file of \[\.\.\.files\]\.reverse\(\)\)[\s\S]*?restorePreviousFile\(file\)/u, "failed installation must restore both prior files in reverse activation order");
assert.match(installerSource, /if \(initialService\.loaded\)[\s\S]*?refused to replace or restart a loaded guardian/u,
  "setup must reject any attempt to replace or restart an already-loaded guardian");
assert.doesNotMatch(installerSource, /runLaunchctl\(\["kickstart"|execFileAsync\("\/bin\/launchctl", \["bootout"/u,
  "parallel migration must never kickstart, signal, or unload either guardian");
assert.match(installerSource, /serviceBootstrapAttempted = true[\s\S]*?bootstrapSystemGuardian\(\)[\s\S]*?if \(serviceBootstrapAttempted\)[\s\S]*?preserved the new parallel guardian files/u,
  "an uncertain first start must preserve the safe parallel files for idempotent launchd retry without stopping the legacy guardian");
assert.match(installerSource, /if \(options\.authorizationOnly\)[\s\S]*?installRootAuthorization[\s\S]*?return/u,
  "an already-running v4 guardian must refresh only the expiring root bridge grant");
assert.match(installerSource, /rollbackErrors\.length[\s\S]*?Recovery files were preserved/u, "failed rollback must preserve root-owned recovery files for inspection");
assert.match(installerSource, /let cleanupSafe = false[\s\S]*?if \(rollbackErrors\.length\)[\s\S]*?Recovery evidence was preserved[\s\S]*?cleanupSafe = true[\s\S]*?if \(cleanupSafe\) await discardStagedFiles/u,
  "authorization backups must be discarded only after successful activation or successful rollback");
assert.match(installerSource, /expectedCurrentScriptSha256 === "absent"[\s\S]*?isErrorCode\(error, "ENOENT"\)[\s\S]*?parallel v4 guardian appeared/u,
  "the first parallel install must accept only exact absence and reject a raced guardian path");
assert.match(installerSource, /assertExpectedCurrentGuardian\(options\)[\s\S]*?stageRootOwnedFile[\s\S]*?assertExpectedCurrentGuardian\(options\)[\s\S]*?activateStagedFile/u, "the root helper must close the authorization-to-activation race over the new parallel guardian bytes or pinned absence");
assert.match(installerSource, /assertExpectedCurrentGuardian\(options\)[\s\S]*?serviceBeforeActivation = await inspectSystemGuardianService\(\)[\s\S]*?if \(serviceBeforeActivation\.loaded\)[\s\S]*?activationStarted = true[\s\S]*?activateStagedFile/u,
  "the root helper must re-check launchd immediately before activation and never replace files beneath a newly loaded v4 guardian");
assert.match(installerSource, /codesign[\s\S]*?stagedSignatureBefore[\s\S]*?readPinnedRegularFile\(updaterScriptPath[\s\S]*?codesign[\s\S]*?stagedSignatureAfter[\s\S]*?sameCodeSignatureIdentity/u,
  "root bootstrap authorization must bracket signed build and updater reads with stable signature verification");
assert.match(installerSource, /targetSignatureBefore[\s\S]*?readBootstrapBuildIdentity\(targetPath\)[\s\S]*?targetSignatureAfter[\s\S]*?sameCodeSignatureIdentity\(targetSignatureBefore, targetSignatureAfter\)[\s\S]*?targetSignatureAfter\.cdHash !== options\.expectedTargetCdHash/u,
  "root bootstrap authorization must also bracket and pin the installed target generation");
assert.match(installerSource, /before\.mtimeMs !== after\.mtimeMs/u,
  "pinned bootstrap reads must reject same-inode, same-size in-place mutation");
assert.match(installerSource, /targetPath !== DEFAULT_TARGET_APP_PATH[\s\S]*?validateAppOwnedAccount\(options\)/u,
  "app-owned root setup must independently pin the canonical protected app before changing guardian files");
assert.match(installerSource, /validateAppOwnedAccount[\s\S]*?\/usr\/bin\/id[\s\S]*?\/usr\/bin\/dscl[\s\S]*?accountUid !== options\.targetUid[\s\S]*?accountHome !== options\.targetHome/u,
  "the root helper must bind the approved uid, user, and home tuple to the macOS account database");

const markerRoot = await mkdtemp(join(tmpdir(), "vigil-guardian-maintenance-"));
try {
  const lockPath = join(markerRoot, "update.lock");
  const authorizationPath = join(markerRoot, "maintenance-authorization.plist");
  const guardianScriptPath = join(markerRoot, "guardian.sh");
  const guardianPlistPath = join(markerRoot, "guardian.plist");
  const guardianLabel = "tech.caseline.vigil.test-system-guardian";
  const token = "12345678-1234-1234-1234-123456789abc";
  await writeFile(guardianScriptPath, "#!/bin/zsh\nwhile true; do sleep 2; done\n", { mode: 0o755 });
  assert.deepEqual(
    await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0),
    {
      ready: false,
      guardianInstalled: true,
      reason: "legacy-protocol",
      setupRequired: true,
      setupSupported: true,
      message: "Vigil's system guardian predates authenticated app updates. Refresh it through Vigil's protected maintenance setup before installing this update."
    },
    "an old guardian must block before the updater spends time rebuilding the app"
  );
  await writeFile(guardianPlistPath, toPlist({
    Label: guardianLabel,
    ProgramArguments: [guardianScriptPath, "--vigil-system-guardian"],
    KeepAlive: true,
    RunAtLoad: true
  }), { mode: 0o644 });
  assert.deepEqual(
    await guardianMaintenanceReadiness(
      authorizationPath,
      guardianScriptPath,
      process.getuid?.() ?? 0,
      { guardianPlistPath, guardianLabel }
    ),
    {
      ready: false,
      guardianInstalled: true,
      reason: "legacy-protocol",
      setupRequired: true,
      setupSupported: true,
      message: "Vigil's system guardian predates authenticated app updates. Refresh it through Vigil's protected maintenance setup before installing this update."
    },
    "a safe legacy guardian with the expected launchd topology may use the one-prompt setup path"
  );
  await writeFile(guardianPlistPath, toPlist({
    Label: `${guardianLabel}.unexpected`,
    ProgramArguments: [guardianScriptPath],
    KeepAlive: true,
    RunAtLoad: true
  }), { mode: 0o644 });
  const topologyMismatch = await guardianMaintenanceReadiness(
    authorizationPath,
    guardianScriptPath,
    process.getuid?.() ?? 0,
    { guardianPlistPath, guardianLabel }
  );
  assert.equal(topologyMismatch.reason, "topology-mismatch");
  assert.equal(topologyMismatch.setupSupported, false,
    "an unexpected loaded topology must not expose a setup path that would require unloading protection");
  await writeFile(guardianPlistPath, toPlist({
    Label: guardianLabel,
    ProgramArguments: [guardianScriptPath, "--vigil-system-guardian"],
    KeepAlive: true,
    RunAtLoad: true
  }), { mode: 0o644 });
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
  const legacyAuthorizationGuardianCore = `authorize_maintenance_request() { :; }\nattest_update_recovery() { :; }\nattested_canonical_app_generation() { :; }\nbounded_root_copy() { :; }\n# vigil-root-maintenance-authorization-v2\n# ${authorizationPath}\n`;
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\n${SYSTEM_GUARDIAN_REVISION_MARKER}\n${legacyAuthorizationGuardianCore}# ${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}\n`,
    { mode: 0o755 }
  );
  assert.equal(
    (await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0)).reason,
    "legacy-protocol",
    "a guardian that writes the old partial maintenance authorization must be refreshed even if its revision marker looks current"
  );
  const authenticatedGuardianCore = `${legacyAuthorizationGuardianCore}write_maintenance_authorization() { :; }\nnormal_updater_script_for_command() { :; }\nverified_signed_script_hash() { :; }\n# authorizationMode updaterCommand updaterScriptPath updaterScriptSha256 updaterAppCdHash\n# parentPid parentExecutable parentStarted parentCommand bootstrapAuthorizationSha256\n`;
  const v2GuardianProtocol = `${authenticatedGuardianCore}# vigil-root-update-recovery-authorization-v2\n`;
  const authenticatedGuardianProtocol = `${authenticatedGuardianCore}# ${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}\n`;
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\n${SYSTEM_GUARDIAN_REVISION_MARKER}\n${v2GuardianProtocol}`,
    { mode: 0o755 }
  );
  const v2Readiness = await guardianMaintenanceReadiness(
    authorizationPath,
    guardianScriptPath,
    process.getuid?.() ?? 0
  );
  assert.equal(v2Readiness.reason, "outdated-revision");
  assert.equal(v2Readiness.setupSupported, true,
    "a same-protocol v2 guardian must be safely refreshable even if it carries the current script revision");
  await writeFile(guardianScriptPath, `#!/bin/zsh\n${authenticatedGuardianProtocol}`, { mode: 0o755 });
  const unversionedReadiness = await guardianMaintenanceReadiness(
    authorizationPath,
    guardianScriptPath,
    process.getuid?.() ?? 0
  );
  assert.equal(unversionedReadiness.ready, false);
  assert.equal(unversionedReadiness.reason, "outdated-revision");
  assert.equal(unversionedReadiness.setupSupported, true,
    "a same-protocol guardian without the safety revision must use the existing authenticated refresh UI");
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\n${SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX}0\n${authenticatedGuardianProtocol}`,
    { mode: 0o755 }
  );
  assert.equal(
    (await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0)).reason,
    "outdated-revision",
    "an invalid or older revision must remain safely refreshable"
  );
  await writeFile(
    guardianScriptPath,
    `#!/bin/zsh\n${SYSTEM_GUARDIAN_REVISION_MARKER}\n${authenticatedGuardianProtocol}`,
    { mode: 0o755 }
  );
  assert.equal(
    (await guardianMaintenanceReadiness(authorizationPath, guardianScriptPath, process.getuid?.() ?? 0)).ready,
    true,
    "the current guardian protocol and safety revision must pass the cheap updater preflight"
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
  let maintenanceSettled = false;
  const maintenancePromise = beginGuardianMaintenance(lockPath, token, process.pid, startedAt, {
    authorizationPath,
    expectedAuthorizationUid: process.getuid?.() ?? 0
  }).finally(() => { maintenanceSettled = true; });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
  assert.equal(maintenanceSettled, false,
    "a sparse predecessor grant must never authorize maintenance before v4 publishes a full stable generation");
  const completeAuthorizationPath = `${authorizationPath}.complete`;
  await writeFile(completeAuthorizationPath, toPlist({
    kind: "vigil-root-maintenance-authorization-v2",
    authorizationMode: "normal",
    token,
    pid: process.pid,
    lockPath,
    updaterExecutable: process.execPath,
    updaterStarted: new Date(startedAt).toUTCString(),
    updaterCommand: `${process.execPath} updater.mjs`,
    updaterScriptPath: "/Applications/Vigil.app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/update-packaged-app.mjs",
    updaterScriptSha256: "a".repeat(64),
    updaterAppCdHash: "b".repeat(40),
    parentPid: process.ppid,
    parentExecutable: process.execPath,
    parentStarted: new Date(startedAt).toUTCString(),
    parentCommand: process.execPath,
    bootstrapAuthorizationSha256: "-",
    expiresAtEpoch: Math.floor(startedAt / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
  }), { mode: 0o644 });
  await rename(completeAuthorizationPath, authorizationPath);
  const maintenance = await maintenancePromise;
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
    expectedAuthorizationUid: process.getuid?.() ?? 0,
    expectedAppInitialCdHash: "c".repeat(40),
    expectedAppTargetCdHash: "d".repeat(40)
  };
  await assertGuardianMaintenanceActive(lockPath, token, process.pid, startedAt + 1_000, authorizationOptions);
  await assert.rejects(
    assertGuardianMaintenanceActive(lockPath, token, process.pid + 1, startedAt + 1_000, authorizationOptions),
    /lock ownership/u,
    "an unrelated signal sender cannot authorize the app's protected updater quit path"
  );
  const recoveryPolicySha256 = "a".repeat(64);
  const recoveryManifestPath = join(markerRoot, "update-recovery.json");
  const recoveryPolicyPath = join(markerRoot, "update-recovery-policy.json");
  const recoveryApp = {
    targetPath: "/Applications/Vigil.app",
    initialPresent: true,
    initialDev: "11",
    initialIno: "12",
    initialCommit: "1".repeat(40),
    initialFingerprint: "2".repeat(64),
    initialCdHash: authorizationOptions.expectedAppInitialCdHash,
    targetDev: "21",
    targetIno: "22",
    targetCommit: "3".repeat(40),
    targetFingerprint: "4".repeat(64),
    targetCdHash: authorizationOptions.expectedAppTargetCdHash
  };
  await writeFile(recoveryManifestPath, `${JSON.stringify({
    version: 1,
    attemptId: token,
    state: "pending",
    source: { initialCommit: "1".repeat(40), targetCommit: "1".repeat(40), syncPending: false },
    app: recoveryApp,
    recovery: { policyPath: recoveryPolicyPath, policySha256: recoveryPolicySha256 },
    immutableEvidence: "root-attested",
    timestamps: { startedAt: new Date(startedAt).toISOString() }
  })}\n`, { mode: 0o600 });
  const recoveryPendingManifestSha256 = await guardianRecoveryManifestSha256(recoveryManifestPath);
  const recoveryAttestationBase = {
    recoveryPolicySha256,
    recoveryManifestPath,
    recoveryPolicyPath,
    recoveryAppPath: recoveryApp.targetPath,
    appInitialPresent: true,
    appInitialDev: recoveryApp.initialDev,
    appInitialIno: recoveryApp.initialIno,
    appInitialCommit: recoveryApp.initialCommit,
    appInitialFingerprint: recoveryApp.initialFingerprint,
    appTargetDev: recoveryApp.targetDev,
    appTargetIno: recoveryApp.targetIno,
    appTargetCommit: recoveryApp.targetCommit,
    appTargetFingerprint: recoveryApp.targetFingerprint
  };
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /did not attest update recovery/u,
    "same-user transaction files without separate root attestation must not authorize activation"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: "forged-attempt",
    recoveryPendingManifestSha256,
    appInitialCdHash: authorizationOptions.expectedAppInitialCdHash,
    appTargetCdHash: authorizationOptions.expectedAppTargetCdHash
  }), { mode: 0o644 });
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a forged attestation for another manifest attempt must fail closed"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: token,
    recoveryPendingManifestSha256: "b".repeat(64),
    appInitialCdHash: authorizationOptions.expectedAppInitialCdHash,
    appTargetCdHash: authorizationOptions.expectedAppTargetCdHash
  }), { mode: 0o644 });
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a root file for a different immutable manifest must not authorize activation"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: token,
    recoveryPendingManifestSha256,
    appInitialCdHash: authorizationOptions.expectedAppInitialCdHash,
    appTargetCdHash: "e".repeat(40)
  }), { mode: 0o666 });
  await chmod(authorizationOptions.recoveryAuthorizationPath, 0o666);
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /did not attest update recovery/u,
    "a writable same-user recovery attestation must not authorize canonical activation"
  );
  await chmod(authorizationOptions.recoveryAuthorizationPath, 0o644);
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(lockPath, token, recoveryPolicySha256, process.pid, authorizationOptions),
    /does not match this update/u,
    "a root attestation for a different signed target generation must fail closed"
  );
  await writeFile(authorizationOptions.recoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: token,
    recoveryPendingManifestSha256,
    appInitialCdHash: authorizationOptions.expectedAppInitialCdHash,
    appTargetCdHash: authorizationOptions.expectedAppTargetCdHash
  }), { mode: 0o644 });
  await waitForGuardianRecoveryAuthorization(
    lockPath,
    token,
    recoveryPolicySha256,
    process.pid,
    authorizationOptions
  );
  const previousRecoveryAuthorizationPath = join(markerRoot, "update-recovery-authorization-v3.plist");
  const legacyRecoveryAuthorizationPath = join(markerRoot, "update-recovery-authorization-v2.plist");
  const coexistenceAuthorizationOptions = {
    ...authorizationOptions,
    recoveryAuthorizationRequirements: [
      {
        kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
        label: SYSTEM_GUARDIAN_LABEL,
        path: authorizationOptions.recoveryAuthorizationPath,
        protocol: "pinned-pending" as const
      },
      {
        kind: PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
        label: PREVIOUS_SYSTEM_GUARDIAN_LABEL,
        path: previousRecoveryAuthorizationPath,
        protocol: "pinned-pending" as const
      },
      {
        kind: LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
        label: LEGACY_SYSTEM_GUARDIAN_LABEL,
        path: legacyRecoveryAuthorizationPath,
        protocol: "legacy-normalized" as const
      }
    ]
  };
  await writeFile(previousRecoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: token,
    recoveryPendingManifestSha256,
    appInitialCdHash: authorizationOptions.expectedAppInitialCdHash,
    appTargetCdHash: authorizationOptions.expectedAppTargetCdHash
  }), { mode: 0o644 });
  await assert.rejects(
    waitForGuardianRecoveryAuthorization(
      lockPath,
      token,
      recoveryPolicySha256,
      process.pid,
      coexistenceAuthorizationOptions
    ),
    /did not attest update recovery/u,
    "v4 and v3 attestations alone must not authorize activation while the legacy guardian is still live"
  );
  await writeFile(legacyRecoveryAuthorizationPath, toPlist({
    ...recoveryAttestationBase,
    kind: LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
    recoveryAttemptId: token,
    recoveryManifestSha256: "5".repeat(64)
  }), { mode: 0o644 });
  await waitForGuardianRecoveryAuthorization(
    lockPath,
    token,
    recoveryPolicySha256,
    process.pid,
    coexistenceAuthorizationOptions
  );
  await writeFile(authorizationPath, toPlist({
    kind: "vigil-root-maintenance-authorization-v2",
    authorizationMode: "normal",
    token: "wrong-token",
    pid: process.pid,
    lockPath,
    updaterExecutable: process.execPath,
    updaterStarted: new Date(startedAt).toUTCString(),
    updaterCommand: `${process.execPath} updater.mjs`,
    updaterScriptPath: "/Applications/Vigil.app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/update-packaged-app.mjs",
    updaterScriptSha256: "a".repeat(64),
    updaterAppCdHash: "b".repeat(40),
    parentPid: process.ppid,
    parentExecutable: process.execPath,
    parentStarted: new Date(startedAt).toUTCString(),
    parentCommand: process.execPath,
    bootstrapAuthorizationSha256: "-",
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

function shellFunction(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`Generated guardian is missing ${name}().`);
  const end = script.indexOf("\n}\n\n", start);
  if (end < 0) throw new Error(`Generated guardian has an unterminated ${name}().`);
  return script.slice(start, end + 3);
}

async function guardianShellFileDigest(guardianScript: string, manifestPath: string): Promise<string> {
  const snapshotRoot = await mkdtemp(join(dirname(manifestPath), ".guardian-root-snapshot-"));
  const snapshotPath = join(snapshotRoot, "update-recovery.json");
  const harness = `set -eu
${shellFunction(guardianScript, "sha256_file")}
/bin/cp -P "$1" "$2"
sha256_file "$2"
`;
  try {
    return await new Promise<string>((resolveDigest, rejectDigest) => {
      const child = spawn("/bin/zsh", ["-c", harness, "vigil-pending-manifest", manifestPath, snapshotPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", rejectDigest);
      child.once("close", (code) => {
        const digest = stdout.trim();
        if (code !== 0 || !/^[a-f0-9]{64}$/u.test(digest)) {
          rejectDigest(new Error(stderr.trim() || `guardian pending-manifest digest exited with status ${code}`));
          return;
        }
        resolveDigest(digest);
      });
    });
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}
