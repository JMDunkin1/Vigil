import { dirname, join } from "node:path";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  defaultUpdaterLockPath,
  guardianMaintenanceMarkerPath
} from "./updateMaintenance.js";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME
} from "./updateTransaction.js";

export const SYSTEM_GUARDIAN_LABEL = "tech.caseline.vigil.system-guardian";
export const SYSTEM_GUARDIAN_ROOT = "/Library/Application Support/Vigil/System Guardian";
export const SYSTEM_GUARDIAN_SCRIPT_PATH = join(SYSTEM_GUARDIAN_ROOT, "vigil-system-guardian-DO-NOT-TERMINATE.sh");
export const SYSTEM_GUARDIAN_PLIST_PATH = `/Library/LaunchDaemons/${SYSTEM_GUARDIAN_LABEL}.plist`;
export const SYSTEM_GUARDIAN_SAFETY_ARG = "--vigil-safety-boundary-do-not-terminate-or-bootout";

export interface SystemGuardianConfig {
  appPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  updateLockPath?: string;
  userSupervisorLabel?: string;
}

export function systemGuardianScript(config: SystemGuardianConfig): string {
  const executablePath = join(config.appPath, "Contents", "MacOS", "Vigil");
  const supervisorLabel = config.userSupervisorLabel || "tech.caseline.vigil.supervisor";
  const executablePattern = `^${regexEscape(executablePath)}($| )`;
  const updateLockPath = config.updateLockPath || defaultUpdaterLockPath(config.targetHome);
  const maintenanceMarkerPath = guardianMaintenanceMarkerPath(updateLockPath);
  const updaterDir = dirname(updateLockPath);
  const recoveryManifestPath = join(updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  const recoveryPolicyPath = join(updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  return `#!/bin/zsh
# VIGIL SAFETY BOUNDARY: this root-owned guardian exists specifically so a
# same-user process or automation agent cannot take enforcement offline by
# terminating the app and unloading its user LaunchAgent.
set -u
target_uid=${config.targetUid}
target_user=${shellSingleQuote(config.targetUser)}
target_home=${shellSingleQuote(config.targetHome)}
app_path=${shellSingleQuote(config.appPath)}
executable_path=${shellSingleQuote(executablePath)}
process_pattern=${shellSingleQuote(executablePattern)}
supervisor_service=${shellSingleQuote(`gui/${config.targetUid}/${supervisorLabel}`)}
update_lock_path=${shellSingleQuote(updateLockPath)}
maintenance_marker_path=${shellSingleQuote(maintenanceMarkerPath)}
root_authorization_path=${shellSingleQuote(SYSTEM_GUARDIAN_AUTHORIZATION_PATH)}
root_recovery_authorization_path=${shellSingleQuote(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH)}
global_update_manifest_path=${shellSingleQuote(recoveryManifestPath)}
global_update_policy_path=${shellSingleQuote(recoveryPolicyPath)}
offline_since=0

reopen_vigil() {
  /bin/launchctl asuser "$target_uid" /usr/bin/sudo -H -u "$target_user" \
    /usr/bin/env HOME="$target_home" USER="$target_user" LOGNAME="$target_user" \
    PATH="$target_home/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    /usr/bin/open -gn "$app_path" --args --vigil-background ${SYSTEM_GUARDIAN_SAFETY_ARG}
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" 2>/dev/null | /usr/bin/awk '{ print $1 }'
}

private_target_file() {
  local path="$1"
  local expected_mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null)" == "$expected_mode" ]]
}

private_root_file() {
  local path="$1"
  local expected_mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" == "0" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null)" == "$expected_mode" ]]
}

bounded_root_copy() {
  local source_path="$1"
  local destination_path="$2"
  /bin/rm -f "$destination_path" || return 1
  (
    ulimit -f 512
    umask 077
    exec /bin/cp -P "$source_path" "$destination_path"
  ) &
  local copy_pid=$!
  local copy_deadline=$(( $(/bin/date +%s) + 2 ))
  local copy_parent
  while true; do
    copy_parent=$(/bin/ps -p "$copy_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
    [[ "$copy_parent" == "$$" ]] || break
    if (( $(/bin/date +%s) >= copy_deadline )); then
      /bin/kill -TERM "$copy_pid" >/dev/null 2>&1 || true
      /bin/sleep 0.1
      copy_parent=$(/bin/ps -p "$copy_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
      [[ "$copy_parent" == "$$" ]] && /bin/kill -KILL "$copy_pid" >/dev/null 2>&1 || true
      wait "$copy_pid" >/dev/null 2>&1 || true
      /bin/rm -f "$destination_path"
      return 1
    fi
    /bin/sleep 0.05
  done
  local copy_status=0
  wait "$copy_pid" || copy_status=$?
  [[ "$copy_status" -eq 0 ]] || { /bin/rm -f "$destination_path"; return 1; }
  private_root_file "$destination_path" 600 || { /bin/rm -f "$destination_path"; return 1; }
  local copied_size=$(/usr/bin/stat -f '%z' "$destination_path" 2>/dev/null)
  [[ "$copied_size" == <-> && "$copied_size" -le 262144 ]] || { /bin/rm -f "$destination_path"; return 1; }
}

global_update_manifest_present() {
  [[ -e "$global_update_manifest_path" || -L "$global_update_manifest_path" ]]
}

normalized_recovery_manifest_sha256() {
  local source_manifest="$global_update_manifest_path"
  [[ "$#" -ge 1 ]] && source_manifest="$1"
  local copy_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  [[ -n "$copy_uuid" ]] || return 1
  local temporary="${SYSTEM_GUARDIAN_AUTHORIZATION_PATH}.manifest.$copy_uuid.tmp"
  bounded_root_copy "$source_manifest" "$temporary" || return 1
  /usr/bin/plutil -remove state "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -remove source.syncPending "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -remove timestamps "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -convert binary1 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  local digest=$(sha256_file "$temporary")
  /bin/rm -f "$temporary"
  [[ "\${#digest}" -eq 64 && "$digest" != *[^a-f0-9]* ]] || return 1
  /usr/bin/printf '%s' "$digest"
}

app_content_matches() {
  local artifact_path="$1"
  local expected_commit="$2"
  local expected_fingerprint="$3"
  [[ -n "$expected_commit" || -n "$expected_fingerprint" ]] || return 0
  local build_info
  for build_info in \
    "$artifact_path/Contents/Resources/app.asar.unpacked/dist/runtime/build-info.json" \
    "$artifact_path/Contents/Resources/app.asar/dist/runtime/build-info.json"; do
    local copy_uuid=$(/usr/bin/uuidgen 2>/dev/null)
    [[ -n "$copy_uuid" ]] || return 1
    local build_snapshot="${SYSTEM_GUARDIAN_AUTHORIZATION_PATH}.build-info.$copy_uuid.tmp"
    bounded_root_copy "$build_info" "$build_snapshot" || continue
    local observed_commit=$(json_value "$build_snapshot" commit)
    local observed_fingerprint=$(json_value "$build_snapshot" sourceFingerprint)
    /bin/rm -f "$build_snapshot"
    [[ -z "$expected_commit" || "$observed_commit" == "$expected_commit" ]] || continue
    [[ -z "$expected_fingerprint" || "$observed_fingerprint" == "$expected_fingerprint" ]] || continue
    return 0
  done
  return 1
}

app_identity_matches_manifest() {
  local artifact_path="$1"
  local prefix="$2"
  local manifest_path="$global_update_manifest_path"
  [[ "$#" -ge 3 ]] && manifest_path="$3"
  [[ -e "$artifact_path" && ! -L "$artifact_path" ]] || return 1
  local expected_dev=$(json_value "$manifest_path" "app.\${prefix}Dev")
  local expected_ino=$(json_value "$manifest_path" "app.\${prefix}Ino")
  [[ "$expected_dev" == <-> && "$expected_ino" == <-> ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$artifact_path" 2>/dev/null)" == "$expected_dev" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$artifact_path" 2>/dev/null)" == "$expected_ino" ]] || return 1
  local expected_commit=$(json_value "$manifest_path" "app.\${prefix}Commit")
  local expected_fingerprint=$(json_value "$manifest_path" "app.\${prefix}Fingerprint")
  app_content_matches "$artifact_path" "$expected_commit" "$expected_fingerprint"
}

attested_app_fields_match_manifest() {
  local manifest_path="$global_update_manifest_path"
  [[ "$#" -ge 1 ]] && manifest_path="$1"
  [[ "$(json_value "$root_recovery_authorization_path" recoveryAppPath)" == "$(json_value "$manifest_path" app.targetPath)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialPresent)" == "$(json_value "$manifest_path" app.initialPresent)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialDev)" == "$(json_value "$manifest_path" app.initialDev)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialIno)" == "$(json_value "$manifest_path" app.initialIno)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialCommit)" == "$(json_value "$manifest_path" app.initialCommit)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialFingerprint)" == "$(json_value "$manifest_path" app.initialFingerprint)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetDev)" == "$(json_value "$manifest_path" app.targetDev)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetIno)" == "$(json_value "$manifest_path" app.targetIno)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetCommit)" == "$(json_value "$manifest_path" app.targetCommit)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetFingerprint)" == "$(json_value "$manifest_path" app.targetFingerprint)" ]]
}

attested_canonical_app_generation() {
  root_recovery_attestation_present || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryAppPath)" == "$app_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialPresent)" == "true" ]] || return 1
  [[ -e "$app_path" && ! -L "$app_path" ]] || return 1
  local observed_dev=$(/usr/bin/stat -f '%d' "$app_path" 2>/dev/null)
  local observed_ino=$(/usr/bin/stat -f '%i' "$app_path" 2>/dev/null)
  local generation
  for generation in Initial Target; do
    local expected_dev=$(json_value "$root_recovery_authorization_path" "app\${generation}Dev")
    local expected_ino=$(json_value "$root_recovery_authorization_path" "app\${generation}Ino")
    [[ "$expected_dev" == <-> && "$expected_ino" == <-> ]] || continue
    [[ "$observed_dev" == "$expected_dev" && "$observed_ino" == "$expected_ino" ]] || continue
    local expected_commit=$(json_value "$root_recovery_authorization_path" "app\${generation}Commit")
    local expected_fingerprint=$(json_value "$root_recovery_authorization_path" "app\${generation}Fingerprint")
    app_content_matches "$app_path" "$expected_commit" "$expected_fingerprint" || continue
    return 0
  done
  return 1
}

clear_recovery_attestation() {
  [[ -e "$root_recovery_authorization_path" || -L "$root_recovery_authorization_path" ]] || return 0
  [[ -f "$root_recovery_authorization_path" && ! -L "$root_recovery_authorization_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$root_recovery_authorization_path" 2>/dev/null)" == "0" ]] || return 1
  /bin/rm -f "$root_recovery_authorization_path"
}

attest_update_recovery_snapshot() {
  local manifest_path="$1"
  private_root_file "$manifest_path" 600 || return 1
  local manifest_attempt=$(json_value "$manifest_path" attemptId)
  local manifest_state=$(json_value "$manifest_path" state)
  local manifest_policy_path=$(json_value "$manifest_path" recovery.policyPath)
  local policy_sha=$(json_value "$manifest_path" recovery.policySha256)
  local manifest_app_path=$(json_value "$manifest_path" app.targetPath)
  [[ -n "$manifest_attempt" ]] || return 1
  [[ "$manifest_state" == "pending" || "$manifest_state" == "commit-intent" || "$manifest_state" == "committed" || "$manifest_state" == "rolling-back" ]] || return 1
  [[ "$manifest_policy_path" == "$global_update_policy_path" ]] || return 1
  local policy_sha_length=$(/usr/bin/printf '%s' "$policy_sha" | /usr/bin/wc -c | /usr/bin/xargs)
  [[ "$policy_sha_length" == "64" && "$policy_sha" != *[^a-f0-9]* ]] || return 1
  [[ "$manifest_app_path" == "$app_path" ]] || return 1
  local existing_attempt=$(json_value "$root_recovery_authorization_path" recoveryAttemptId)
  if [[ -n "$existing_attempt" ]]; then
    if [[ "$existing_attempt" != "$manifest_attempt" ]]; then
      clear_recovery_attestation || return 1
      existing_attempt=""
    fi
  fi
  if [[ -n "$existing_attempt" ]]; then
    [[ -f "$root_recovery_authorization_path" && ! -L "$root_recovery_authorization_path" ]] || return 1
    [[ "$(/usr/bin/stat -f '%u' "$root_recovery_authorization_path" 2>/dev/null)" == "0" ]] || return 1
    [[ "$(json_value "$root_recovery_authorization_path" kind)" == "vigil-root-update-recovery-authorization-v2" ]] || return 1
    [[ "$(json_value "$root_recovery_authorization_path" recoveryPolicySha256)" == "$policy_sha" ]] || return 1
    [[ "$(json_value "$root_recovery_authorization_path" recoveryManifestSha256)" == "$(normalized_recovery_manifest_sha256 "$manifest_path")" ]] || return 1
    attested_app_fields_match_manifest "$manifest_path"
    return $?
  fi
  [[ "$(json_value "$manifest_path" state)" == "pending" ]] || return 1
  [[ "$(json_value "$manifest_path" app.initialPresent)" == "true" ]] || return 1
  app_identity_matches_manifest "$app_path" initial "$manifest_path" || return 1
  app_identity_matches_manifest "$app_path.vigil-next" target "$manifest_path" || return 1
  local manifest_sha=$(normalized_recovery_manifest_sha256 "$manifest_path") || return 1
  local authorization_token=$(json_value "$root_authorization_path" token)
  [[ "$authorization_token" == "$manifest_attempt" ]] || return 1
  local app_initial_dev=$(json_value "$manifest_path" app.initialDev)
  local app_initial_ino=$(json_value "$manifest_path" app.initialIno)
  local app_initial_commit=$(json_value "$manifest_path" app.initialCommit)
  local app_initial_fingerprint=$(json_value "$manifest_path" app.initialFingerprint)
  local app_target_dev=$(json_value "$manifest_path" app.targetDev)
  local app_target_ino=$(json_value "$manifest_path" app.targetIno)
  local app_target_commit=$(json_value "$manifest_path" app.targetCommit)
  local app_target_fingerprint=$(json_value "$manifest_path" app.targetFingerprint)
  local temporary="${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH}.$$.tmp"
  /bin/rm -f "$temporary"
  /usr/bin/plutil -create xml1 "$temporary" || return 1
  /usr/bin/plutil -insert kind -string "vigil-root-update-recovery-authorization-v2" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryAttemptId -string "$manifest_attempt" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryPolicySha256 -string "$policy_sha" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryManifestSha256 -string "$manifest_sha" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryManifestPath -string "$global_update_manifest_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryPolicyPath -string "$global_update_policy_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryAppPath -string "$app_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialPresent -bool true "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialDev -string "$app_initial_dev" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialIno -string "$app_initial_ino" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialCommit -string "$app_initial_commit" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialFingerprint -string "$app_initial_fingerprint" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetDev -string "$app_target_dev" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetIno -string "$app_target_ino" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetCommit -string "$app_target_commit" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetFingerprint -string "$app_target_fingerprint" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/sbin/chown 0:0 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/chmod 0644 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/mv -f "$temporary" "$root_recovery_authorization_path"
}

attest_update_recovery() {
  global_update_manifest_present || { clear_recovery_attestation; return $?; }
  private_target_file "$global_update_manifest_path" 600 || return 1
  local copy_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  [[ -n "$copy_uuid" ]] || return 1
  local manifest_snapshot="${SYSTEM_GUARDIAN_AUTHORIZATION_PATH}.recovery-manifest.$copy_uuid.tmp"
  bounded_root_copy "$global_update_manifest_path" "$manifest_snapshot" || return 1
  attest_update_recovery_snapshot "$manifest_snapshot"
  local attestation_status=$?
  /bin/rm -f "$manifest_snapshot"
  return "$attestation_status"
}

root_recovery_attestation_present() {
  [[ -f "$root_recovery_authorization_path" && ! -L "$root_recovery_authorization_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$root_recovery_authorization_path" 2>/dev/null)" == "0" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$root_recovery_authorization_path" 2>/dev/null)" == "644" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" kind)" == "vigil-root-update-recovery-authorization-v2" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryManifestPath)" == "$global_update_manifest_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryPolicyPath)" == "$global_update_policy_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryAppPath)" == "$app_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialPresent)" == "true" ]]
}

authorize_maintenance_request() {
  local now="$1"
  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$maintenance_marker_path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$maintenance_marker_path" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$update_lock_path" 2>/dev/null)" == "600" ]] || return 1

  local marker_kind="$(json_value "$maintenance_marker_path" kind)"
  local marker_token="$(json_value "$maintenance_marker_path" token)"
  local marker_pid="$(json_value "$maintenance_marker_path" pid)"
  local marker_lock_path="$(json_value "$maintenance_marker_path" lockPath)"
  local marker_expires="$(json_value "$maintenance_marker_path" expiresAtEpoch)"
  local marker_modified="$(/usr/bin/stat -f '%m' "$maintenance_marker_path" 2>/dev/null)"
  local lock_token="$(json_value "$update_lock_path" token)"
  local lock_pid="$(json_value "$update_lock_path" pid)"

  [[ "$marker_kind" == "vigil-maintenance-request-v2" ]] || return 1
  [[ -n "$marker_token" && "$marker_token" == "$lock_token" ]] || return 1
  [[ "$marker_pid" == <-> && "$marker_pid" == "$lock_pid" ]] || return 1
  [[ "$marker_lock_path" == "$update_lock_path" ]] || return 1
  [[ "$marker_expires" == <-> && "$marker_modified" == <-> ]] || return 1
  (( marker_expires >= now )) || return 1
  (( marker_expires <= marker_modified + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} )) || return 1

  # A root-created grant for this request is deliberately one-shot. Never
  # refresh its deadline, even if a same-UID process keeps rewriting the request.
  if [[ -f "$root_authorization_path" && ! -L "$root_authorization_path" ]]; then
    local granted_token="$(json_value "$root_authorization_path" token)"
    local granted_pid="$(json_value "$root_authorization_path" pid)"
    local granted_lock_path="$(json_value "$root_authorization_path" lockPath)"
    if [[ "$granted_token" == "$marker_token" && "$granted_pid" == "$marker_pid" && "$granted_lock_path" == "$update_lock_path" ]]; then
      return 0
    fi
  fi

  local owner_uid="$(/bin/ps -p "$marker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)"
  local owner_ppid="$(/bin/ps -p "$marker_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)"
  local owner_executable="$(/bin/ps -p "$marker_pid" -o comm= 2>/dev/null | /usr/bin/xargs)"
  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)"
  local owner_command="$(/bin/ps -p "$marker_pid" -o command= 2>/dev/null)"
  [[ "$owner_uid" == "$target_uid" && "$owner_ppid" == <-> ]] || return 1
  [[ "$owner_executable" == /* && -n "$owner_started" && -f "$owner_executable" && ! -L "$owner_executable" ]] || return 1
  [[ "$owner_command" == *"--lock-path $update_lock_path"* ]] || return 1
  [[ "$owner_command" == *"--lock-token $marker_token"* ]] || return 1

  # The updater must still be a direct child of the configured Vigil binary.
  # ps comm is the kernel-reported executable path, unlike the forgeable argv
  # text in ps command. This is the root authorization boundary before shutdown.
  local parent_uid="$(/bin/ps -p "$owner_ppid" -o uid= 2>/dev/null | /usr/bin/xargs)"
  local parent_executable="$(/bin/ps -p "$owner_ppid" -o comm= 2>/dev/null | /usr/bin/xargs)"
  [[ "$parent_uid" == "$target_uid" && "$parent_executable" == "$executable_path" ]] || return 1

  local authorization_tmp="\${root_authorization_path}.tmp.$$"
  /bin/rm -f "$authorization_tmp"
  /usr/bin/plutil -create xml1 "$authorization_tmp" || return 1
  /usr/bin/plutil -insert kind -string "vigil-root-maintenance-authorization-v2" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert token -string "$marker_token" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert pid -integer "$marker_pid" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert lockPath -string "$update_lock_path" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterExecutable -string "$owner_executable" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterStarted -string "$owner_started" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert expiresAtEpoch -integer "$(( now + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} ))" "$authorization_tmp" || return 1
  /usr/sbin/chown 0:0 "$authorization_tmp" || return 1
  /bin/chmod 0644 "$authorization_tmp" || return 1
  /bin/mv -f "$authorization_tmp" "$root_authorization_path"
}

authenticated_maintenance_active() {
  local now="$1"
  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  [[ -f "$root_authorization_path" && ! -L "$root_authorization_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$maintenance_marker_path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$root_authorization_path" 2>/dev/null)" == "0" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$maintenance_marker_path" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$update_lock_path" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$root_authorization_path" 2>/dev/null)" == "644" ]] || return 1

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
  local authorization_modified="$(/usr/bin/stat -f '%m' "$root_authorization_path" 2>/dev/null)"

  [[ "$marker_kind" == "vigil-maintenance-request-v2" ]] || return 1
  [[ -n "$marker_token" && "$marker_token" == "$lock_token" ]] || return 1
  [[ "$marker_pid" == <-> && "$marker_pid" == "$lock_pid" ]] || return 1
  [[ "$marker_lock_path" == "$update_lock_path" ]] || return 1
  [[ "$marker_expires" == <-> && "$marker_expires" -ge "$now" ]] || return 1
  [[ "$authorization_kind" == "vigil-root-maintenance-authorization-v2" ]] || return 1
  [[ "$authorization_token" == "$marker_token" ]] || return 1
  [[ "$authorization_pid" == "$marker_pid" ]] || return 1
  [[ "$authorization_lock_path" == "$update_lock_path" ]] || return 1
  [[ "$authorization_executable" == /* && -n "$authorization_started" ]] || return 1
  [[ "$authorization_expires" == <-> && "$authorization_modified" == <-> ]] || return 1
  (( authorization_expires >= now )) || return 1
  (( authorization_expires <= authorization_modified + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} )) || return 1
  (( marker_expires >= now )) || return 1

  local owner_uid="$(/bin/ps -p "$marker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)"
  local owner_executable="$(/bin/ps -p "$marker_pid" -o comm= 2>/dev/null | /usr/bin/xargs)"
  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)"
  local owner_command="$(/bin/ps -p "$marker_pid" -o command= 2>/dev/null)"
  [[ "$owner_uid" == "$target_uid" ]] || return 1
  [[ "$owner_executable" == "$authorization_executable" ]] || return 1
  [[ "$owner_started" == "$authorization_started" ]] || return 1
  [[ "$owner_command" == *"--lock-path $update_lock_path"* ]] || return 1
  [[ "$owner_command" == *"--lock-token $marker_token"* ]] || return 1
  return 0
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

  # Only the live updater process that owns both the private lock and a matching,
  # short-lived root authorization may suppress repair. The user-owned marker
  # is only a request and cannot extend the root-created deadline.
  authorize_maintenance_request "$now" >/dev/null 2>&1 || true
  maintenance_active=false
  if authenticated_maintenance_active "$now"; then
    maintenance_active=true
    offline_since=0
    if ! attest_update_recovery; then
      /usr/bin/printf '%s\n' "Vigil's root guardian could not attest the updater's durable recovery transaction yet." >&2
    fi
  elif ! global_update_manifest_present; then
    # No transaction remains to arbitrate. A stale root attestation must never
    # turn a later protected reinstall into an indefinite availability block.
    clear_recovery_attestation >/dev/null 2>&1 || true
  fi

  # The user supervisor exclusively owns strict transaction recovery. The root
  # guardian never parses or executes the mutable recovery policy/runtime after
  # attestation; it only arbitrates availability from its root-owned app proofs.
  # A known canonical generation may keep running or be reopened, while an
  # unknown bundle remains fail-closed until strict recovery restores one.
  recovery_waiting=false
  if [[ "$maintenance_active" == false ]] && global_update_manifest_present && root_recovery_attestation_present; then
    # Recovery control files, state snapshots, journals, and runtime helpers
    # remain mutable by the protected user. Their corruption must not strand
    # enforcement offline when the canonical bundle is still one of the two
    # exact app generations root attested before activation. This availability
    # fallback does not resolve or discard a still-present transaction.
    attested_canonical_app_generation || recovery_waiting=true
  fi

  # Missing user supervision is repaired even while the app is alive. The -n
  # launch creates a short-lived secondary instance; Vigil's singleton handler
  # refreshes the exact signed-in-user supervisor and then exits that instance.
  if [[ "$recovery_waiting" == true ]]; then
    : # Preserve exact attested evidence and retry without launching mid-swap.
  elif [[ "$maintenance_active" == false && "$supervisor_loaded" == false ]]; then
    reopen_vigil
  elif [[ "$maintenance_active" == false && "$app_running" == false ]] && (( now - offline_since >= 15 )); then
    # The grace period lets Vigil's transactional updater replace the bundle
    # without creating a second copy mid-swap. Ordinary crashes are normally
    # recovered sooner by the user LaunchAgent.
    reopen_vigil
    offline_since="$now"
  fi
  /bin/sleep 2
done
`;
}

export function systemGuardianPlist(): string {
  const logPath = join(SYSTEM_GUARDIAN_ROOT, "guardian.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SYSTEM_GUARDIAN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(SYSTEM_GUARDIAN_SCRIPT_PATH)}</string>
    <string>${SYSTEM_GUARDIAN_SAFETY_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
