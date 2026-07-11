import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
  buildIosConfigurationProfile,
  buildIosSocialLauncherProfile,
  ensureIosRemovalPassword,
  iosProfileSummary
} from "./iosProfiles.js";
import { saveState as defaultSaveState } from "./store.js";
import type { SentinelState } from "./types.js";

export const MANAGEENGINE_IOS_PROFILE_IDENTIFIER = "com.local-screen-time.ios-lock";
export const MANAGEENGINE_POLICY_PROFILE_PATH = "data/manageengine/sentinel-manageengine-policy.mobileconfig";
export const MANAGEENGINE_POLICY_SUMMARY_PATH = "data/manageengine/sentinel-manageengine-policy.summary.json";
export const MANAGEENGINE_ENROLLMENT_WINDOW_PROFILE_PATH = "data/manageengine/sentinel-manageengine-enrollment-window.mobileconfig";
export const MANAGEENGINE_ENROLLMENT_WINDOW_SUMMARY_PATH = "data/manageengine/sentinel-manageengine-enrollment-window.summary.json";
export const MANAGEENGINE_SOCIAL_LAUNCHER_PROFILE_NAME = "sentinel-social-launchers.mobileconfig";
export const MANAGEENGINE_SOCIAL_LAUNCHER_SUMMARY_NAME = "sentinel-social-launchers.summary.json";

export interface ManageEngineIosExportOptions {
  allowProfileInstall?: boolean;
  currentState?: boolean;
  disabled?: boolean;
  enable?: boolean;
  enrollmentWindow?: boolean;
  launcherOutPath?: string;
  launcherDeploymentObservation?: ManageEngineDeploymentObservation;
  launcherSummaryPath?: string;
  noHardenRemoval?: boolean;
  outPath?: string;
  deploymentObservation?: ManageEngineDeploymentObservation;
  saveState?: (state: SentinelState) => Promise<void>;
  summaryPath?: string;
}

export interface ManageEngineDeploymentObservation {
  observedAt?: string;
  installedProfileIdentifier?: string;
  installedProfileHash?: string;
  effectiveProhibitAppInstall?: boolean;
  effectiveProhibitAppDelete?: boolean;
}

export interface ManageEngineIosExportResult {
  mode: "enrollment-window" | "managed-policy";
  outPath: string;
  profileBytes: number;
  profileHash: string;
  profileIdentifier: string;
  mirroredOutPath: string | null;
  mirroredSummaryPath: string | null;
  launcherOutPath: string;
  launcherProfileBytes: number;
  launcherProfileHash: string;
  launcherProfileIdentifier: string;
  launcherSummaryPath: string;
  mirroredLauncherOutPath: string | null;
  mirroredLauncherSummaryPath: string | null;
  stateSaved: boolean;
  summary: ReturnType<typeof buildManageEngineIosExportSummary>;
  summaryPath: string;
}

const manageEngineExportLocks = new Map<string, Promise<void>>();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export async function exportManageEngineIosProfile(
  savedState: SentinelState,
  options: ManageEngineIosExportOptions = {}
): Promise<ManageEngineIosExportResult> {
  const lockKey = resolve(options.outPath || defaultManageEngineOutputPath(Boolean(options.enrollmentWindow)));
  const previous = manageEngineExportLocks.get(lockKey) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  manageEngineExportLocks.set(lockKey, tail);
  await previous;
  try {
    return await exportManageEngineIosProfileUnlocked(savedState, options);
  } finally {
    release();
    if (manageEngineExportLocks.get(lockKey) === tail) manageEngineExportLocks.delete(lockKey);
  }
}

