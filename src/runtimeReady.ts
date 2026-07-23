import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME,
  UPDATE_RECOVERY_RUNTIME_DIRNAME,
  UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH
} from "./updateTransaction.js";

const RUNTIME_READY_FILENAME = "runtime-ready.json";
const RUNTIME_INTERRUPTION_FILENAME = "runtime-interruption.json";
const RUNTIME_INTERRUPTION_VERSION = 1;
const MAX_RUNTIME_INTERRUPTION_BYTES = 8 * 1024;
const PRIVATE_FILE_MODE = 0o600;

export interface RuntimeReadyRecord {
  pid: number;
  startedAt: string;
  appPath: string;
  transport: "in-app";
}

export type RuntimeInterruptionReason = "process-missing" | "process-identity-mismatch" | "invalid-ready-record";

export interface RuntimeInterruptionRecord extends RuntimeReadyRecord {
  version: 1;
  id: string;
  detectedAt: string;
  reason: RuntimeInterruptionReason;
}

export type RuntimeInterruptionInvalidReason =
  | "unsafe-file"
  | "oversized-file"
  | "unreadable-file"
  | "malformed-json"
  | "invalid-record";

export type RuntimeInterruptionReadResult =
  | { status: "missing" }
  | { status: "valid"; record: RuntimeInterruptionRecord }
  | { status: "invalid"; reason: RuntimeInterruptionInvalidReason };

export interface RuntimeSupervisorScriptOptions {
  markerPath: string;
  dataDir: string;
  appPath: string;
  executablePath: string;
  backgroundLaunchArg: string;
  safetyBoundaryArg: string;
  updateLockPath?: string;
}

export function runtimeReadyPath(dataDir: string): string {
  return join(dataDir, RUNTIME_READY_FILENAME);
}

export function runtimeInterruptionPath(dataDir: string): string {
  return join(dataDir, RUNTIME_INTERRUPTION_FILENAME);
}

export function runtimeInterruptionId(runtime: Pick<RuntimeReadyRecord, "pid" | "startedAt">): string {
  const pid = Number(runtime.pid);
  const startedAt = String(runtime.startedAt || "");
  if (!Number.isInteger(pid) || pid < 1 || !validTimestamp(startedAt)) {
    throw new Error("Vigil cannot identify an invalid runtime interruption record.");
  }
  return `runtime-interruption-v1:${pid}:${startedAt}`;
}

/**
 * The packaged supervisor and hardening diagnostics must use byte-identical
 * script text. Keeping the generator here also keeps the interruption record
 * schema beside its validator instead of duplicating shell protocol details.
 */
