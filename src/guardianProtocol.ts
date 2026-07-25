export type GuardianRecoveryAuthorizationProtocol = "pinned-pending" | "legacy-normalized";
export type GuardianNormalParentCommandPolicy =
  | "vigil-executable"
  | "background-only"
  | "background-or-canonical";

export interface GuardianProtocolDescriptor {
  readonly bootstrapClaimKind: string | null;
  readonly bootstrapClaimPath: string | null;
  readonly current: boolean;
  readonly dynamicAssignments: readonly string[];
  readonly key: "legacy" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8";
  readonly label: string;
  readonly maintenanceAuthorizationKind: string;
  readonly maintenanceAuthorizationPath: string;
  readonly normalParentCommandPolicy: GuardianNormalParentCommandPolicy;
  readonly plistPath: string;
  readonly programSha256: string | null;
  readonly recoveryAuthorizationKind: string;
  readonly recoveryAuthorizationPath: string;
  readonly recoveryProtocol: GuardianRecoveryAuthorizationProtocol;
  readonly revision: number | null;
  readonly scriptPath: string;
  readonly sourceCommit: string | null;
}

export interface VersionedGuardianProtocolDescriptor extends GuardianProtocolDescriptor {
  readonly bootstrapClaimKind: string;
  readonly bootstrapClaimPath: string;
  readonly key: "v3" | "v4" | "v5" | "v6" | "v7" | "v8";
  readonly revision: 3 | 4 | 5 | 6 | 7 | 8;
}

const GUARDIAN_ROOT = "/Library/Application Support/Vigil/System Guardian";
const LAUNCH_DAEMON_ROOT = "/Library/LaunchDaemons";
const MAINTENANCE_AUTHORIZATION_KIND = "vigil-root-maintenance-authorization-v2";
const BOOTSTRAP_CLAIM_KIND = "vigil-root-update-protocol-bootstrap-worker-claim-v1";

const COMMON_DYNAMIC_ASSIGNMENTS = Object.freeze([
  "target_uid",
  "target_user",
  "target_home",
  "app_path",
  "executable_path",
  "process_pattern",
  "supervisor_service",
  "update_lock_path",
  "maintenance_marker_path",
  "global_update_manifest_path",
  "global_update_policy_path"
] as const);

const VERSIONED_DYNAMIC_ASSIGNMENTS_V3_TO_V5 = Object.freeze([
  ...COMMON_DYNAMIC_ASSIGNMENTS,
  "bootstrap_worker_request_path",
  "exact_main_command",
  "exact_main_process_pattern",
  "packaged_updater_script_path",
  "local_updater_script_path",
  "user_data_dir",
  "update_status_path",
  "update_log_path"
] as const);

const VERSIONED_DYNAMIC_ASSIGNMENTS_V6_TO_V7 = Object.freeze([
  ...COMMON_DYNAMIC_ASSIGNMENTS,
  "bootstrap_worker_request_path",
  "exact_main_command",
  "canonical_main_command",
  "packaged_updater_script_path",
  "local_updater_script_path",
  "user_data_dir",
  "update_status_path",
  "update_log_path"
] as const);

function versionedGuardian(
  revision: 3 | 4 | 5 | 6 | 7 | 8,
  options: {
    current: boolean;
    dynamicAssignments: readonly string[];
    maintenanceAuthorizationPath: string;
    normalParentCommandPolicy: GuardianNormalParentCommandPolicy;
    programSha256: string | null;
    sourceCommit: string | null;
  }
): VersionedGuardianProtocolDescriptor {
  const key = `v${revision}` as const;
  const label = `tech.caseline.vigil.system-guardian.v${revision}`;
  return Object.freeze({
    bootstrapClaimKind: BOOTSTRAP_CLAIM_KIND,
    bootstrapClaimPath: revision === 3
      ? `${GUARDIAN_ROOT}/update-protocol-bootstrap-worker-claim.plist`
      : `${GUARDIAN_ROOT}/update-protocol-bootstrap-worker-claim-v${revision}.plist`,
    current: options.current,
    dynamicAssignments: options.dynamicAssignments,
    key,
    label,
    maintenanceAuthorizationKind: MAINTENANCE_AUTHORIZATION_KIND,
    maintenanceAuthorizationPath: options.maintenanceAuthorizationPath,
    normalParentCommandPolicy: options.normalParentCommandPolicy,
    plistPath: `${LAUNCH_DAEMON_ROOT}/${label}.plist`,
    programSha256: options.programSha256,
    recoveryAuthorizationKind: `vigil-root-update-recovery-authorization-v${revision}`,
    recoveryAuthorizationPath: `${GUARDIAN_ROOT}/update-recovery-authorization-v${revision}.plist`,
    recoveryProtocol: "pinned-pending",
    revision,
    scriptPath: `${GUARDIAN_ROOT}/vigil-system-guardian-v${revision}-DO-NOT-TERMINATE.sh`,
    sourceCommit: options.sourceCommit
  });
}