async function exportManageEngineIosProfileUnlocked(
  savedState: SentinelState,
  options: ManageEngineIosExportOptions
): Promise<ManageEngineIosExportResult> {
  const enrollmentWindow = Boolean(options.enrollmentWindow);
  const outPath = resolve(options.outPath || defaultManageEngineOutputPath(enrollmentWindow));
  const summaryPath = resolve(options.summaryPath || defaultManageEngineSummaryPath(outPath));
  const launcherOutPath = resolve(options.launcherOutPath || join(dirname(outPath), MANAGEENGINE_SOCIAL_LAUNCHER_PROFILE_NAME));
  const launcherSummaryPath = resolve(options.launcherSummaryPath || join(dirname(outPath), MANAGEENGINE_SOCIAL_LAUNCHER_SUMMARY_NAME));
  if (summaryPath === outPath) {
    throw new Error(`Summary output path must differ from profile output path: ${summaryPath}`);
  }
  const uniquePaths = new Set([outPath, summaryPath, launcherOutPath, launcherSummaryPath]);
  if (uniquePaths.size !== 4) {
    throw new Error("Policy, launcher, and summary output paths must all differ.");
  }

  const exportState = structuredClone(savedState) as SentinelState;
  prepareManageEngineState(exportState, options);

  const stateSaved = await persistRemovalPasswordForHardenedExport(savedState, exportState, options.saveState || defaultSaveState);
  const profile = buildIosConfigurationProfile(exportState);
  const profileHash = createHash("sha256").update(profile).digest("hex");
  const launcherProfile = buildIosSocialLauncherProfile();
  const launcherProfileHash = createHash("sha256").update(launcherProfile).digest("hex");
  const launcherDeployment = detectManageEngineDeploymentState({
    artifactHash: launcherProfileHash,
    profileIdentifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
    appStoreAllowedByThisProfile: true
  }, options.launcherDeploymentObservation);
  const summary = buildManageEngineIosExportSummary(
    exportState,
    enrollmentWindow,
    outPath,
    stateSaved,
    profileHash,
    options.deploymentObservation,
    {
      outputPath: launcherOutPath,
      summaryPath: launcherSummaryPath,
      profileHash: launcherProfileHash,
      deployment: launcherDeployment
    }
  );
  const launcherSummary = {
    generatedAt: summary.generatedAt,
    mode: "static-social-launchers",
    deliveryProvider: "manageengine",
    outputPath: launcherOutPath,
    profileIdentifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
    artifactHash: launcherProfileHash,
    durationUntilRemoval: false,
    stablePayloadIdentities: true,
    webClipCount: summary.launcherProfile.webClipCount,
    labels: summary.launcherProfile.labels,
    assignmentOrder: "Assign once before the dynamic enforcement profile; do not attach a timed removal command.",
    deployment: launcherDeployment
  };

  for (const directory of new Set([dirname(outPath), dirname(summaryPath), dirname(launcherOutPath), dirname(launcherSummaryPath)])) {
    await ensurePrivateDirectory(directory);
  }
  await writeFileAtomically(outPath, profile);
  await writeFileAtomically(launcherOutPath, launcherProfile);
  await writeFileAtomically(launcherSummaryPath, `${JSON.stringify(launcherSummary, null, 2)}\n`);
  await writeFileAtomically(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const mirror = defaultPolicyHandoffMirrorPaths(outPath, summaryPath);
  const launcherMirror = mirror ? {
    outPath: join(dirname(mirror.outPath), basename(launcherOutPath)),
    summaryPath: join(dirname(mirror.summaryPath), basename(launcherSummaryPath))
  } : null;
  if (mirror) {
    await ensurePrivateDirectory(dirname(mirror.outPath));
    await writeFileAtomically(mirror.outPath, profile);
    await writeFileAtomically(mirror.summaryPath, `${JSON.stringify({
      ...summary,
      outputPath: mirror.outPath,
      launcherProfile: {
        ...summary.launcherProfile,
        outputPath: launcherMirror?.outPath || summary.launcherProfile.outputPath,
        summaryPath: launcherMirror?.summaryPath || summary.launcherProfile.summaryPath
      }
    }, null, 2)}\n`);
  }
  if (launcherMirror) {
    await ensurePrivateDirectory(dirname(launcherMirror.outPath));
    await writeFileAtomically(launcherMirror.outPath, launcherProfile);
    await writeFileAtomically(launcherMirror.summaryPath, `${JSON.stringify({ ...launcherSummary, outputPath: launcherMirror.outPath }, null, 2)}\n`);
  }

  return {
    mode: enrollmentWindow ? "enrollment-window" : "managed-policy",
    outPath,
    profileBytes: Buffer.byteLength(profile),
    profileHash,
    profileIdentifier: MANAGEENGINE_IOS_PROFILE_IDENTIFIER,
    mirroredOutPath: mirror?.outPath || null,
    mirroredSummaryPath: mirror?.summaryPath || null,
    launcherOutPath,
    launcherProfileBytes: Buffer.byteLength(launcherProfile),
    launcherProfileHash,
    launcherProfileIdentifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
    launcherSummaryPath,
    mirroredLauncherOutPath: launcherMirror?.outPath || null,
    mirroredLauncherSummaryPath: launcherMirror?.summaryPath || null,
    stateSaved,
    summary,
    summaryPath
  };
}

export function prepareManageEngineState(state: SentinelState, options: ManageEngineIosExportOptions = {}): void {
  const ios = state.deviceControls.ios;
  if (!options.currentState) ios.enabled = true;
  if (options.disabled) ios.enabled = false;
  if (options.enable) ios.enabled = true;
  if (options.allowProfileInstall) ios.restrictInstallAndErase = false;
  if (options.noHardenRemoval) ios.hardenRemoval = false;

  if (options.enrollmentWindow) {
    ios.enabled = true;
    ios.restrictInstallAndErase = false;
    ios.hardenRemoval = false;
  }
}

export function buildManageEngineIosExportSummary(
  state: SentinelState,
  windowMode: boolean,
  outputPath: string,
  stateSaved: boolean,
  profileHash = "",
  deploymentObservation?: ManageEngineDeploymentObservation,
  launcherArtifact?: {
    outputPath: string;
    summaryPath: string;
    profileHash: string;
    deployment: ReturnType<typeof detectManageEngineDeploymentState>;
  }
) {
  const ios = state.deviceControls.ios;
  const summary = iosProfileSummary(state);
  return {
    generatedAt: new Date().toISOString(),
    mode: windowMode ? "enrollment-window" : "managed-policy",
    deliveryProvider: "manageengine",
    normalFreeDeliveryPath: true,
    outputPath,
    stateSaved,
    uploadToManageEngineAsCustomConfigurationProfile: true,
    profileIdentifier: MANAGEENGINE_IOS_PROFILE_IDENTIFIER,
    enabled: ios.enabled,
    hardenRemoval: ios.hardenRemoval,
    removalPasswordStoredInSentinelState: Boolean(ios.hardenRemoval && ios.removalPassword),
    restrictInstallAndErase: ios.restrictInstallAndErase,
    allowSafariHistoryClearing: ios.allowSafariHistoryClearing !== false,
    profileInstallAllowedByThisProfile: summary.appStoreInstallAllowed,
    appStoreAllowedByThisProfile: summary.appStoreAllowedByThisProfile,
    appStoreRestrictionKeysEmitted: summary.appStoreRestrictionKeysEmitted,
    artifactHash: profileHash || null,
    deployment: detectManageEngineDeploymentState({
      artifactHash: profileHash,
      profileIdentifier: MANAGEENGINE_IOS_PROFILE_IDENTIFIER,
      appStoreAllowedByThisProfile: summary.appStoreAllowedByThisProfile
    }, deploymentObservation),
    warning: windowMode
      ? "Temporary profile for enrolling in ManageEngine. Replace it with the managed-policy profile after enrollment."
      : summary.profile.enforcementActive
        ? "Active Sentinel enforcement profile for ManageEngine assignment and remote delivery."
        : "Level 1 is active, so this dynamic policy artifact intentionally contains no restrictions.",
    generatedFrom: summary.profile.generatedFrom,
    appBundleCount: summary.profile.appBundleCount,
    managedHelperAppBundleIds: summary.profile.managedHelperAppBundleIds,
    deniedUrlCount: summary.profile.deniedUrlCount,
    allowedUrlCount: summary.profile.allowedUrlCount,
    webClipCount: summary.profile.webClipCount,
    enforcementActive: summary.profile.enforcementActive,
    launcherProfile: {
      ...summary.launcherProfile,
      outputPath: launcherArtifact?.outputPath || null,
      summaryPath: launcherArtifact?.summaryPath || null,
      artifactHash: launcherArtifact?.profileHash || null,
      deployment: launcherArtifact?.deployment || detectManageEngineDeploymentState({
        artifactHash: launcherArtifact?.profileHash || "",
        profileIdentifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
        appStoreAllowedByThisProfile: true
      }),
      uploadToManageEngineAsSeparateCustomConfigurationProfile: true
    },
    focusedSocialEnforcementActive: summary.profile.focusedSocialEnforcementActive,
    grayscale: summary.profile.grayscale
  };
}

export function detectManageEngineDeploymentState(
  artifact: {
    artifactHash: string;
    profileIdentifier: string;
    appStoreAllowedByThisProfile: boolean;
  },
  observation?: ManageEngineDeploymentObservation
) {
  if (!observation) {
    return {
      status: "unverified" as const,
      artifactCurrent: null,
      artifactOnly: true,
      effectivePolicyConflict: false,
      requiresManageEngineUploadAndAssignment: true,
      requiresRestrictionReconciliation: false,
      reasons: ["No installed-profile observation was supplied; writing an artifact does not deploy it."],
      observedAt: null
    };
  }

  const staleReasons: string[] = [];
  if (observation.installedProfileIdentifier
    && observation.installedProfileIdentifier !== artifact.profileIdentifier) {
    staleReasons.push("The observed installed profile identifier does not match this artifact.");
  }
  if (artifact.artifactHash && observation.installedProfileHash
    && observation.installedProfileHash !== artifact.artifactHash) {
    staleReasons.push("The observed installed profile hash differs from this artifact.");
  }
  const effectivePolicyConflict = Boolean(artifact.appStoreAllowedByThisProfile
    && (observation.effectiveProhibitAppInstall === true || observation.effectiveProhibitAppDelete === true));
  const conflictReasons = effectivePolicyConflict
    ? ["The phone still reports effective app-install or app-delete prohibitions that this artifact does not emit; another or older profile may still be enforcing them."]
    : [];

  if (staleReasons.length) {
    return {
      status: "stale" as const,
      artifactCurrent: false,
      artifactOnly: false,
      effectivePolicyConflict,
      requiresManageEngineUploadAndAssignment: true,
      requiresRestrictionReconciliation: effectivePolicyConflict,
      reasons: [...staleReasons, ...conflictReasons],
      observedAt: observation.observedAt || null
    };
  }

  const hashVerified = Boolean(artifact.artifactHash && observation.installedProfileHash === artifact.artifactHash);
  if (hashVerified && effectivePolicyConflict) {
    return {
      status: "current-with-conflict" as const,
      artifactCurrent: true,
      artifactOnly: false,
      effectivePolicyConflict: true,
      requiresManageEngineUploadAndAssignment: false,
      requiresRestrictionReconciliation: true,
      reasons: conflictReasons,
      observedAt: observation.observedAt || null
    };
  }
  if (!hashVerified && effectivePolicyConflict) {
    return {
      status: "unverified-with-conflict" as const,
      artifactCurrent: null,
      artifactOnly: false,
      effectivePolicyConflict: true,
      requiresManageEngineUploadAndAssignment: true,
      requiresRestrictionReconciliation: true,
      reasons: [
        "The installed profile hash was not available, so current deployment cannot be proven.",
        ...conflictReasons
      ],
      observedAt: observation.observedAt || null
    };
  }
  return {
    status: hashVerified ? "current" as const : "unverified" as const,
    artifactCurrent: hashVerified ? true : null,
    artifactOnly: false,
    effectivePolicyConflict: false,
    requiresManageEngineUploadAndAssignment: !hashVerified,
    requiresRestrictionReconciliation: false,
    reasons: hashVerified
      ? []
      : ["The installed profile hash was not available, so current deployment cannot be proven."],
    observedAt: observation.observedAt || null
  };
}

export async function persistRemovalPasswordForHardenedExport(
  savedState: SentinelState,
  exportState: SentinelState,
  saveState: (state: SentinelState) => Promise<void> = defaultSaveState
): Promise<boolean> {
  const ios = exportState.deviceControls.ios;
  if (!ios.enabled || ios.hardenRemoval === false || ios.removalPassword) return false;

  const changed = ensureIosRemovalPassword(savedState);
  if (!savedState.deviceControls.ios.removalPassword) {
    throw new Error("Hardened ManageEngine export requires a saved iOS removal password.");
  }
  if (changed) await saveState(savedState);
  exportState.deviceControls.ios.removalPassword = savedState.deviceControls.ios.removalPassword;
  return changed;
}

export function defaultManageEngineOutputPath(windowMode: boolean): string {
  return windowMode ? MANAGEENGINE_ENROLLMENT_WINDOW_PROFILE_PATH : MANAGEENGINE_POLICY_PROFILE_PATH;
}

export function defaultManageEngineSummaryPath(outputPath: string): string {
  return outputPath.toLowerCase().endsWith(".mobileconfig")
    ? `${outputPath.slice(0, -".mobileconfig".length)}.summary.json`
    : `${outputPath}.summary.json`;
}

function defaultPolicyHandoffMirrorPaths(outPath: string, summaryPath: string): { outPath: string; summaryPath: string } | null {
  if (basename(outPath) !== "sentinel-manageengine-policy.mobileconfig") return null;
  if (basename(summaryPath) !== "sentinel-manageengine-policy.summary.json") return null;
  if (basename(dirname(outPath)) !== "manageengine") return null;
  if (dirname(summaryPath) !== dirname(outPath)) return null;
  const handoffDir = join(dirname(outPath), "Sentinel-ManageEngine-MDM");
  return {
    outPath: join(handoffDir, basename(outPath)),
    summaryPath: join(handoffDir, basename(summaryPath))
  };
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let exists = true;
  try {
    await stat(path);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    exists = false;
  }
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!exists || managedOutputDirectory(path)) await chmod(path, PRIVATE_DIRECTORY_MODE);
}

function managedOutputDirectory(path: string): boolean {
  const name = basename(resolve(path)).toLowerCase();
  return name === "manageengine" || name === "sentinel-manageengine-mdm";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
