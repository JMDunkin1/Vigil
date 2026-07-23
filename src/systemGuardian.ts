import { dirname, join } from "node:path";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_REVISION_MARKER,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH,
  UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME,
  UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS,
  defaultUpdaterLockPath,
  guardianMaintenanceMarkerPath
} from "./updateMaintenance.js";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME
} from "./updateTransaction.js";

export const SYSTEM_GUARDIAN_LABEL = "tech.caseline.vigil.system-guardian.v4";
export const SYSTEM_GUARDIAN_ROOT = "/Library/Application Support/Vigil/System Guardian";
export const SYSTEM_GUARDIAN_SCRIPT_PATH = join(SYSTEM_GUARDIAN_ROOT, "vigil-system-guardian-v4-DO-NOT-TERMINATE.sh");
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
  const exactMainCommand = `${executablePath} --vigil-background ${SYSTEM_GUARDIAN_SAFETY_ARG}`;
  const exactMainProcessPattern = `^${regexEscape(exactMainCommand)}$`;
  const updateLockPath = config.updateLockPath || defaultUpdaterLockPath(config.targetHome);
  const maintenanceMarkerPath = guardianMaintenanceMarkerPath(updateLockPath);
  const updaterDir = dirname(updateLockPath);
  const recoveryManifestPath = join(updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  const recoveryPolicyPath = join(updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  return `#!/bin/zsh
${SYSTEM_GUARDIAN_REVISION_MARKER}
# VIGIL SAFETY BOUNDARY: this root-owned guardian exists specifically so a
# same-user process or automation agent cannot take enforcement offline by
# terminating the app and unloading its user LaunchAgent.
# ${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}
# READINESS-ONLY COMPATIBILITY MARKER: controllers loaded before the v4
# guardian refresh look for this literal before they may start the refreshed
# updater. It is not an accepted recovery-authorization kind.
# vigil-root-update-recovery-authorization-v2
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
bootstrap_authorization_path=${shellSingleQuote(UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH)}
bootstrap_claim_path=${shellSingleQuote(UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH)}
previous_bootstrap_claim_path=${shellSingleQuote(PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH)}
bootstrap_worker_request_path=${shellSingleQuote(join(updaterDir, UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME))}
global_update_manifest_path=${shellSingleQuote(recoveryManifestPath)}
global_update_policy_path=${shellSingleQuote(recoveryPolicyPath)}
exact_main_command=${shellSingleQuote(exactMainCommand)}
exact_main_process_pattern=${shellSingleQuote(exactMainProcessPattern)}
packaged_updater_script_path=${shellSingleQuote(join(config.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"))}
local_updater_script_path=${shellSingleQuote(join(config.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "launch-local-app.mjs"))}
user_data_dir=${shellSingleQuote(join(config.targetHome, "Library", "Application Support", "Vigil"))}
update_status_path=${shellSingleQuote(join(updaterDir, "update-status.json"))}
update_log_path=${shellSingleQuote(join(updaterDir, "update.log"))}
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

verified_code_directory_hash() {
  local artifact_path="$1"
  local expected_dev="$2"
  local expected_ino="$3"
  [[ -d "$artifact_path" && ! -L "$artifact_path" ]] || return 1
  local before_dev=$(/usr/bin/stat -f '%d' "$artifact_path" 2>/dev/null)
  local before_ino=$(/usr/bin/stat -f '%i' "$artifact_path" 2>/dev/null)
  [[ "$before_dev" == "$expected_dev" && "$before_ino" == "$expected_ino" ]] || return 1
  /usr/bin/codesign --verify --deep --strict "$artifact_path" >/dev/null 2>&1 || return 1
  local detail=$(/usr/bin/codesign -dv --verbose=4 "$artifact_path" 2>&1) || return 1
  local cdhash=$(/usr/bin/printf '%s\n' "$detail" | /usr/bin/awk -F= '/^CDHash=/ { print tolower($2); exit }')
  [[ "\${#cdhash}" -ge 40 && "\${#cdhash}" -le 64 && "$cdhash" != *[^a-f0-9]* ]] || return 1
  /usr/bin/codesign --verify --deep --strict "$artifact_path" >/dev/null 2>&1 || return 1
  local confirmed_detail=$(/usr/bin/codesign -dv --verbose=4 "$artifact_path" 2>&1) || return 1
  local confirmed_cdhash=$(/usr/bin/printf '%s\n' "$confirmed_detail" | /usr/bin/awk -F= '/^CDHash=/ { print tolower($2); exit }')
  [[ "$confirmed_cdhash" == "$cdhash" ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$artifact_path" 2>/dev/null)" == "$before_dev" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$artifact_path" 2>/dev/null)" == "$before_ino" ]] || return 1
  /usr/bin/printf '%s' "$cdhash"
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

app_content_matches() {
  local artifact_path="$1"
  local expected_commit="$2"
  local expected_fingerprint="$3"
  local expected_cdhash="$4"
  local expected_dev="$5"
  local expected_ino="$6"
  # A directory inode does not bind the bundle contents: a same-user process
  # can rewrite files beneath it without changing that inode. Root availability
  # evidence therefore requires the packaged build identity as well.
  [[ -n "$expected_commit" || -n "$expected_fingerprint" ]] || return 1
  [[ "\${#expected_cdhash}" -ge 40 && "\${#expected_cdhash}" -le 64 && "$expected_cdhash" != *[^a-f0-9]* ]] || return 1
  [[ "$(verified_code_directory_hash "$artifact_path" "$expected_dev" "$expected_ino")" == "$expected_cdhash" ]] || return 1
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
  local expected_cdhash=$(json_value "$manifest_path" "app.\${prefix}CdHash")
  app_content_matches "$artifact_path" "$expected_commit" "$expected_fingerprint" "$expected_cdhash" "$expected_dev" "$expected_ino"
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
  [[ "$(json_value "$root_recovery_authorization_path" appInitialCdHash)" == "$(json_value "$manifest_path" app.initialCdHash)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetDev)" == "$(json_value "$manifest_path" app.targetDev)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetIno)" == "$(json_value "$manifest_path" app.targetIno)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetCommit)" == "$(json_value "$manifest_path" app.targetCommit)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetFingerprint)" == "$(json_value "$manifest_path" app.targetFingerprint)" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appTargetCdHash)" == "$(json_value "$manifest_path" app.targetCdHash)" ]]
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
    local expected_cdhash=$(json_value "$root_recovery_authorization_path" "app\${generation}CdHash")
    app_content_matches "$app_path" "$expected_commit" "$expected_fingerprint" "$expected_cdhash" "$expected_dev" "$expected_ino" || continue
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
    [[ "$(json_value "$root_recovery_authorization_path" kind)" == "${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}" ]] || return 1
    [[ "$(json_value "$root_recovery_authorization_path" recoveryPolicySha256)" == "$policy_sha" ]] || return 1
    local pending_manifest_sha=$(json_value "$root_recovery_authorization_path" recoveryPendingManifestSha256)
    [[ "\${#pending_manifest_sha}" -eq 64 && "$pending_manifest_sha" != *[^a-f0-9]* ]] || return 1
    attested_app_fields_match_manifest "$manifest_path"
    return $?
  fi
  [[ "$(json_value "$manifest_path" state)" == "pending" ]] || return 1
  [[ "$(json_value "$manifest_path" app.initialPresent)" == "true" ]] || return 1
  app_identity_matches_manifest "$app_path" initial "$manifest_path" || return 1
  app_identity_matches_manifest "$app_path.vigil-next" target "$manifest_path" || return 1
  local pending_manifest_sha=$(sha256_file "$manifest_path")
  [[ "\${#pending_manifest_sha}" -eq 64 && "$pending_manifest_sha" != *[^a-f0-9]* ]] || return 1
  local authorization_token=$(json_value "$root_authorization_path" token)
  [[ "$authorization_token" == "$manifest_attempt" ]] || return 1
  local app_initial_dev=$(json_value "$manifest_path" app.initialDev)
  local app_initial_ino=$(json_value "$manifest_path" app.initialIno)
  local app_initial_commit=$(json_value "$manifest_path" app.initialCommit)
  local app_initial_fingerprint=$(json_value "$manifest_path" app.initialFingerprint)
  local app_initial_cdhash=$(json_value "$manifest_path" app.initialCdHash)
  local app_target_dev=$(json_value "$manifest_path" app.targetDev)
  local app_target_ino=$(json_value "$manifest_path" app.targetIno)
  local app_target_commit=$(json_value "$manifest_path" app.targetCommit)
  local app_target_fingerprint=$(json_value "$manifest_path" app.targetFingerprint)
  local app_target_cdhash=$(json_value "$manifest_path" app.targetCdHash)
  local temporary="${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH}.$$.tmp"
  /bin/rm -f "$temporary"
  /usr/bin/plutil -create xml1 "$temporary" || return 1
  /usr/bin/plutil -insert kind -string "${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryAttemptId -string "$manifest_attempt" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryPolicySha256 -string "$policy_sha" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryPendingManifestSha256 -string "$pending_manifest_sha" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryManifestPath -string "$global_update_manifest_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryPolicyPath -string "$global_update_policy_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert recoveryAppPath -string "$app_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialPresent -bool true "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialDev -string "$app_initial_dev" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialIno -string "$app_initial_ino" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialCommit -string "$app_initial_commit" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialFingerprint -string "$app_initial_fingerprint" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appInitialCdHash -string "$app_initial_cdhash" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetDev -string "$app_target_dev" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetIno -string "$app_target_ino" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetCommit -string "$app_target_commit" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetFingerprint -string "$app_target_fingerprint" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appTargetCdHash -string "$app_target_cdhash" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
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
  [[ "$(json_value "$root_recovery_authorization_path" kind)" == "${SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND}" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryManifestPath)" == "$global_update_manifest_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryPolicyPath)" == "$global_update_policy_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" recoveryAppPath)" == "$app_path" ]] || return 1
  [[ "$(json_value "$root_recovery_authorization_path" appInitialPresent)" == "true" ]]
}

unique_exact_main_pid() {
  local matching_pids=$(/usr/bin/pgrep -U "$target_uid" -f "$exact_main_process_pattern" 2>/dev/null) || return 1
  local matching_count=$(/usr/bin/printf '%s\n' "$matching_pids" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')
  [[ "$matching_count" == "1" ]] || return 1
  local main_pid=$(/usr/bin/printf '%s\n' "$matching_pids" | /usr/bin/awk 'NF { print $1; exit }')
  [[ "$main_pid" == <-> ]] || return 1
  local main_uid=$(/bin/ps -p "$main_pid" -o uid= 2>/dev/null | /usr/bin/xargs)
  local main_executable=$(/bin/ps -p "$main_pid" -o comm= 2>/dev/null | /usr/bin/xargs)
  local main_command=$(/bin/ps -ww -p "$main_pid" -o command= 2>/dev/null)
  [[ "$main_uid" == "$target_uid" ]] || return 1
  [[ "$main_executable" == "$executable_path" ]] || return 1
  [[ "$main_command" == "$exact_main_command" ]] || return 1
  /usr/bin/printf '%s' "$main_pid"
}

process_identity_matches() {
  local identity_pid="$1"
  local expected_uid="$2"
  local expected_ppid="$3"
  local expected_executable="$4"
  local expected_started="$5"
  local expected_command="$6"
  [[ "$identity_pid" == <-> && "$expected_ppid" == <-> && -n "$expected_started" ]] || return 1
  local started_before=$(/bin/ps -p "$identity_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  local observed_uid=$(/bin/ps -p "$identity_pid" -o uid= 2>/dev/null | /usr/bin/xargs)
  local observed_ppid=$(/bin/ps -p "$identity_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
  local observed_executable=$(/bin/ps -p "$identity_pid" -o comm= 2>/dev/null | /usr/bin/xargs)
  local observed_command=$(/bin/ps -ww -p "$identity_pid" -o command= 2>/dev/null)
  local started_after=$(/bin/ps -p "$identity_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  [[ "$started_before" == "$expected_started" && "$started_after" == "$expected_started" ]] || return 1
  [[ "$observed_uid" == "$expected_uid" && "$observed_ppid" == "$expected_ppid" ]] || return 1
  [[ "$observed_executable" == "$expected_executable" && "$observed_command" == "$expected_command" ]]
}

normal_updater_script_for_command() {
  local owner_executable="$1"
  local owner_command="$2"
  local parent_pid="$3"
  local marker_token="$4"
  if [[ "$owner_command" == "$owner_executable $packaged_updater_script_path --repo-root "* \
    && "$owner_command" == *" --app-path $app_path --parent-pid $parent_pid --user-data-dir $user_data_dir --status-path $update_status_path --log-path $update_log_path --lock-path $update_lock_path --lock-token $marker_token --expected-initial-commit "* \
    && "$owner_command" == *" --restart" ]]; then
    /usr/bin/printf '%s' "$packaged_updater_script_path"
    return 0
  fi
  if [[ "$owner_command" == "$owner_executable $local_updater_script_path --repo-root "* \
    && "$owner_command" == *" --app-path $app_path --parent-pid $parent_pid --user-data-dir $user_data_dir --node-path "* \
    && "$owner_command" == *" --status-path $update_status_path --log-path $update_log_path --expected-commit "* \
    && "$owner_command" == *" --lock-path $update_lock_path --lock-token $marker_token" ]]; then
    /usr/bin/printf '%s' "$local_updater_script_path"
    return 0
  fi
  return 1
}

verified_signed_script_hash() {
  local script_path="$1"
  [[ -f "$script_path" && ! -L "$script_path" ]] || return 1
  local app_dev=$(/usr/bin/stat -f '%d' "$app_path" 2>/dev/null)
  local app_ino=$(/usr/bin/stat -f '%i' "$app_path" 2>/dev/null)
  [[ "$app_dev" == <-> && "$app_ino" == <-> ]] || return 1
  local app_cdhash=$(verified_code_directory_hash "$app_path" "$app_dev" "$app_ino") || return 1
  local script_dev=$(/usr/bin/stat -f '%d' "$script_path" 2>/dev/null)
  local script_ino=$(/usr/bin/stat -f '%i' "$script_path" 2>/dev/null)
  local script_size=$(/usr/bin/stat -f '%z' "$script_path" 2>/dev/null)
  local script_mtime=$(/usr/bin/stat -f '%m' "$script_path" 2>/dev/null)
  local script_sha=$(sha256_file "$script_path")
  [[ "$script_dev" == <-> && "$script_ino" == <-> && "$script_size" == <-> && "$script_mtime" == <-> ]] || return 1
  [[ "\${#script_sha}" -eq 64 && "$script_sha" != *[^a-f0-9]* ]] || return 1
  [[ "$(verified_code_directory_hash "$app_path" "$app_dev" "$app_ino")" == "$app_cdhash" ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$script_path" 2>/dev/null)" == "$script_dev" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$script_path" 2>/dev/null)" == "$script_ino" ]] || return 1
  [[ "$(/usr/bin/stat -f '%z' "$script_path" 2>/dev/null)" == "$script_size" ]] || return 1
  [[ "$(/usr/bin/stat -f '%m' "$script_path" 2>/dev/null)" == "$script_mtime" ]] || return 1
  [[ "$(sha256_file "$script_path")" == "$script_sha" ]] || return 1
  /usr/bin/printf '%s:%s' "$app_cdhash" "$script_sha"
}

write_maintenance_authorization() {
  local authorization_mode="$1"
  local marker_token="$2"
  local marker_pid="$3"
  local owner_executable="$4"
  local owner_started="$5"
  local owner_command="$6"
  local parent_pid="$7"
  local parent_executable="$8"
  local parent_started="$9"
  local parent_command="\${10}"
  local updater_script_path="\${11}"
  local updater_script_sha="\${12}"
  local updater_app_cdhash="\${13}"
  local bootstrap_authorization_sha="\${14}"
  local grant_expires="\${15}"
  local authorization_tmp="\${root_authorization_path}.tmp.$$"
  /bin/rm -f "$authorization_tmp"
  /usr/bin/plutil -create xml1 "$authorization_tmp" || return 1
  /usr/bin/plutil -insert kind -string "vigil-root-maintenance-authorization-v2" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert authorizationMode -string "$authorization_mode" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert token -string "$marker_token" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert pid -integer "$marker_pid" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert lockPath -string "$update_lock_path" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterExecutable -string "$owner_executable" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterStarted -string "$owner_started" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterCommand -string "$owner_command" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterScriptPath -string "$updater_script_path" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterScriptSha256 -string "$updater_script_sha" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert updaterAppCdHash -string "$updater_app_cdhash" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert parentPid -integer "$parent_pid" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert parentExecutable -string "$parent_executable" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert parentStarted -string "$parent_started" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert parentCommand -string "$parent_command" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert bootstrapAuthorizationSha256 -string "$bootstrap_authorization_sha" "$authorization_tmp" || return 1
  /usr/bin/plutil -insert expiresAtEpoch -integer "$grant_expires" "$authorization_tmp" || return 1
  /usr/sbin/chown 0:0 "$authorization_tmp" || return 1
  /bin/chmod 0644 "$authorization_tmp" || return 1
  /bin/mv -f "$authorization_tmp" "$root_authorization_path"
}

validate_bootstrap_authorization() {
  local now="$1"
  local request_bootstrap_token="$2"
  local request_source_app="$3"
  local request_target_app="$4"
  local request_expected_commit="$5"
  private_root_file "$bootstrap_authorization_path" 644 || return 1
  local authorization_dev=$(/usr/bin/stat -f '%d' "$bootstrap_authorization_path" 2>/dev/null)
  local authorization_ino=$(/usr/bin/stat -f '%i' "$bootstrap_authorization_path" 2>/dev/null)
  local authorization_size=$(/usr/bin/stat -f '%z' "$bootstrap_authorization_path" 2>/dev/null)
  local authorization_modified=$(/usr/bin/stat -f '%m' "$bootstrap_authorization_path" 2>/dev/null)
  [[ "$authorization_dev" == <-> && "$authorization_ino" == <-> && "$authorization_size" == <-> && "$authorization_size" -le 65536 && "$authorization_modified" == <-> ]] || return 1

  local authorization_kind=$(json_value "$bootstrap_authorization_path" kind)
  local authorization_token=$(json_value "$bootstrap_authorization_path" token)
  local source_app=$(json_value "$bootstrap_authorization_path" sourceAppPath)
  local target_app=$(json_value "$bootstrap_authorization_path" targetAppPath)
  local authorization_home=$(json_value "$bootstrap_authorization_path" targetHome)
  local authorization_uid=$(json_value "$bootstrap_authorization_path" targetUid)
  local authorization_user=$(json_value "$bootstrap_authorization_path" targetUser)
  local source_cdhash=$(json_value "$bootstrap_authorization_path" sourceCdHash)
  local target_cdhash=$(json_value "$bootstrap_authorization_path" targetCdHash)
  local source_commit=$(json_value "$bootstrap_authorization_path" sourceCommit)
  local source_fingerprint=$(json_value "$bootstrap_authorization_path" sourceFingerprint)
  local target_commit=$(json_value "$bootstrap_authorization_path" targetCommit)
  local target_fingerprint=$(json_value "$bootstrap_authorization_path" targetFingerprint)
  local updater_sha=$(json_value "$bootstrap_authorization_path" updaterScriptSha256)
  local bootstrap_sha=$(json_value "$bootstrap_authorization_path" bootstrapScriptSha256)
  local setup_sha=$(json_value "$bootstrap_authorization_path" setupScriptSha256)
  local bridge_manifest_sha=$(json_value "$bootstrap_authorization_path" bridgeManifestSha256)
  local bridge_equivalent_tree_sha=$(json_value "$bootstrap_authorization_path" bridgeEquivalentTreeSha256)
  local bridge_payload_tree_sha=$(json_value "$bootstrap_authorization_path" bridgePayloadTreeSha256)
  local bridge_wrappers_sha=$(json_value "$bootstrap_authorization_path" bridgeWrappersSha256)
  local bridge_baseline_build_info_sha=$(json_value "$bootstrap_authorization_path" bridgeBaselineBuildInfoSha256)
  local expected_commit=$(json_value "$bootstrap_authorization_path" expectedUpdateCommit)
  local authorization_created=$(json_value "$bootstrap_authorization_path" createdAtEpoch)
  local authorization_expires=$(json_value "$bootstrap_authorization_path" expiresAtEpoch)

  [[ "$authorization_kind" == "${UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND}" ]] || return 1
  [[ "$authorization_token" == "$request_bootstrap_token" ]] || return 1
  [[ "$source_app" == "$request_source_app" && "$target_app" == "$request_target_app" ]] || return 1
  [[ "$target_app" == "$app_path" && "$source_app" == /*.app && "$source_app" != "$target_app" ]] || return 1
  [[ "$authorization_home" == "$target_home" && "$authorization_uid" == "$target_uid" && "$authorization_user" == "$target_user" ]] || return 1
  [[ "$expected_commit" == "$request_expected_commit" && "\${#expected_commit}" -eq 40 && "$expected_commit" != *[^a-f0-9]* ]] || return 1
  [[ "\${#source_cdhash}" -ge 40 && "\${#source_cdhash}" -le 64 && "$source_cdhash" != *[^a-f0-9]* ]] || return 1
  [[ "\${#target_cdhash}" -ge 40 && "\${#target_cdhash}" -le 64 && "$target_cdhash" != *[^a-f0-9]* ]] || return 1
  [[ "\${#source_commit}" -eq 40 && "$source_commit" != *[^a-f0-9]* && "\${#target_commit}" -eq 40 && "$target_commit" != *[^a-f0-9]* ]] || return 1
  [[ "\${#source_fingerprint}" -eq 64 && "$source_fingerprint" != *[^a-f0-9]* && "\${#target_fingerprint}" -eq 64 && "$target_fingerprint" != *[^a-f0-9]* ]] || return 1
  local expected_sha
  for expected_sha in \
    "$updater_sha" "$bootstrap_sha" "$setup_sha" \
    "$bridge_manifest_sha" "$bridge_equivalent_tree_sha" "$bridge_payload_tree_sha" \
    "$bridge_wrappers_sha" "$bridge_baseline_build_info_sha"; do
    [[ "\${#expected_sha}" -eq 64 && "$expected_sha" != *[^a-f0-9]* ]] || return 1
  done
  [[ "$authorization_created" == <-> && "$authorization_expires" == <-> ]] || return 1
  (( authorization_created <= now && authorization_created >= authorization_modified - 5 )) || return 1
  (( authorization_expires >= now && authorization_expires <= authorization_modified + ${UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS} )) || return 1

  local source_dev=$(/usr/bin/stat -f '%d' "$source_app" 2>/dev/null)
  local source_ino=$(/usr/bin/stat -f '%i' "$source_app" 2>/dev/null)
  local target_dev=$(/usr/bin/stat -f '%d' "$target_app" 2>/dev/null)
  local target_ino=$(/usr/bin/stat -f '%i' "$target_app" 2>/dev/null)
  [[ "$source_dev" == <-> && "$source_ino" == <-> && "$target_dev" == <-> && "$target_ino" == <-> ]] || return 1
  app_content_matches "$source_app" "$source_commit" "$source_fingerprint" "$source_cdhash" "$source_dev" "$source_ino" || return 1
  app_content_matches "$target_app" "$target_commit" "$target_fingerprint" "$target_cdhash" "$target_dev" "$target_ino" || return 1

  local updater_script="$source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/update-packaged-app.mjs"
  local bootstrap_script="$source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/bootstrap-update-protocol.mjs"
  local setup_script="$source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/setup-system-guardian.mjs"
  local bridge_manifest="$source_app/Contents/Resources/VigilUpdater/bridge-equivalence-v1.json"
  local script_path
  for script_path in "$updater_script" "$bootstrap_script" "$setup_script"; do
    [[ -f "$script_path" && ! -L "$script_path" ]] || return 1
  done
  [[ "$(sha256_file "$updater_script")" == "$updater_sha" ]] || return 1
  [[ "$(sha256_file "$bootstrap_script")" == "$bootstrap_sha" ]] || return 1
  [[ "$(sha256_file "$setup_script")" == "$setup_sha" ]] || return 1
  [[ -f "$bridge_manifest" && ! -L "$bridge_manifest" ]] || return 1
  [[ "$(sha256_file "$bridge_manifest")" == "$bridge_manifest_sha" ]] || return 1
  [[ "$(json_value "$bridge_manifest" kind)" == "vigil-update-protocol-bridge-equivalence-v1" ]] || return 1
  [[ "$(json_value "$bridge_manifest" version)" == "1" && "$(json_value "$bridge_manifest" payloadVersion)" == "3" ]] || return 1
  [[ "$(json_value "$bridge_manifest" equivalentTreeSha256)" == "$bridge_equivalent_tree_sha" ]] || return 1
  [[ "$(json_value "$bridge_manifest" payloadTreeSha256)" == "$bridge_payload_tree_sha" ]] || return 1
  [[ "$(json_value "$bridge_manifest" wrappersSha256)" == "$bridge_wrappers_sha" ]] || return 1
  [[ "$(json_value "$bridge_manifest" baselineBuildInfoSha256)" == "$bridge_baseline_build_info_sha" ]] || return 1
  [[ "$(json_value "$bridge_manifest" payloadRoot)" == "Contents/Resources/VigilUpdater/v3/$bridge_payload_tree_sha" ]] || return 1
  [[ -d "$source_app/Contents/Resources/VigilUpdater/v3/$bridge_payload_tree_sha" \
    && ! -L "$source_app/Contents/Resources/VigilUpdater/v3/$bridge_payload_tree_sha" ]] || return 1
  app_content_matches "$source_app" "$source_commit" "$source_fingerprint" "$source_cdhash" "$source_dev" "$source_ino" || return 1
  app_content_matches "$target_app" "$target_commit" "$target_fingerprint" "$target_cdhash" "$target_dev" "$target_ino" || return 1

  local authorization_sha=$(sha256_file "$bootstrap_authorization_path")
  [[ "\${#authorization_sha}" -eq 64 && "$authorization_sha" != *[^a-f0-9]* ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$bootstrap_authorization_path" 2>/dev/null)" == "$authorization_dev" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$bootstrap_authorization_path" 2>/dev/null)" == "$authorization_ino" ]] || return 1
  [[ "$(/usr/bin/stat -f '%z' "$bootstrap_authorization_path" 2>/dev/null)" == "$authorization_size" ]] || return 1
  [[ "$(/usr/bin/stat -f '%m' "$bootstrap_authorization_path" 2>/dev/null)" == "$authorization_modified" ]] || return 1
  [[ "$(sha256_file "$bootstrap_authorization_path")" == "$authorization_sha" ]] || return 1

  bootstrap_authorization_sha="$authorization_sha"
  bootstrap_authorization_expires="$authorization_expires"
  bootstrap_source_cdhash="$source_cdhash"
  bootstrap_target_cdhash="$target_cdhash"
  bootstrap_source_commit="$source_commit"
  bootstrap_source_fingerprint="$source_fingerprint"
  bootstrap_target_commit="$target_commit"
  bootstrap_target_fingerprint="$target_fingerprint"
  bootstrap_updater_sha="$updater_sha"
  bootstrap_script_sha="$bootstrap_sha"
  bootstrap_setup_sha="$setup_sha"
  bootstrap_bridge_manifest_sha="$bridge_manifest_sha"
  bootstrap_bridge_equivalent_tree_sha="$bridge_equivalent_tree_sha"
  bootstrap_bridge_payload_tree_sha="$bridge_payload_tree_sha"
  bootstrap_bridge_wrappers_sha="$bridge_wrappers_sha"
  bootstrap_bridge_baseline_build_info_sha="$bridge_baseline_build_info_sha"
  bootstrap_source_app="$source_app"
  bootstrap_target_app="$target_app"
  return 0
}

bootstrap_processes_match_request() {
  local request_worker_pid="$1"
  local request_relay_pid="$2"
  local request_bootstrap_token="$3"
  local request_lock_token="$4"
  local request_expected_commit="$5"
  local source_launcher="$bootstrap_source_app/Contents/MacOS/Vigil"
  local source_bootstrap_script="$bootstrap_source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/bootstrap-update-protocol.mjs"
  local source_setup_script="$bootstrap_source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/setup-system-guardian.mjs"
  local target_launcher="$bootstrap_target_app/Contents/MacOS/Vigil"
  local expected_worker_command="$source_launcher $source_bootstrap_script --source-app $bootstrap_source_app --target-app $bootstrap_target_app --bootstrap-token $request_bootstrap_token --expected-update-commit $request_expected_commit --lock-path $update_lock_path --lock-token $request_lock_token --transferred-lock true"
  local expected_relay_command="$target_launcher $source_setup_script --bootstrap-worker-relay true --source-app $bootstrap_source_app --target-app $bootstrap_target_app --bootstrap-token $request_bootstrap_token --expected-update-commit $request_expected_commit --lock-path $update_lock_path --lock-token $request_lock_token"
  local worker_started_before=$(/bin/ps -p "$request_worker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  local worker_uid=$(/bin/ps -p "$request_worker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)
  local worker_ppid=$(/bin/ps -p "$request_worker_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
  local worker_executable=$(/bin/ps -p "$request_worker_pid" -o comm= 2>/dev/null | /usr/bin/xargs)
  local worker_command=$(/bin/ps -ww -p "$request_worker_pid" -o command= 2>/dev/null)
  local worker_started_after=$(/bin/ps -p "$request_worker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  local relay_started_before=$(/bin/ps -p "$request_relay_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  local relay_uid=$(/bin/ps -p "$request_relay_pid" -o uid= 2>/dev/null | /usr/bin/xargs)
  local relay_executable=$(/bin/ps -p "$request_relay_pid" -o comm= 2>/dev/null | /usr/bin/xargs)
  local relay_command=$(/bin/ps -ww -p "$request_relay_pid" -o command= 2>/dev/null)
  local relay_started_after=$(/bin/ps -p "$request_relay_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  [[ "$request_worker_pid" == <-> && "$request_relay_pid" == <-> && "$request_worker_pid" != "$request_relay_pid" ]] || return 1
  [[ -n "$worker_started_before" && "$worker_started_before" == "$worker_started_after" ]] || return 1
  [[ -n "$relay_started_before" && "$relay_started_before" == "$relay_started_after" ]] || return 1
  [[ "$worker_uid" == "$target_uid" && "$worker_ppid" == "$request_relay_pid" ]] || return 1
  [[ "$worker_executable" == "$source_launcher" && "$worker_command" == "$expected_worker_command" ]] || return 1
  [[ "$relay_uid" == "$target_uid" && "$relay_executable" == "$target_launcher" && "$relay_command" == "$expected_relay_command" ]] || return 1
  bootstrap_worker_started="$worker_started_before"
  bootstrap_worker_executable="$worker_executable"
  bootstrap_worker_command="$worker_command"
  bootstrap_relay_started="$relay_started_before"
  bootstrap_relay_executable="$relay_executable"
  bootstrap_relay_command="$relay_command"
  return 0
}

bootstrap_claim_matches_at_path() {
  local claim_path="$1"
  local now="$2"
  local request_bootstrap_token="$3"
  local request_lock_token="$4"
  local request_source_app="$5"
  local request_target_app="$6"
  local request_expected_commit="$7"
  local request_worker_pid="$8"
  local request_relay_pid="$9"
  private_root_file "$claim_path" 644 || return 1
  local claim_modified=$(/usr/bin/stat -f '%m' "$claim_path" 2>/dev/null)
  local claim_expires=$(json_value "$claim_path" expiresAtEpoch)
  [[ "$(json_value "$claim_path" kind)" == "${UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND}" ]] || return 1
  [[ "$(json_value "$claim_path" bootstrapToken)" == "$request_bootstrap_token" ]] || return 1
  [[ "$(json_value "$claim_path" lockPath)" == "$update_lock_path" ]] || return 1
  [[ "$(json_value "$claim_path" lockToken)" == "$request_lock_token" ]] || return 1
  [[ "$(json_value "$claim_path" sourceAppPath)" == "$request_source_app" ]] || return 1
  [[ "$(json_value "$claim_path" targetAppPath)" == "$request_target_app" ]] || return 1
  [[ "$(json_value "$claim_path" expectedUpdateCommit)" == "$request_expected_commit" ]] || return 1
  [[ "$(json_value "$claim_path" workerPid)" == "$request_worker_pid" ]] || return 1
  [[ "$(json_value "$claim_path" relayPid)" == "$request_relay_pid" ]] || return 1
  [[ "$(json_value "$claim_path" workerStarted)" == "$bootstrap_worker_started" ]] || return 1
  [[ "$(json_value "$claim_path" workerCommand)" == "$bootstrap_worker_command" ]] || return 1
  [[ "$(json_value "$claim_path" relayStarted)" == "$bootstrap_relay_started" ]] || return 1
  [[ "$(json_value "$claim_path" relayCommand)" == "$bootstrap_relay_command" ]] || return 1
  [[ "$(json_value "$claim_path" bootstrapAuthorizationSha256)" == "$bootstrap_authorization_sha" ]] || return 1
  [[ "$claim_modified" == <-> && "$claim_expires" == <-> ]] || return 1
  (( claim_expires >= now && claim_expires <= claim_modified + ${UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS} )) || return 1
  process_identity_matches "$request_worker_pid" "$target_uid" "$request_relay_pid" "$bootstrap_worker_executable" "$bootstrap_worker_started" "$bootstrap_worker_command" || return 1
  local relay_ppid=$(/bin/ps -p "$request_relay_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
  [[ "$relay_ppid" == <-> ]] || return 1
  process_identity_matches "$request_relay_pid" "$target_uid" "$relay_ppid" "$bootstrap_relay_executable" "$bootstrap_relay_started" "$bootstrap_relay_command"
}

bootstrap_claim_matches() {
  bootstrap_claim_matches_at_path "$bootstrap_claim_path" "$@"
}

previous_bootstrap_claim_matches() {
  bootstrap_claim_matches_at_path "$previous_bootstrap_claim_path" "$@"
}

write_bootstrap_claim_at_path() {
  local claim_path="$1"
  local now="$2"
  local request_bootstrap_token="$3"
  local request_lock_token="$4"
  local request_source_app="$5"
  local request_target_app="$6"
  local request_expected_commit="$7"
  local request_worker_pid="$8"
  local request_relay_pid="$9"
  local claim_expires="\${10}"
  (( claim_expires >= now )) || return 1
  local claim_tmp="\${claim_path}.tmp.$$"
  /bin/rm -f "$claim_tmp"
  /usr/bin/plutil -create xml1 "$claim_tmp" || return 1
  /usr/bin/plutil -insert kind -string "${UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND}" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bootstrapToken -string "$request_bootstrap_token" "$claim_tmp" || return 1
  /usr/bin/plutil -insert lockPath -string "$update_lock_path" "$claim_tmp" || return 1
  /usr/bin/plutil -insert lockToken -string "$request_lock_token" "$claim_tmp" || return 1
  /usr/bin/plutil -insert sourceAppPath -string "$request_source_app" "$claim_tmp" || return 1
  /usr/bin/plutil -insert targetAppPath -string "$request_target_app" "$claim_tmp" || return 1
  /usr/bin/plutil -insert sourceCdHash -string "$bootstrap_source_cdhash" "$claim_tmp" || return 1
  /usr/bin/plutil -insert targetCdHash -string "$bootstrap_target_cdhash" "$claim_tmp" || return 1
  /usr/bin/plutil -insert sourceCommit -string "$bootstrap_source_commit" "$claim_tmp" || return 1
  /usr/bin/plutil -insert sourceFingerprint -string "$bootstrap_source_fingerprint" "$claim_tmp" || return 1
  /usr/bin/plutil -insert targetCommit -string "$bootstrap_target_commit" "$claim_tmp" || return 1
  /usr/bin/plutil -insert targetFingerprint -string "$bootstrap_target_fingerprint" "$claim_tmp" || return 1
  /usr/bin/plutil -insert updaterScriptSha256 -string "$bootstrap_updater_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bootstrapScriptSha256 -string "$bootstrap_script_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert setupScriptSha256 -string "$bootstrap_setup_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bridgeManifestSha256 -string "$bootstrap_bridge_manifest_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bridgeEquivalentTreeSha256 -string "$bootstrap_bridge_equivalent_tree_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bridgePayloadTreeSha256 -string "$bootstrap_bridge_payload_tree_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bridgeWrappersSha256 -string "$bootstrap_bridge_wrappers_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bridgeBaselineBuildInfoSha256 -string "$bootstrap_bridge_baseline_build_info_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert expectedUpdateCommit -string "$request_expected_commit" "$claim_tmp" || return 1
  /usr/bin/plutil -insert workerPid -integer "$request_worker_pid" "$claim_tmp" || return 1
  /usr/bin/plutil -insert workerStarted -string "$bootstrap_worker_started" "$claim_tmp" || return 1
  /usr/bin/plutil -insert workerCommand -string "$bootstrap_worker_command" "$claim_tmp" || return 1
  /usr/bin/plutil -insert relayPid -integer "$request_relay_pid" "$claim_tmp" || return 1
  /usr/bin/plutil -insert relayStarted -string "$bootstrap_relay_started" "$claim_tmp" || return 1
  /usr/bin/plutil -insert relayCommand -string "$bootstrap_relay_command" "$claim_tmp" || return 1
  /usr/bin/plutil -insert bootstrapAuthorizationSha256 -string "$bootstrap_authorization_sha" "$claim_tmp" || return 1
  /usr/bin/plutil -insert claimedAtEpoch -integer "$now" "$claim_tmp" || return 1
  /usr/bin/plutil -insert expiresAtEpoch -integer "$claim_expires" "$claim_tmp" || return 1
  /usr/sbin/chown 0:0 "$claim_tmp" || return 1
  /bin/chmod 0644 "$claim_tmp" || return 1
  /bin/mv -f "$claim_tmp" "$claim_path"
}

bootstrap_claim_path_is_replaceable() {
  local claim_path="$1"
  local request_bootstrap_token="$2"
  if [[ -e "$claim_path" || -L "$claim_path" ]]; then
    [[ -f "$claim_path" && ! -L "$claim_path" ]] || return 1
    [[ "$(/usr/bin/stat -f '%u' "$claim_path" 2>/dev/null)" == "0" ]] || return 1
    [[ "$(json_value "$claim_path" bootstrapToken)" != "$request_bootstrap_token" ]] || return 1
  fi
  return 0
}

ensure_bootstrap_claim_at_path() {
  local claim_path="$1"
  local now="$2"
  local request_bootstrap_token="$3"
  local request_lock_token="$4"
  local request_source_app="$5"
  local request_target_app="$6"
  local request_expected_commit="$7"
  local request_worker_pid="$8"
  local request_relay_pid="$9"
  local claim_expires="\${10}"
  if bootstrap_claim_matches_at_path "$claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid"; then
    return 0
  fi
  # A claim for this administrator-approved token is one-shot. A second
  # matching-looking relay or worker PID must fail closed rather than replace it.
  bootstrap_claim_path_is_replaceable "$claim_path" "$request_bootstrap_token" || return 1
  write_bootstrap_claim_at_path "$claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid" "$claim_expires" || return 1
  bootstrap_claim_matches_at_path "$claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid"
}

attest_bootstrap_worker_request() {
  local now="$1"
  private_target_file "$bootstrap_worker_request_path" 600 || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path" 2>/dev/null)" == "$target_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$update_lock_path" 2>/dev/null)" == "600" ]] || return 1
  local request_kind=$(json_value "$bootstrap_worker_request_path" kind)
  local request_bootstrap_token=$(json_value "$bootstrap_worker_request_path" bootstrapToken)
  local request_lock_path=$(json_value "$bootstrap_worker_request_path" lockPath)
  local request_lock_token=$(json_value "$bootstrap_worker_request_path" lockToken)
  local request_source_app=$(json_value "$bootstrap_worker_request_path" sourceAppPath)
  local request_target_app=$(json_value "$bootstrap_worker_request_path" targetAppPath)
  local request_expected_commit=$(json_value "$bootstrap_worker_request_path" expectedUpdateCommit)
  local request_worker_pid=$(json_value "$bootstrap_worker_request_path" workerPid)
  local request_relay_pid=$(json_value "$bootstrap_worker_request_path" relayPid)
  local request_expires=$(json_value "$bootstrap_worker_request_path" expiresAtEpoch)
  local request_modified=$(/usr/bin/stat -f '%m' "$bootstrap_worker_request_path" 2>/dev/null)
  local lock_token=$(json_value "$update_lock_path" token)
  [[ "$request_kind" == "${UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND}" ]] || return 1
  [[ "$request_lock_path" == "$update_lock_path" && -n "$request_lock_token" && "$request_lock_token" == "$lock_token" ]] || return 1
  [[ "$request_worker_pid" == <-> && "$request_relay_pid" == <-> ]] || return 1
  [[ "$request_expires" == <-> && "$request_modified" == <-> ]] || return 1
  (( request_expires >= now && request_expires <= request_modified + ${UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS} )) || return 1
  validate_bootstrap_authorization "$now" "$request_bootstrap_token" "$request_source_app" "$request_target_app" "$request_expected_commit" || return 1
  bootstrap_processes_match_request "$request_worker_pid" "$request_relay_pid" "$request_bootstrap_token" "$request_lock_token" "$request_expected_commit" || return 1
  local claim_expires=$(( now + ${UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS} ))
  (( request_expires < claim_expires )) && claim_expires="$request_expires"
  (( bootstrap_authorization_expires < claim_expires )) && claim_expires="$bootstrap_authorization_expires"
  (( claim_expires >= now )) || return 1
  local candidate_claim_path
  for candidate_claim_path in "$previous_bootstrap_claim_path" "$bootstrap_claim_path"; do
    if bootstrap_claim_matches_at_path "$candidate_claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid"; then
      local candidate_claim_expires=$(json_value "$candidate_claim_path" expiresAtEpoch)
      (( candidate_claim_expires < claim_expires )) && claim_expires="$candidate_claim_expires"
    else
      bootstrap_claim_path_is_replaceable "$candidate_claim_path" "$request_bootstrap_token" || return 1
    fi
  done
  # The historical claim is the compatibility boundary for the still-running
  # v3 guardian. Publish and validate it before the isolated v4 go-signal.
  ensure_bootstrap_claim_at_path "$previous_bootstrap_claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid" "$claim_expires" || return 1
  ensure_bootstrap_claim_at_path "$bootstrap_claim_path" "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid" "$claim_expires" || return 1
  previous_bootstrap_claim_matches "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid" \
    && bootstrap_claim_matches "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid"
}

legacy_maintenance_authorization_expires() {
  local now="$1"
  local expected_token="$2"
  local expected_pid="$3"
  private_root_file "$root_authorization_path" 644 || return 1
  [[ "$(json_value "$root_authorization_path" kind)" == "vigil-root-maintenance-authorization-v2" ]] || return 1
  [[ "$(json_value "$root_authorization_path" token)" == "$expected_token" ]] || return 1
  [[ "$(json_value "$root_authorization_path" pid)" == "$expected_pid" ]] || return 1
  [[ "$(json_value "$root_authorization_path" lockPath)" == "$update_lock_path" ]] || return 1
  [[ "$(json_value "$root_authorization_path" updaterExecutable)" == /* ]] || return 1
  [[ -n "$(json_value "$root_authorization_path" updaterStarted)" ]] || return 1
  # A sparse predecessor grant may be upgraded after the current guardian
  # independently revalidates the live updater. Any partially populated newer
  # schema is ambiguous and fails closed instead of being refreshed.
  local current_key
  for current_key in authorizationMode updaterCommand updaterScriptPath updaterScriptSha256 updaterAppCdHash parentPid parentExecutable parentStarted parentCommand bootstrapAuthorizationSha256; do
    [[ -z "$(json_value "$root_authorization_path" "$current_key")" ]] || return 1
  done
  local expires=$(json_value "$root_authorization_path" expiresAtEpoch)
  local modified=$(/usr/bin/stat -f '%m' "$root_authorization_path" 2>/dev/null)
  [[ "$expires" == <-> && "$modified" == <-> ]] || return 1
  (( expires >= now )) || return 1
  (( expires <= modified + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} )) || return 1
  /usr/bin/printf '%s' "$expires"
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
  # A loaded predecessor may have won the first-writer race with a sparse grant;
  # v4 upgrades only that exact legacy schema and retains its original deadline.
  local legacy_grant_expires=""
  if [[ -f "$root_authorization_path" && ! -L "$root_authorization_path" ]]; then
    local granted_token="$(json_value "$root_authorization_path" token)"
    local granted_pid="$(json_value "$root_authorization_path" pid)"
    local granted_lock_path="$(json_value "$root_authorization_path" lockPath)"
    if [[ "$granted_token" == "$marker_token" && "$granted_pid" == "$marker_pid" && "$granted_lock_path" == "$update_lock_path" ]]; then
      authenticated_maintenance_active "$now" && return 0
      legacy_grant_expires=$(legacy_maintenance_authorization_expires "$now" "$marker_token" "$marker_pid") || return 1
    fi
  fi

  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)"
  local owner_uid="$(/bin/ps -p "$marker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)"
  local owner_ppid="$(/bin/ps -p "$marker_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)"
  local owner_executable="$(/bin/ps -p "$marker_pid" -o comm= 2>/dev/null | /usr/bin/xargs)"
  local owner_command="$(/bin/ps -ww -p "$marker_pid" -o command= 2>/dev/null)"
  [[ "$owner_uid" == "$target_uid" && "$owner_ppid" == <-> ]] || return 1
  [[ "$owner_executable" == /* && -n "$owner_started" && -f "$owner_executable" && ! -L "$owner_executable" ]] || return 1
  process_identity_matches "$marker_pid" "$target_uid" "$owner_ppid" "$owner_executable" "$owner_started" "$owner_command" || return 1

  # The one-time bridge is intentionally separate from normal update grants.
  # Its root claim must already attest this exact relay/worker pair before the
  # user-owned updater lock can be transferred to the worker PID.
  local request_bootstrap_token=$(json_value "$bootstrap_worker_request_path" bootstrapToken)
  local request_lock_token=$(json_value "$bootstrap_worker_request_path" lockToken)
  local request_source_app=$(json_value "$bootstrap_worker_request_path" sourceAppPath)
  local request_target_app=$(json_value "$bootstrap_worker_request_path" targetAppPath)
  local request_expected_commit=$(json_value "$bootstrap_worker_request_path" expectedUpdateCommit)
  local request_worker_pid=$(json_value "$bootstrap_worker_request_path" workerPid)
  local request_relay_pid=$(json_value "$bootstrap_worker_request_path" relayPid)
  if [[ "$request_worker_pid" == "$marker_pid" && "$request_relay_pid" == "$owner_ppid" && "$request_lock_token" == "$marker_token" ]] \
    && attest_bootstrap_worker_request "$now" \
    && previous_bootstrap_claim_matches "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid" \
    && bootstrap_claim_matches "$now" "$request_bootstrap_token" "$request_lock_token" "$request_source_app" "$request_target_app" "$request_expected_commit" "$request_worker_pid" "$request_relay_pid"; then
    local bootstrap_grant_expires=$(( now + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} ))
    local bootstrap_claim_expires=$(json_value "$bootstrap_claim_path" expiresAtEpoch)
    local previous_bootstrap_claim_expires=$(json_value "$previous_bootstrap_claim_path" expiresAtEpoch)
    (( marker_expires < bootstrap_grant_expires )) && bootstrap_grant_expires="$marker_expires"
    (( bootstrap_authorization_expires < bootstrap_grant_expires )) && bootstrap_grant_expires="$bootstrap_authorization_expires"
    (( bootstrap_claim_expires < bootstrap_grant_expires )) && bootstrap_grant_expires="$bootstrap_claim_expires"
    (( previous_bootstrap_claim_expires < bootstrap_grant_expires )) && bootstrap_grant_expires="$previous_bootstrap_claim_expires"
    [[ "$legacy_grant_expires" == <-> ]] && (( legacy_grant_expires < bootstrap_grant_expires )) && bootstrap_grant_expires="$legacy_grant_expires"
    write_maintenance_authorization \
      "bootstrap" "$marker_token" "$marker_pid" \
      "$bootstrap_worker_executable" "$bootstrap_worker_started" "$bootstrap_worker_command" \
      "$request_relay_pid" "$bootstrap_relay_executable" "$bootstrap_relay_started" "$bootstrap_relay_command" \
      "$request_source_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/bootstrap-update-protocol.mjs" \
      "$bootstrap_script_sha" "$bootstrap_source_cdhash" "$bootstrap_authorization_sha" "$bootstrap_grant_expires"
    return $?
  fi

  # Normal maintenance is authorized only when the updater is a direct child
  # of the one unique exact background Vigil main process. A second Electron
  # launcher, node-mode relay, or script-bearing parent is never a main process.
  local main_pid=$(unique_exact_main_pid) || return 1
  [[ "$owner_ppid" == "$main_pid" ]] || return 1
  local parent_started="$(/bin/ps -p "$main_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)"
  [[ -n "$parent_started" ]] || return 1
  process_identity_matches "$main_pid" "$target_uid" "$(/bin/ps -p "$main_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)" "$executable_path" "$parent_started" "$exact_main_command" || return 1
  [[ "$(unique_exact_main_pid)" == "$main_pid" ]] || return 1
  local updater_script_path=$(normal_updater_script_for_command "$owner_executable" "$owner_command" "$main_pid" "$marker_token") || return 1
  local signed_script_identity=$(verified_signed_script_hash "$updater_script_path") || return 1
  local updater_app_cdhash="\${signed_script_identity%%:*}"
  local updater_script_sha="\${signed_script_identity#*:}"
  [[ "\${#updater_app_cdhash}" -ge 40 && "\${#updater_script_sha}" -eq 64 ]] || return 1
  local normal_grant_expires=$(( now + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} ))
  (( marker_expires < normal_grant_expires )) && normal_grant_expires="$marker_expires"
  [[ "$legacy_grant_expires" == <-> ]] && (( legacy_grant_expires < normal_grant_expires )) && normal_grant_expires="$legacy_grant_expires"
  write_maintenance_authorization \
    "normal" "$marker_token" "$marker_pid" "$owner_executable" "$owner_started" "$owner_command" \
    "$main_pid" "$executable_path" "$parent_started" "$exact_main_command" \
    "$updater_script_path" "$updater_script_sha" "$updater_app_cdhash" "-" \
    "$normal_grant_expires"
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
  local authorization_mode="$(json_value "$root_authorization_path" authorizationMode)"
  local authorization_executable="$(json_value "$root_authorization_path" updaterExecutable)"
  local authorization_started="$(json_value "$root_authorization_path" updaterStarted)"
  local authorization_command="$(json_value "$root_authorization_path" updaterCommand)"
  local authorization_script_path="$(json_value "$root_authorization_path" updaterScriptPath)"
  local authorization_script_sha="$(json_value "$root_authorization_path" updaterScriptSha256)"
  local authorization_app_cdhash="$(json_value "$root_authorization_path" updaterAppCdHash)"
  local authorization_parent_pid="$(json_value "$root_authorization_path" parentPid)"
  local authorization_parent_executable="$(json_value "$root_authorization_path" parentExecutable)"
  local authorization_parent_started="$(json_value "$root_authorization_path" parentStarted)"
  local authorization_parent_command="$(json_value "$root_authorization_path" parentCommand)"
  local authorization_bootstrap_sha="$(json_value "$root_authorization_path" bootstrapAuthorizationSha256)"
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
  [[ "$authorization_mode" == "normal" || "$authorization_mode" == "bootstrap" ]] || return 1
  [[ "$authorization_executable" == /* && -n "$authorization_started" && -n "$authorization_command" ]] || return 1
  [[ "$authorization_script_path" == /* && "\${#authorization_script_sha}" -eq 64 && "$authorization_script_sha" != *[^a-f0-9]* ]] || return 1
  [[ "\${#authorization_app_cdhash}" -ge 40 && "\${#authorization_app_cdhash}" -le 64 && "$authorization_app_cdhash" != *[^a-f0-9]* ]] || return 1
  [[ "$authorization_parent_pid" == <-> && "$authorization_parent_executable" == /* && -n "$authorization_parent_started" && -n "$authorization_parent_command" ]] || return 1
  [[ "$authorization_expires" == <-> && "$authorization_modified" == <-> ]] || return 1
  (( authorization_expires >= now )) || return 1
  (( authorization_expires <= authorization_modified + ${SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS} )) || return 1
  (( marker_expires >= now )) || return 1

  local owner_uid="$(/bin/ps -p "$marker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)"
  local owner_ppid="$(/bin/ps -p "$marker_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)"
  local owner_executable="$(/bin/ps -p "$marker_pid" -o comm= 2>/dev/null | /usr/bin/xargs)"
  local owner_started="$(/bin/ps -p "$marker_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)"
  local owner_command="$(/bin/ps -ww -p "$marker_pid" -o command= 2>/dev/null)"
  [[ "$owner_uid" == "$target_uid" ]] || return 1
  [[ "$owner_executable" == "$authorization_executable" ]] || return 1
  [[ "$owner_started" == "$authorization_started" ]] || return 1
  [[ "$owner_command" == "$authorization_command" ]] || return 1
  process_identity_matches "$marker_pid" "$target_uid" "$owner_ppid" "$authorization_executable" "$authorization_started" "$authorization_command" || return 1

  if [[ "$authorization_mode" == "bootstrap" ]]; then
    local active_claim_path
    for active_claim_path in "$previous_bootstrap_claim_path" "$bootstrap_claim_path"; do
      private_root_file "$active_claim_path" 644 || return 1
      [[ "$(json_value "$active_claim_path" kind)" == "${UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND}" ]] || return 1
      [[ "$(json_value "$active_claim_path" lockPath)" == "$update_lock_path" ]] || return 1
      [[ "$(json_value "$active_claim_path" lockToken)" == "$marker_token" ]] || return 1
      [[ "$(json_value "$active_claim_path" workerPid)" == "$marker_pid" ]] || return 1
      [[ "$(json_value "$active_claim_path" workerStarted)" == "$authorization_started" ]] || return 1
      [[ "$(json_value "$active_claim_path" workerCommand)" == "$authorization_command" ]] || return 1
      [[ "$(json_value "$active_claim_path" relayPid)" == "$authorization_parent_pid" ]] || return 1
      [[ "$(json_value "$active_claim_path" relayStarted)" == "$authorization_parent_started" ]] || return 1
      [[ "$(json_value "$active_claim_path" relayCommand)" == "$authorization_parent_command" ]] || return 1
      [[ "$(json_value "$active_claim_path" bootstrapAuthorizationSha256)" == "$authorization_bootstrap_sha" ]] || return 1
      local claim_expires=$(json_value "$active_claim_path" expiresAtEpoch)
      local claim_modified=$(/usr/bin/stat -f '%m' "$active_claim_path" 2>/dev/null)
      [[ "$claim_expires" == <-> && "$claim_modified" == <-> ]] || return 1
      (( claim_expires >= now && claim_expires <= claim_modified + ${UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS} )) || return 1
    done
    [[ "$(sha256_file "$bootstrap_authorization_path")" == "$authorization_bootstrap_sha" ]] || return 1
    [[ "$owner_ppid" == "$authorization_parent_pid" ]] || return 1
    local relay_ppid=$(/bin/ps -p "$authorization_parent_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
    [[ "$relay_ppid" == <-> ]] || return 1
    process_identity_matches "$authorization_parent_pid" "$target_uid" "$relay_ppid" "$authorization_parent_executable" "$authorization_parent_started" "$authorization_parent_command"
    return $?
  fi

  [[ "$authorization_bootstrap_sha" == "-" ]] || return 1
  [[ "$authorization_parent_executable" == "$executable_path" && "$authorization_parent_command" == "$exact_main_command" ]] || return 1
  [[ "$authorization_script_path" == "$packaged_updater_script_path" || "$authorization_script_path" == "$local_updater_script_path" ]] || return 1
  # The exact main must be the direct parent when the grant is created. Once
  # that authenticated updater asks the app to exit, the root-pinned grant may
  # outlive the parent briefly; PID reuse can never satisfy the stored start,
  # executable, and command identity.
  local live_parent_started=$(/bin/ps -p "$authorization_parent_pid" -o lstart= 2>/dev/null | /usr/bin/xargs)
  if [[ -n "$live_parent_started" ]]; then
    [[ "$owner_ppid" == "$authorization_parent_pid" ]] || return 1
    local parent_ppid=$(/bin/ps -p "$authorization_parent_pid" -o ppid= 2>/dev/null | /usr/bin/xargs)
    [[ "$parent_ppid" == <-> ]] || return 1
    process_identity_matches "$authorization_parent_pid" "$target_uid" "$parent_ppid" "$executable_path" "$authorization_parent_started" "$exact_main_command" || return 1
    [[ "$(unique_exact_main_pid)" == "$authorization_parent_pid" ]] || return 1
  fi
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
  # Bootstrap workers are independently root-attested before the setup process
  # is permitted to transfer its lock to the relay-reported worker PID.
  attest_bootstrap_worker_request "$now" >/dev/null 2>&1 || true
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