export function buildRuntimeSupervisorScript(options: RuntimeSupervisorScriptOptions): string {
  const ready = runtimeReadyPath(options.dataDir);
  const interruption = runtimeInterruptionPath(options.dataDir);
  const updateLockPath = options.updateLockPath
    || join(dirname(dirname(options.markerPath)), "updater", "update.lock");
  const maintenanceMarkerPath = join(dirname(updateLockPath), "guardian-maintenance.json");
  const updaterDir = dirname(updateLockPath);
  const updateRecoveryManifestPath = join(updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  const updateRecoveryPolicyPath = join(updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  const updateRecoveryScriptPath = join(
    updaterDir,
    UPDATE_RECOVERY_RUNTIME_DIRNAME,
    UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH
  );
  return `#!/bin/zsh
set -u
marker=${shellSingleQuote(options.markerPath)}
ready=${shellSingleQuote(ready)}
interruption=${shellSingleQuote(interruption)}
app_path=${shellSingleQuote(options.appPath)}
executable_path=${shellSingleQuote(options.executablePath)}
update_lock_path=${shellSingleQuote(updateLockPath)}
maintenance_marker_path=${shellSingleQuote(maintenanceMarkerPath)}
app_transaction_path="\${app_path}.vigil-transaction.json"
app_next_path="\${app_path}.vigil-next"
app_previous_path="\${app_path}.vigil-previous"
state_data_dir=${shellSingleQuote(options.dataDir)}
updater_dir=${shellSingleQuote(updaterDir)}
global_update_manifest_path=${shellSingleQuote(updateRecoveryManifestPath)}
global_update_policy_path=${shellSingleQuote(updateRecoveryPolicyPath)}
global_recovery_script_path=${shellSingleQuote(updateRecoveryScriptPath)}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

authenticated_update_active() {
  [[ -f "$maintenance_marker_path" && ! -L "$maintenance_marker_path" ]] || return 1
  [[ -f "$update_lock_path" && ! -L "$update_lock_path" ]] || return 1
  local current_uid=$(/usr/bin/id -u)
  [[ "$(/usr/bin/stat -f '%u' "$maintenance_marker_path" 2>/dev/null)" == "$current_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$update_lock_path" 2>/dev/null)" == "$current_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$maintenance_marker_path" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$update_lock_path" 2>/dev/null)" == "600" ]] || return 1

  local marker_kind=$(json_value "$maintenance_marker_path" kind)
  local marker_token=$(json_value "$maintenance_marker_path" token)
  local marker_pid=$(json_value "$maintenance_marker_path" pid)
  local marker_lock_path=$(json_value "$maintenance_marker_path" lockPath)
  local marker_expires=$(json_value "$maintenance_marker_path" expiresAtEpoch)
  local marker_modified=$(/usr/bin/stat -f '%m' "$maintenance_marker_path" 2>/dev/null)
  local lock_token=$(json_value "$update_lock_path" token)
  local lock_pid=$(json_value "$update_lock_path" pid)
  local now=$(/bin/date +%s)
  [[ "$marker_kind" == "vigil-maintenance-request-v2" ]] || return 1
  [[ -n "$marker_token" && "$marker_token" == "$lock_token" ]] || return 1
  [[ "$marker_pid" == <-> && "$marker_pid" == "$lock_pid" ]] || return 1
  [[ "$marker_lock_path" == "$update_lock_path" ]] || return 1
  [[ "$marker_expires" == <-> && "$marker_modified" == <-> ]] || return 1
  (( marker_expires >= now && marker_expires <= marker_modified + 600 )) || return 1

  local owner_uid=$(/bin/ps -p "$marker_pid" -o uid= 2>/dev/null | /usr/bin/xargs)
  local owner_command=$(/bin/ps -p "$marker_pid" -o command= 2>/dev/null)
  [[ "$owner_uid" == "$current_uid" ]] || return 1
  [[ "$owner_command" == *"--lock-path $update_lock_path"* ]] || return 1
  [[ "$owner_command" == *"--lock-token $marker_token"* ]] || return 1
}

global_update_manifest_present() {
  [[ -e "$global_update_manifest_path" || -L "$global_update_manifest_path" ]]
}

private_owned_regular_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  local current_uid=$(/usr/bin/id -u)
  [[ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" == "$current_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null)" == "600" ]]
}

valid_global_recovery_bootstrap() {
  private_owned_regular_file "$global_update_manifest_path" || return 1
  private_owned_regular_file "$global_update_policy_path" || return 1
  private_owned_regular_file "$global_recovery_script_path" || return 1

  local manifest_attempt=$(json_value "$global_update_manifest_path" attemptId)
  local manifest_policy=$(json_value "$global_update_manifest_path" recovery.policyPath)
  local manifest_node=$(json_value "$global_update_manifest_path" recovery.nodePath)
  local manifest_script=$(json_value "$global_update_manifest_path" recovery.scriptPath)
  local policy_attempt=$(json_value "$global_update_policy_path" attemptId)
  local policy_updater_dir=$(json_value "$global_update_policy_path" updaterDir)
  local policy_app_path=$(json_value "$global_update_policy_path" expectedAppPath)
  local policy_data_dir=$(json_value "$global_update_policy_path" expectedDataDir)
  local policy_node=$(json_value "$global_update_policy_path" recoveryRuntime.nodePath)
  local policy_script=$(json_value "$global_update_policy_path" recoveryRuntime.scriptPath)

  [[ -n "$manifest_attempt" && "$manifest_attempt" == "$policy_attempt" ]] || return 1
  [[ "$manifest_policy" == "$global_update_policy_path" ]] || return 1
  [[ "$policy_updater_dir" == "$updater_dir" ]] || return 1
  [[ "$policy_app_path" == "$app_path" ]] || return 1
  [[ "$policy_data_dir" == "$state_data_dir" ]] || return 1
  [[ "$manifest_node" == "$policy_node" && "$manifest_script" == "$policy_script" ]] || return 1
  [[ "$policy_script" == "$global_recovery_script_path" ]] || return 1
  [[ "$policy_node" == /* ]] || return 1
  [[ "$policy_node" != "$app_path" && "$policy_node" != "$app_path"/* ]] || return 1
  [[ "$policy_node" != "$app_next_path" && "$policy_node" != "$app_next_path"/* ]] || return 1
  [[ "$policy_node" != "$app_previous_path" && "$policy_node" != "$app_previous_path"/* ]] || return 1
  [[ "$policy_node" != "$updater_dir" && "$policy_node" != "$updater_dir"/* ]] || return 1
  [[ -f "$policy_node" && ! -L "$policy_node" && -x "$policy_node" ]] || return 1
  local current_uid=$(/usr/bin/id -u)
  local node_uid=$(/usr/bin/stat -f '%u' "$policy_node" 2>/dev/null)
  [[ "$node_uid" == "$current_uid" || "$node_uid" == "0" ]]
}

recover_global_update_transaction() {
  global_update_manifest_present || return 0
  valid_global_recovery_bootstrap || return 1
  local recovery_node_path=$(json_value "$global_update_policy_path" recoveryRuntime.nodePath)
  local recovery_mode="\${1:-}"
  if [[ -z "$recovery_mode" ]]; then
    "$recovery_node_path" "$global_recovery_script_path" --policy-file "$global_update_policy_path" || return 1
  elif [[ "$recovery_mode" == "--live-runtime" ]]; then
    "$recovery_node_path" "$global_recovery_script_path" --policy-file "$global_update_policy_path" --live-runtime || return 1
  else
    return 1
  fi
  ! global_update_manifest_present
}

global_update_can_roll_forward_with_live_runtime() {
  valid_global_recovery_bootstrap || return 1
  local transaction_state=$(json_value "$global_update_manifest_path" state)
  [[ "$transaction_state" == "commit-intent" || "$transaction_state" == "committed" ]]
}

valid_app_transaction() {
  [[ -f "$app_transaction_path" && ! -L "$app_transaction_path" ]] || return 1
  local current_uid=$(/usr/bin/id -u)
  [[ "$(/usr/bin/stat -f '%u' "$app_transaction_path" 2>/dev/null)" == "$current_uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$app_transaction_path" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(json_value "$app_transaction_path" version)" == "2" ]] || return 1
  [[ "$(json_value "$app_transaction_path" targetPath)" == "$app_path" ]] || return 1
  [[ "$(json_value "$app_transaction_path" nextPath)" == "$app_next_path" ]] || return 1
  [[ "$(json_value "$app_transaction_path" previousPath)" == "$app_previous_path" ]] || return 1
  local phase=$(json_value "$app_transaction_path" phase)
  [[ "$phase" == "preparing" || "$phase" == "prepared" || "$phase" == "swapping" || "$phase" == "backing-up" || "$phase" == "installed" || "$phase" == "verified" || "$phase" == "rolling-back" || "$phase" == "finalizing" ]]
}

path_matches_candidate() {
  local candidate_path="$1"
  [[ -e "$candidate_path" && ! -L "$candidate_path" ]] || return 1
  local expected_device=$(json_value "$app_transaction_path" candidateDevice)
  local expected_inode=$(json_value "$app_transaction_path" candidateInode)
  [[ "$expected_device" == <-> && "$expected_inode" == <-> ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$candidate_path" 2>/dev/null)" == "$expected_device" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$candidate_path" 2>/dev/null)" == "$expected_inode" ]]
}

path_matches_initial() {
  local initial_path="$1"
  [[ -e "$initial_path" && ! -L "$initial_path" ]] || return 1
  [[ "$(json_value "$app_transaction_path" initialPresent)" == "true" ]] || return 1
  local expected_device=$(json_value "$app_transaction_path" initialDevice)
  local expected_inode=$(json_value "$app_transaction_path" initialInode)
  [[ "$expected_device" == <-> && "$expected_inode" == <-> ]] || return 1
  [[ "$(/usr/bin/stat -f '%d' "$initial_path" 2>/dev/null)" == "$expected_device" ]] || return 1
  [[ "$(/usr/bin/stat -f '%i' "$initial_path" 2>/dev/null)" == "$expected_inode" ]]
}

verified_app_transaction_topology() {
  path_matches_candidate "$app_path" || return 1
  local sidecar
  for sidecar in "$app_previous_path" "$app_next_path"; do
    [[ -e "$sidecar" || -L "$sidecar" ]] || continue
    [[ -e "$sidecar" && ! -L "$sidecar" ]] || return 1
    path_matches_candidate "$sidecar" || path_matches_initial "$sidecar" || return 1
  done
}

swap_app_paths() {
  local left="$1"
  local right="$2"
  local canonical_helper="\${app_path}/Contents/Resources/app.asar.unpacked/dist/runtime/bin/vigil-atomic-swap"
  local previous_helper="\${app_previous_path}/Contents/Resources/app.asar.unpacked/dist/runtime/bin/vigil-atomic-swap"
  local helper=""
  if [[ -f "$canonical_helper" && ! -L "$canonical_helper" && -x "$canonical_helper" ]]; then
    helper="$canonical_helper"
  elif [[ -f "$previous_helper" && ! -L "$previous_helper" && -x "$previous_helper" ]]; then
    helper="$previous_helper"
  else
    return 1
  fi
  "$helper" "$left" "$right"
}

clear_app_transaction_residue() {
  /bin/rm -rf "$app_previous_path" "$app_next_path" || return 1
  cleanup_attached_state_snapshot || return 1
  /bin/rm -f "$app_transaction_path" || return 1
  /bin/sync
}

attached_state_snapshot_root() {
  local recorded_data_dir=$(json_value "$app_transaction_path" stateDataDir)
  local snapshot_root=$(json_value "$app_transaction_path" stateSnapshotRoot)
  if [[ -z "$recorded_data_dir" && -z "$snapshot_root" ]]; then
    return 1
  fi
  [[ "$recorded_data_dir" == "$state_data_dir" ]] || return 2
  [[ "$snapshot_root" == "$updater_dir"/state-before-update-* ]] || return 2
  if [[ -e "$snapshot_root" || -L "$snapshot_root" ]]; then
    [[ -d "$snapshot_root" && ! -L "$snapshot_root" ]] || return 2
    local current_uid=$(/usr/bin/id -u)
    [[ "$(/usr/bin/stat -f '%u' "$snapshot_root" 2>/dev/null)" == "$current_uid" ]] || return 2
  fi
  /usr/bin/printf '%s' "$snapshot_root"
}

restore_attached_state_snapshot() {
  local snapshot_root=$(attached_state_snapshot_root)
  local snapshot_status=$?
  [[ "$snapshot_status" -eq 1 ]] && return 0
  [[ "$snapshot_status" -eq 0 && -n "$snapshot_root" ]] || return 1
  [[ -d "$snapshot_root" && ! -L "$snapshot_root" ]] || return 1
  local state_files=(
    state.json state.seal.json state-seal.key usage.json usage.seal.json
    runtime-snapshot.wal.json runtime-effects.json runtime-usage.checkpoint.json
    runtime-interruption.json journal-encryption.key
  )
  /bin/mkdir -p "$state_data_dir" || return 1
  local name source destination temporary
  for name in "\${state_files[@]}"; do
    source="\${snapshot_root}/\${name}"
    destination="\${state_data_dir}/\${name}"
    temporary="\${destination}.$$.update-rollback"
    /bin/rm -f "$temporary"
    [[ -L "$source" ]] && return 1
    [[ -e "$source" && ! -f "$source" ]] && return 1
    if [[ -f "$source" && ! -L "$source" ]]; then
      /bin/cp -p "$source" "$temporary" || return 1
      /bin/sync || { /bin/rm -f "$temporary"; return 1; }
      /bin/mv -f "$temporary" "$destination" || return 1
    else
      /bin/rm -f "$destination" || return 1
    fi
  done
  /bin/sync
}

cleanup_attached_state_snapshot() {
  local snapshot_root=$(attached_state_snapshot_root)
  local snapshot_status=$?
  [[ "$snapshot_status" -eq 1 ]] && return 0
  [[ "$snapshot_status" -eq 0 && -n "$snapshot_root" ]] || return 1
  /bin/rm -rf "$snapshot_root"
}

write_app_transaction_phase() {
  local next_phase="$1"
  local transaction_id=$(json_value "$app_transaction_path" id)
  [[ -n "$transaction_id" ]] || return 1
  local temporary="\${app_transaction_path}.\${transaction_id}.$$.phase"
  /bin/rm -f "$temporary"
  /bin/cp -p "$app_transaction_path" "$temporary" || return 1
  /usr/bin/plutil -replace phase -string "$next_phase" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -replace updatedAt -string "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/chmod 0600 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/sync || { /bin/rm -f "$temporary"; return 1; }
  /bin/mv -f "$temporary" "$app_transaction_path" || return 1
  /bin/sync
}

mark_running_candidate_verified() {
  # The global transaction owns every artifact while its manifest exists. The
  # legacy app-only journal must never independently promote or clean up a copy
  # that global rollback may still need.
  global_update_manifest_present && return 0
  [[ -e "$app_transaction_path" || -L "$app_transaction_path" ]] || return 0
  valid_app_transaction || return 1
  local phase=$(json_value "$app_transaction_path" phase)
  [[ "$phase" == "verified" || "$phase" == "finalizing" ]] && return 0
  path_matches_candidate "$app_path" || return 1
  write_app_transaction_phase verified
}

reconcile_interrupted_app_update() {
  global_update_manifest_present && return 1
  [[ -e "$app_transaction_path" || -L "$app_transaction_path" ]] || return 0
  valid_app_transaction || return 1
  local phase=$(json_value "$app_transaction_path" phase)
  if [[ "$phase" == "verified" || "$phase" == "finalizing" ]]; then
    # A phase string is not generation proof. Refuse to discard either
    # sidecar unless the canonical path is still the pinned candidate and all
    # residue is one of the two exact journaled generations.
    verified_app_transaction_topology || return 1
    clear_app_transaction_residue
    return $?
  fi

  if [[ "$phase" == "preparing" && ! -e "$app_previous_path" && ! -L "$app_previous_path" ]]; then
    local initial_present=$(json_value "$app_transaction_path" initialPresent)
    if { [[ "$initial_present" == "true" ]] && path_matches_initial "$app_path"; } \
      || { [[ "$initial_present" == "false" ]] && [[ ! -e "$app_path" && ! -L "$app_path" ]]; }; then
      if [[ -e "$app_next_path" || -L "$app_next_path" ]]; then
        # A preparing journal does not yet contain a candidate identity. Move
        # partial bytes out of the canonical staging name instead of deleting
        # evidence that cannot be proved to be either journaled generation.
        local partial_uuid=$(/usr/bin/uuidgen 2>/dev/null)
        [[ -n "$partial_uuid" ]] || return 1
        local partial_path="\${app_next_path}.partial.\${partial_uuid}"
        [[ ! -e "$partial_path" && ! -L "$partial_path" ]] || return 1
        /bin/mv "$app_next_path" "$partial_path" || return 1
      fi
      cleanup_attached_state_snapshot || return 1
      /bin/rm -f "$app_transaction_path" || return 1
      /bin/sync
      return $?
    fi
  fi

  # State is restored first and idempotently. If power is lost during this
  # loop, the previous bundle remains available and the next supervisor launch
  # repeats the same snapshot before changing the canonical app path.
  write_app_transaction_phase rolling-back || return 1
  restore_attached_state_snapshot || return 1

  local target_exists=false
  local next_exists=false
  local previous_exists=false
  [[ -e "$app_path" && ! -L "$app_path" ]] && target_exists=true
  [[ -e "$app_next_path" && ! -L "$app_next_path" ]] && next_exists=true
  [[ -e "$app_previous_path" && ! -L "$app_previous_path" ]] && previous_exists=true

  if [[ "$previous_exists" == true ]]; then
    # Every extant sidecar must be one of the two exact journaled generations
    # before any swap, move, deletion, or journal removal is attempted.
    { path_matches_initial "$app_previous_path" || path_matches_candidate "$app_previous_path"; } || return 1
    if [[ "$next_exists" == true ]]; then
      { path_matches_initial "$app_next_path" || path_matches_candidate "$app_next_path"; } || return 1
    fi
    if [[ "$target_exists" == true ]]; then
      if path_matches_candidate "$app_path" && path_matches_initial "$app_previous_path"; then
        # The candidate is still canonical: restore the known-good previous
        # generation. If power is lost after the swap, the inverse topology is
        # recognized by the branch below instead of being swapped back again.
        swap_app_paths "$app_path" "$app_previous_path" || return 1
        /bin/rm -rf "$app_previous_path" || return 1
      elif path_matches_candidate "$app_previous_path" && path_matches_initial "$app_path"; then
        # Rollback already completed and only candidate residue remains. Never
        # undo that completed rollback on a supervisor retry.
        /bin/rm -rf "$app_previous_path" || return 1
      else
        return 1
      fi
    else
      path_matches_initial "$app_previous_path" || return 1
      /bin/mv "$app_previous_path" "$app_path" || return 1
    fi
    /bin/rm -rf "$app_next_path" || return 1
    cleanup_attached_state_snapshot || return 1
    /bin/rm -f "$app_transaction_path" || return 1
    /bin/sync
    return $?
  fi

  if [[ "$target_exists" == true && "$next_exists" == true ]]; then
    if path_matches_candidate "$app_next_path" && path_matches_initial "$app_path"; then
      /bin/rm -rf "$app_next_path" || return 1
    elif path_matches_candidate "$app_path" && path_matches_initial "$app_next_path"; then
      swap_app_paths "$app_path" "$app_next_path" || return 1
      /bin/rm -rf "$app_next_path" || return 1
    else
      return 1
    fi
    cleanup_attached_state_snapshot || return 1
    /bin/rm -f "$app_transaction_path" || return 1
    /bin/sync
    return $?
  fi

  if [[ "$target_exists" == true && "$next_exists" == false ]]; then
    local initial_present=$(json_value "$app_transaction_path" initialPresent)
    if [[ "$initial_present" == "true" ]] && path_matches_initial "$app_path"; then
      cleanup_attached_state_snapshot || return 1
      /bin/rm -f "$app_transaction_path" || return 1
      /bin/sync
      return $?
    fi
    if [[ "$initial_present" == "false" ]] && path_matches_candidate "$app_path"; then
      /bin/rm -rf "$app_path" || return 1
      cleanup_attached_state_snapshot || return 1
      /bin/rm -f "$app_transaction_path" || return 1
      /bin/sync
      return $?
    fi
    # An installed candidate without its promised previous generation is not a
    # safe recovery source, and an arbitrary target must never be mistaken for
    # the initial generation. Preserve all evidence for the updater/guardian.
    return 1
  fi
  return 1
}

reopen_vigil() {
  authenticated_update_active && return 1
  if ! recover_global_update_transaction; then
    /usr/bin/printf '%s\n' "Vigil preserved the interrupted global update because durable recovery did not complete." >&2
    return 1
  fi
  authenticated_update_active && return 1
  if ! reconcile_interrupted_app_update; then
    /usr/bin/printf '%s\n' "Vigil preserved an ambiguous interrupted app update instead of launching an unverified bundle." >&2
    return 1
  fi
  /usr/bin/open -g "$app_path" --args ${shellSingleQuote(options.backgroundLaunchArg)} ${shellSingleQuote(options.safetyBoundaryArg)}
}

preserve_interruption() {
  local stale_pid="$1"
  local stale_started_at="$2"
  local reason="$3"
  if [[ "$stale_pid" != <-> ]] || [[ -z "$stale_started_at" ]]; then
    return 1
  fi
  local interruption_id="runtime-interruption-v1:\${stale_pid}:\${stale_started_at}"
  if [[ -e "$interruption" || -L "$interruption" ]]; then
    if existing_interruption_matches "$interruption_id"; then
      /bin/sync || return 1
      return 0
    fi
    archive_existing_interruption || return 1
  fi
  local detected_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
  local temporary="\${interruption}.$$.tmp"
  /bin/rm -f "$temporary"
  /usr/bin/plutil -create json "$temporary" || return 1
  /usr/bin/plutil -insert version -integer ${RUNTIME_INTERRUPTION_VERSION} "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert id -string "$interruption_id" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert pid -integer "$stale_pid" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert startedAt -string "$stale_started_at" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appPath -string "$executable_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert transport -string "in-app" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert detectedAt -string "$detected_at" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert reason -string "$reason" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/chmod 0600 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/sync || { /bin/rm -f "$temporary"; return 1; }
  if [[ -e "$interruption" || -L "$interruption" ]]; then
    if existing_interruption_matches "$interruption_id"; then
      /bin/rm -f "$temporary"
      /bin/sync || return 1
      return 0
    fi
    archive_existing_interruption || { /bin/rm -f "$temporary"; return 1; }
  fi
  /bin/mv -f "$temporary" "$interruption" || return 1
  /bin/sync
}

existing_interruption_matches() {
  local expected_id="$1"
  if [[ ! -f "$interruption" ]] || [[ -L "$interruption" ]]; then
    return 1
  fi
  local existing_mode=$(/usr/bin/stat -f '%Lp' "$interruption" 2>/dev/null)
  local existing_owner=$(/usr/bin/stat -f '%u' "$interruption" 2>/dev/null)
  local existing_size=$(/usr/bin/stat -f '%z' "$interruption" 2>/dev/null)
  local current_owner=$(/usr/bin/id -u)
  if [[ "$existing_mode" != "600" ]] || [[ "$existing_owner" != "$current_owner" ]] || [[ "$existing_size" != <-> ]] || (( existing_size > ${MAX_RUNTIME_INTERRUPTION_BYTES} )); then
    return 1
  fi
  local existing_id=$(/usr/bin/plutil -extract id raw -o - "$interruption" 2>/dev/null)
  [[ "$existing_id" == "$expected_id" ]]
}

archive_existing_interruption() {
  if [[ ! -e "$interruption" ]] && [[ ! -L "$interruption" ]]; then
    return 0
  fi
  local archived_at=$(/bin/date -u '+%Y%m%dT%H%M%SZ')
  local archive_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  if [[ -z "$archive_uuid" ]]; then
    return 1
  fi
  local archive_path="\${interruption}.conflict.\${archived_at}.\${archive_uuid}"
  if [[ -e "$archive_path" || -L "$archive_path" ]]; then
    return 1
  fi
  /bin/mv "$interruption" "$archive_path"
}

archive_invalid_ready() {
  if [[ ! -e "$ready" ]] && [[ ! -L "$ready" ]]; then
    return 0
  fi
  local archived_at=$(/bin/date -u '+%Y%m%dT%H%M%SZ')
  local archive_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  if [[ -z "$archive_uuid" ]]; then
    return 1
  fi
  local archive_path="\${ready}.invalid.\${archived_at}.\${archive_uuid}"
  if [[ -e "$archive_path" || -L "$archive_path" ]]; then
    return 1
  fi
  /bin/mv "$ready" "$archive_path" || return 1
  /bin/sync
}

pid=""
started_at=""
ready_app_path=""
ready_transport=""
ready_loaded=false
global_recovery_notice=""
while [[ -e "$marker" ]]; do
  # Keep restart protection online throughout an authenticated update. While
  # the exact updater owns its bounded maintenance transaction, avoid racing
  # its atomic replacement. The instant that owner disappears or its grant
  # expires, normal recovery resumes without relying on the replaceable app.
  if authenticated_update_active; then
    # The updater removes the old receipt and the replacement writes a new one
    # while this loop deliberately sleeps. Invalidate the cached identity so we
    # never delete or diagnose the replacement using the pre-update PID.
    pid=""
    started_at=""
    ready_app_path=""
    ready_transport=""
    ready_loaded=false
    global_recovery_notice=""
    /bin/sleep 1
    continue
  fi
  command=""
  ready_exists=false
  if [[ "$ready_loaded" == true ]]; then
    ready_exists=true
  elif [[ -e "$ready" || -L "$ready" ]]; then
    ready_exists=true
    pid=""
    started_at=""
    ready_app_path=""
    ready_transport=""
    pid=$(/usr/bin/plutil -extract pid raw -o - "$ready" 2>/dev/null)
    started_at=$(/usr/bin/plutil -extract startedAt raw -o - "$ready" 2>/dev/null)
    ready_app_path=$(/usr/bin/plutil -extract appPath raw -o - "$ready" 2>/dev/null)
    ready_transport=$(/usr/bin/plutil -extract transport raw -o - "$ready" 2>/dev/null)
    ready_loaded=true
  fi
  if [[ "$pid" == <-> ]]; then
    command=$(/bin/ps -p "$pid" -o command= 2>/dev/null)
  fi
  runtime_healthy=false
  if [[ "$pid" == <-> ]] && [[ -n "$started_at" ]] && [[ "$ready_app_path" == "$executable_path" ]] && [[ "$ready_transport" == "in-app" ]] && [[ "$command" == "$executable_path" || "$command" == "$executable_path "* ]]; then
    runtime_healthy=true
  fi
  # A dead updater must not strand its global manifest behind a healthy ready
  # record. Commit-intent/committed transactions are safe to roll forward while
  # the exact replacement is live. A pending/rolling-back transaction would
  # need to swap that live bundle, so preserve it until the process exits; the
  # supervisor never signals Vigil across its availability boundary.
  if global_update_manifest_present; then
    if [[ "$runtime_healthy" == true ]] && ! global_update_can_roll_forward_with_live_runtime; then
      if [[ "$global_recovery_notice" != "waiting-for-live-runtime" ]]; then
        /usr/bin/printf '%s\n' "Vigil preserved a live replacement until its interrupted global update can roll back safely." >&2
      fi
      global_recovery_notice="waiting-for-live-runtime"
      /bin/sleep 2
      continue
    fi
    recovery_mode=""
    [[ "$runtime_healthy" == true ]] && recovery_mode="--live-runtime"
    if ! recover_global_update_transaction "$recovery_mode"; then
      if [[ "$global_recovery_notice" != "recovery-failed" ]]; then
        /usr/bin/printf '%s\n' "Vigil could not durably recover the interrupted global update yet; all recovery evidence was preserved." >&2
      fi
      global_recovery_notice="recovery-failed"
      /bin/sleep 2
      continue
    fi
    global_recovery_notice=""
  else
    global_recovery_notice=""
  fi
  if [[ "$runtime_healthy" == true ]]; then
    if ! mark_running_candidate_verified; then
      /usr/bin/printf '%s\n' "Vigil could not durably accept the healthy replacement transaction yet; its recovery copy was preserved." >&2
    fi
    /bin/sleep 2
    continue
  fi
  if [[ "$ready_exists" == true ]]; then
    if [[ "$pid" != <-> ]] || [[ -z "$started_at" ]] || [[ "$ready_app_path" != "$executable_path" ]] || [[ "$ready_transport" != "in-app" ]]; then
      invalid_started_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
      if ! preserve_interruption "$$" "$invalid_started_at" "invalid-ready-record"; then
        /usr/bin/printf '%s\n' "Vigil could not preserve invalid readiness evidence before recovery." >&2
        ready_loaded=false
        if [[ -e "$marker" ]]; then
          reopen_vigil
        fi
        /bin/sleep 2
        continue
      fi
      if ! archive_invalid_ready; then
        /usr/bin/printf '%s\n' "Vigil preserved a fail-closed receipt but could not archive the malformed readiness file." >&2
      fi
    else
      reason="process-identity-mismatch"
      if [[ -z "$command" ]]; then
        reason="process-missing"
      fi
      if ! preserve_interruption "$pid" "$started_at" "$reason"; then
        /usr/bin/printf '%s\n' "Vigil could not preserve runtime interruption evidence before recovery." >&2
        ready_loaded=false
        if [[ -e "$marker" ]]; then
          reopen_vigil
        fi
        /bin/sleep 2
        continue
      fi
    fi
  fi
  /bin/rm -f "$ready"
  pid=""
  started_at=""
  ready_app_path=""
  ready_transport=""
  ready_loaded=false
  if [[ ! -e "$marker" ]]; then
    break
  fi
  reopen_vigil
  /bin/sleep 5
done
`;
}

export async function markRuntimeReady(dataDir: string, appPath: string): Promise<RuntimeReadyRecord> {
  const record: RuntimeReadyRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    appPath,
    transport: "in-app"
  };
  const path = runtimeReadyPath(dataDir);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dataDir, { recursive: true });
  let temporary: Awaited<ReturnType<typeof open>> | null = null;
  try {
    temporary = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await temporary.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await rename(temporaryPath, path);
    await syncDirectory(dataDir);
  } finally {
    await temporary?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return record;
}

export async function readRuntimeReady(dataDir: string): Promise<RuntimeReadyRecord | null> {
  try {
    const value = JSON.parse(await readFile(runtimeReadyPath(dataDir), "utf8")) as Partial<RuntimeReadyRecord>;
    if (
      !Number.isInteger(value.pid)
      || Number(value.pid) < 1
      || !Number.isFinite(Date.parse(String(value.startedAt || "")))
      || typeof value.appPath !== "string"
      || value.transport !== "in-app"
    ) return null;
    return value as RuntimeReadyRecord;
  } catch {
    return null;
  }
}

export async function readRuntimeInterruption(dataDir: string): Promise<RuntimeInterruptionReadResult> {
  const path = runtimeInterruptionPath(dataDir);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    return fileErrorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: "unreadable-file" };
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) return { status: "invalid", reason: "unsafe-file" };
  if (metadata.size > MAX_RUNTIME_INTERRUPTION_BYTES) {
    return { status: "invalid", reason: "oversized-file" };
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    return { status: "invalid", reason: "unreadable-file" };
  }
  if (raw.byteLength > MAX_RUNTIME_INTERRUPTION_BYTES) {
    return { status: "invalid", reason: "oversized-file" };
  }
  let value: Partial<RuntimeInterruptionRecord>;
  try {
    value = JSON.parse(raw.toString("utf8")) as Partial<RuntimeInterruptionRecord>;
  } catch {
    return { status: "invalid", reason: "malformed-json" };
  }
  if (
    value.version !== RUNTIME_INTERRUPTION_VERSION
    || !Number.isInteger(value.pid)
    || Number(value.pid) < 1
    || !validTimestamp(value.startedAt)
    || !validTimestamp(value.detectedAt)
    || Date.parse(value.startedAt) > Date.parse(value.detectedAt)
    || typeof value.appPath !== "string"
    || !value.appPath.startsWith("/")
    || value.appPath.length > 4_096
    || value.transport !== "in-app"
    || !runtimeInterruptionReason(value.reason)
    || value.id !== runtimeInterruptionId({ pid: Number(value.pid), startedAt: String(value.startedAt) })
  ) return { status: "invalid", reason: "invalid-record" };
  return { status: "valid", record: value as RuntimeInterruptionRecord };
}

