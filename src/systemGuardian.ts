import { join } from "node:path";
import {
  SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
  defaultUpdaterLockPath,
  guardianMaintenanceMarkerPath
} from "./updateMaintenance.js";

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
  fi

  # Missing user supervision is repaired even while the app is alive. The -n
  # launch creates a short-lived secondary instance; Vigil's singleton handler
  # refreshes the exact signed-in-user supervisor and then exits that instance.
  if [[ "$maintenance_active" == false && "$supervisor_loaded" == false ]]; then
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