export const LEGACY_GUARDIAN_PROTOCOL = Object.freeze({
  bootstrapClaimKind: null,
  bootstrapClaimPath: null,
  current: false,
  dynamicAssignments: COMMON_DYNAMIC_ASSIGNMENTS,
  key: "legacy",
  label: "tech.caseline.vigil.system-guardian",
  maintenanceAuthorizationKind: MAINTENANCE_AUTHORIZATION_KIND,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization.plist`,
  normalParentCommandPolicy: "vigil-executable",
  plistPath: `${LAUNCH_DAEMON_ROOT}/tech.caseline.vigil.system-guardian.plist`,
  programSha256: "62f041926840824e15c76361d508ac224c3b92ba7312003329c410d83fcc8ea1",
  recoveryAuthorizationKind: "vigil-root-update-recovery-authorization-v2",
  recoveryAuthorizationPath: `${GUARDIAN_ROOT}/update-recovery-authorization.plist`,
  recoveryProtocol: "legacy-normalized",
  revision: null,
  scriptPath: `${GUARDIAN_ROOT}/vigil-system-guardian-DO-NOT-TERMINATE.sh`,
  sourceCommit: "14a573d6b1eab8761e9427f06d9af80f49087f38"
} satisfies GuardianProtocolDescriptor);

export const GUARDIAN_PROTOCOL_V3 = versionedGuardian(3, {
  current: false,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V3_TO_V5,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization.plist`,
  normalParentCommandPolicy: "background-only",
  programSha256: "2da645ad29084194b52d6d2d7f0505a83451a1cadb2628c12a14cf91dae6dafe",
  sourceCommit: "18573ecd076c2a2b486afb90df9793c21572a84d"
});

export const GUARDIAN_PROTOCOL_V4 = versionedGuardian(4, {
  current: false,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V3_TO_V5,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization.plist`,
  normalParentCommandPolicy: "background-only",
  programSha256: "ee0be79b4c686c1d28e38ed8ca185e941e0dce2b2fe2eefd030625958e20b88d",
  sourceCommit: "ba69fc5125d214a7c929f93207dcca1bdc448e9d"
});

export const GUARDIAN_PROTOCOL_V5 = versionedGuardian(5, {
  current: false,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V3_TO_V5,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization-v5.plist`,
  normalParentCommandPolicy: "background-only",
  programSha256: "b69e4db8ac6e31145bb34ce075d00d70d086c201dae902053daa0aba12038468",
  sourceCommit: "2017e7b82ed5648dce39e4d8df88f7bce8b83466"
});

export const GUARDIAN_PROTOCOL_V6 = versionedGuardian(6, {
  current: false,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V6_TO_V7,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization-v6.plist`,
  normalParentCommandPolicy: "background-or-canonical",
  programSha256: "2ef7538db87511e723216ea6785a9ff49e60e29d2345a9a8e0b9ddd7c139a6ce",
  sourceCommit: "e7d1f458442c7732b19e3cba4c0f33cca23823cf"
});

export const GUARDIAN_PROTOCOL_V7 = versionedGuardian(7, {
  current: false,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V6_TO_V7,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization-v7.plist`,
  normalParentCommandPolicy: "background-or-canonical",
  programSha256: "dc6cfad5068be83786ef668dc4caff5e5f136c0d3b7953952c32dff90f508d1f",
  sourceCommit: "6d762989c79615fbc7db609c3b314af7814bdeec"
});

export const GUARDIAN_PROTOCOL_V8 = versionedGuardian(8, {
  current: true,
  dynamicAssignments: VERSIONED_DYNAMIC_ASSIGNMENTS_V6_TO_V7,
  maintenanceAuthorizationPath: `${GUARDIAN_ROOT}/maintenance-authorization-v8.plist`,
  normalParentCommandPolicy: "background-or-canonical",
  programSha256: null,
  sourceCommit: null
});

export const GUARDIAN_PROTOCOLS = Object.freeze([
  LEGACY_GUARDIAN_PROTOCOL,
  GUARDIAN_PROTOCOL_V3,
  GUARDIAN_PROTOCOL_V4,
  GUARDIAN_PROTOCOL_V5,
  GUARDIAN_PROTOCOL_V6,
  GUARDIAN_PROTOCOL_V7,
  GUARDIAN_PROTOCOL_V8
] as const);

export const CURRENT_GUARDIAN_PROTOCOL = GUARDIAN_PROTOCOL_V8;

export const SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS = Object.freeze([
  GUARDIAN_PROTOCOL_V7,
  GUARDIAN_PROTOCOL_V6,
  GUARDIAN_PROTOCOL_V5,
  GUARDIAN_PROTOCOL_V4,
  GUARDIAN_PROTOCOL_V3,
  LEGACY_GUARDIAN_PROTOCOL
] as const);

export function guardianProtocolForTopology(candidate: {
  label: string;
  plistPath: string;
  scriptPath: string;
}): GuardianProtocolDescriptor | null {
  return GUARDIAN_PROTOCOLS.find((protocol) => protocol.label === candidate.label
    && protocol.plistPath === candidate.plistPath
    && protocol.scriptPath === candidate.scriptPath) || null;
}