export async function liveRuntimeReady(dataDir: string, startedAfter = 0): Promise<RuntimeReadyRecord | null> {
  const record = await readRuntimeReady(dataDir);
  if (!record || Date.parse(record.startedAt) < startedAfter || !processIsRunning(record.pid)) return null;
  return record;
}

export async function clearRuntimeReady(dataDir: string, pid = process.pid): Promise<void> {
  const record = await readRuntimeReady(dataDir);
  if (record?.pid !== pid) return;
  await rm(runtimeReadyPath(dataDir), { force: true });
  await syncDirectory(dataDir);
}

export async function clearRuntimeInterruption(dataDir: string, expectedId: string): Promise<boolean> {
  const result = await readRuntimeInterruption(dataDir);
  if (result.status !== "valid" || result.record.id !== expectedId) return false;
  await rm(runtimeInterruptionPath(dataDir), { force: true });
  await syncDirectory(dataDir);
  return true;
}

/**
 * Preserve an invalid canonical receipt while freeing its well-known path for
 * future supervisor evidence. Rename operates on the directory entry itself,
 * so a symlink is quarantined without reading or modifying its target.
 */
export async function quarantineRuntimeInterruption(dataDir: string, now = new Date()): Promise<string | null> {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Vigil cannot quarantine interruption evidence with an invalid timestamp.");
  const path = runtimeInterruptionPath(dataDir);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  await chmodPrivateIfSameSafeFile(path, metadata);
  const evidencePath = `${path}.corrupt.${Math.trunc(timestamp)}.${randomUUID()}`;
  await rename(path, evidencePath);
  try {
    const movedMetadata = await lstat(evidencePath);
    await chmodPrivateIfSameSafeFile(evidencePath, movedMetadata);
    const directory = await open(dataDir, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw Object.assign(new Error(`Vigil quarantined invalid runtime interruption evidence at ${evidencePath}, but could not durably secure it.`), {
      cause: error,
      evidencePath
    });
  }
  return evidencePath;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function runtimeInterruptionReason(value: unknown): value is RuntimeInterruptionReason {
  return value === "process-missing" || value === "process-identity-mismatch" || value === "invalid-ready-record";
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validTimestamp(value: unknown): value is string {
  const text = String(value || "");
  return text.length > 0 && text.length <= 64 && Number.isFinite(Date.parse(text));
}

function fileErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
}

async function chmodPrivateIfSameSafeFile(
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>
): Promise<void> {
  if (
    !expected.isFile()
    || expected.isSymbolicLink()
    || expected.nlink !== 1
    || (typeof process.getuid === "function" && expected.uid !== process.getuid())
  ) return;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.nlink !== 1
      || (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) return;
    await handle.chmod(PRIVATE_FILE_MODE);
  } catch {
    // Unsafe or inaccessible file types are still preserved by rename; only
    // descriptor-verified regular files are permission-normalized.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
