import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  buildIosConfigurationProfile,
  ensureIosRemovalPassword,
  iosProfileSummary
} from "./iosProfiles.js";
import { DATA_DIR, saveState as defaultSaveState } from "./store.js";
import { configuredIosPhoneProfileOptions } from "./iosUrlFilterServiceConfiguration.js";
import type { VigilState } from "./types.js";

export const MANAGEENGINE_IOS_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
export const MANAGEENGINE_POLICY_PROFILE_PATH = "data/manageengine/vigil-manageengine-policy.mobileconfig";
export const MANAGEENGINE_POLICY_SUMMARY_PATH = "data/manageengine/vigil-manageengine-policy.summary.json";
export const MANAGEENGINE_ENROLLMENT_WINDOW_PROFILE_PATH = "data/manageengine/vigil-manageengine-enrollment-window.mobileconfig";
export const MANAGEENGINE_ENROLLMENT_WINDOW_SUMMARY_PATH = "data/manageengine/vigil-manageengine-enrollment-window.summary.json";
/** @deprecated Launcher artifacts are retired and are removed from current exports. */
export const MANAGEENGINE_SOCIAL_LAUNCHER_PROFILE_NAME = "vigil-social-launchers.mobileconfig";
/** @deprecated Launcher artifacts are retired and are removed from current exports. */
export const MANAGEENGINE_SOCIAL_LAUNCHER_SUMMARY_NAME = "vigil-social-launchers.summary.json";

export interface ManageEngineIosExportOptions {
  allowProfileInstall?: boolean;
  currentState?: boolean;
  disabled?: boolean;
  enable?: boolean;
  enrollmentWindow?: boolean;
  /** @deprecated If supplied, this retired artifact path is removed after publication. */
  launcherOutPath?: string;
  /** @deprecated Ignored because launcher profiles are no longer deployed. */
  launcherDeploymentObservation?: ManageEngineDeploymentObservation;
  /** @deprecated If supplied, this retired artifact path is removed after publication. */
  launcherSummaryPath?: string;
  noHardenRemoval?: boolean;
  outPath?: string;
  deploymentObservation?: ManageEngineDeploymentObservation;
  saveState?: (state: VigilState) => Promise<void>;
  summaryPath?: string;
  afterPublicationBoundary?: (boundary: string) => void | Promise<void>;
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
  launcherOutPath: null;
  launcherProfileBytes: number;
  launcherProfileHash: null;
  launcherProfileIdentifier: null;
  launcherSummaryPath: null;
  mirroredLauncherOutPath: null;
  mirroredLauncherSummaryPath: null;
  stateSaved: boolean;
  summary: ReturnType<typeof buildManageEngineIosExportSummary>;
  summaryPath: string;
  generationPath: string;
  generationManifestPath: string;
}

export interface ManageEngineGenerationManifest {
  version: 1;
  generation: string;
  generatedAt: string;
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface PinnedManageEngineGeneration {
  generationPath: string;
  manifestPath: string;
  manifest: ManageEngineGenerationManifest;
  paths: Record<string, { path: string; sha256: string; bytes: number }>;
  assertValid(): Promise<void>;
  release(): Promise<void>;
}

const manageEngineExportLocks = new Map<string, Promise<void>>();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANAGEENGINE_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
const MANAGEENGINE_LOCK_LEASE_MS = 10_000;
const MANAGEENGINE_PIN_LEASE_MS = 30_000;
const MANAGEENGINE_MAX_MANIFEST_BYTES = 1024 * 1024;
const MANAGEENGINE_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function exportManageEngineIosProfile(
  savedState: VigilState,
  options: ManageEngineIosExportOptions = {}
): Promise<ManageEngineIosExportResult> {
  const lockKey = dirname(resolve(options.outPath || defaultManageEngineOutputPath(Boolean(options.enrollmentWindow))));
  const previous = manageEngineExportLocks.get(lockKey) || Promise.resolve();
  let releaseLock = () => {};
  const gate = new Promise<void>((resolveGate) => { releaseLock = resolveGate; });
  const tail = previous.then(() => gate);
  manageEngineExportLocks.set(lockKey, tail);
  await previous;
  try {
    return await exportManageEngineIosProfileUnlocked(savedState, options);
  } finally {
    releaseLock();
    if (manageEngineExportLocks.get(lockKey) === tail) manageEngineExportLocks.delete(lockKey);
  }
}

async function exportManageEngineIosProfileUnlocked(
  savedState: VigilState,
  options: ManageEngineIosExportOptions
): Promise<ManageEngineIosExportResult> {
  const enrollmentWindow = Boolean(options.enrollmentWindow);
  const outPath = resolve(options.outPath || defaultManageEngineOutputPath(enrollmentWindow));
  const summaryPath = resolve(options.summaryPath || defaultManageEngineSummaryPath(outPath));
  if (summaryPath === outPath) {
    throw new Error(`Summary output path must differ from profile output path: ${summaryPath}`);
  }

  const exportState = structuredClone(savedState) as VigilState;
  prepareManageEngineState(exportState, options);

  const stateSaved = await persistRemovalPasswordForHardenedExport(savedState, exportState, options.saveState || defaultSaveState);
  const profile = buildIosConfigurationProfile(exportState, new Date(), configuredIosPhoneProfileOptions(DATA_DIR));
  const profileHash = createHash("sha256").update(profile).digest("hex");
  const summary = buildManageEngineIosExportSummary(
    exportState,
    enrollmentWindow,
    outPath,
    stateSaved,
    profileHash,
    options.deploymentObservation
  );

  const mirror = defaultPolicyHandoffMirrorPaths(outPath, summaryPath);
  const mirroredSummary = mirror ? `${JSON.stringify({
      ...summary,
      outputPath: mirror.outPath
    }, null, 2)}\n` : null;
  const retiredLauncherPaths = retiredManageEngineLauncherPaths(outPath, summaryPath, mirror, options);
  const publication = await publishManageEngineGeneration({
    root: dirname(outPath),
    artifacts: [
      { fixedPath: outPath, generationPath: join("main", basename(outPath)), content: profile },
      { fixedPath: summaryPath, generationPath: join("main", basename(summaryPath)), content: `${JSON.stringify(summary, null, 2)}\n` },
      ...(mirror && mirroredSummary ? [
        { fixedPath: mirror.outPath, generationPath: join("handoff", basename(mirror.outPath)), content: profile },
        { fixedPath: mirror.summaryPath, generationPath: join("handoff", basename(mirror.summaryPath)), content: mirroredSummary }
      ] : [])
    ],
    retiredFixedPaths: retiredLauncherPaths,
    boundary: options.afterPublicationBoundary
  });

  return {
    mode: enrollmentWindow ? "enrollment-window" : "managed-policy",
    outPath,
    profileBytes: Buffer.byteLength(profile),
    profileHash,
    profileIdentifier: MANAGEENGINE_IOS_PROFILE_IDENTIFIER,
    mirroredOutPath: mirror?.outPath || null,
    mirroredSummaryPath: mirror?.summaryPath || null,
    launcherOutPath: null,
    launcherProfileBytes: 0,
    launcherProfileHash: null,
    launcherProfileIdentifier: null,
    launcherSummaryPath: null,
    mirroredLauncherOutPath: null,
    mirroredLauncherSummaryPath: null,
    stateSaved,
    summary,
    summaryPath,
    generationPath: publication.generationPath,
    generationManifestPath: publication.manifestPath
  };
}

export function prepareManageEngineState(state: VigilState, options: ManageEngineIosExportOptions = {}): void {
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
  state: VigilState,
  windowMode: boolean,
  outputPath: string,
  stateSaved: boolean,
  profileHash = "",
  deploymentObservation?: ManageEngineDeploymentObservation
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
    removalPasswordStoredInVigilState: Boolean(ios.hardenRemoval && ios.removalPassword),
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
      : !ios.enabled
      ? "Vigil iPhone protection is disabled; this artifact does not enforce the content-filter contract."
      : summary.profile.enforcementActive
      ? "Active Vigil enforcement profile for ManageEngine assignment and remote delivery."
        : "Always-on managed web filtering is active with targeted native social-app restrictions.",
    generatedFrom: summary.profile.generatedFrom,
    appBundleCount: summary.profile.appBundleCount,
    managedHelperAppBundleIds: summary.profile.managedHelperAppBundleIds,
    deniedUrlCount: summary.profile.deniedUrlCount,
    allowedUrlCount: summary.profile.allowedUrlCount,
    webClipCount: summary.profile.webClipCount,
    enforcementActive: summary.profile.enforcementActive,
    protection: summary.protection,
    companionApps: summary.companionApps,
    launcherProfile: {
      ...summary.launcherProfile,
      outputPath: null,
      summaryPath: null,
      artifactHash: null,
      deployment: null,
      uploadToManageEngineAsSeparateCustomConfigurationProfile: false
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
  savedState: VigilState,
  exportState: VigilState,
  saveState: (state: VigilState) => Promise<void> = defaultSaveState
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
  if (basename(outPath) !== "vigil-manageengine-policy.mobileconfig") return null;
  if (basename(summaryPath) !== "vigil-manageengine-policy.summary.json") return null;
  if (basename(dirname(outPath)) !== "manageengine") return null;
  if (dirname(summaryPath) !== dirname(outPath)) return null;
  const handoffDir = join(dirname(outPath), "Vigil-ManageEngine-MDM");
  return {
    outPath: join(handoffDir, basename(outPath)),
    summaryPath: join(handoffDir, basename(summaryPath))
  };
}

function retiredManageEngineLauncherPaths(
  outPath: string,
  summaryPath: string,
  mirror: { outPath: string; summaryPath: string } | null,
  options: ManageEngineIosExportOptions
): string[] {
  const candidates = [
    options.launcherOutPath,
    options.launcherSummaryPath,
    join(dirname(outPath), MANAGEENGINE_SOCIAL_LAUNCHER_PROFILE_NAME),
    join(dirname(outPath), MANAGEENGINE_SOCIAL_LAUNCHER_SUMMARY_NAME),
    ...(mirror ? [
      join(dirname(mirror.outPath), MANAGEENGINE_SOCIAL_LAUNCHER_PROFILE_NAME),
      join(dirname(mirror.summaryPath), MANAGEENGINE_SOCIAL_LAUNCHER_SUMMARY_NAME)
    ] : [])
  ].filter((value): value is string => Boolean(value));
  const activePaths = new Set([outPath, summaryPath, mirror?.outPath, mirror?.summaryPath].filter(Boolean).map((value) => resolve(String(value))));
  return [...new Set(candidates.map((value) => resolve(value)))].filter((value) => !activePaths.has(value));
}

interface GenerationArtifact {
  fixedPath: string;
  generationPath: string;
  content: string;
}

async function publishManageEngineGeneration({
  root,
  artifacts,
  retiredFixedPaths = [],
  boundary
}: {
  root: string;
  artifacts: GenerationArtifact[];
  retiredFixedPaths?: string[];
  boundary?: (name: string) => void | Promise<void>;
}): Promise<{ generationPath: string; manifestPath: string }> {
  await ensurePrivateDirectory(root);
  return await withManageEngineRootLock(root, async (assertOwned) => await publishManageEngineGenerationLocked({ root, artifacts, retiredFixedPaths, boundary, assertOwned }));
}

async function publishManageEngineGenerationLocked({
  root,
  artifacts,
  retiredFixedPaths,
  boundary,
  assertOwned
}: {
  root: string;
  artifacts: GenerationArtifact[];
  retiredFixedPaths: string[];
  boundary?: (name: string) => void | Promise<void>;
  assertOwned: () => Promise<void>;
}): Promise<{ generationPath: string; manifestPath: string }> {
  await assertOwned();
  const generationsRoot = join(root, ".generations");
  await ensurePrivateDirectory(generationsRoot);
  await assertOwned();
  await sweepManageEngineGenerations(root);
  const generation = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const generationRoot = join(generationsRoot, generation);
  await ensurePrivateDirectory(generationRoot);
  try {
    for (const artifact of artifacts) {
      const path = join(generationRoot, artifact.generationPath);
      await ensurePrivateDirectory(dirname(path));
      await writeSyncedFile(path, artifact.content);
    }
    const manifest: ManageEngineGenerationManifest = {
      version: 1,
      generation,
      generatedAt: new Date().toISOString(),
      artifacts: artifacts.map((artifact) => ({
        path: artifact.generationPath,
        sha256: createHash("sha256").update(artifact.content).digest("hex"),
        bytes: Buffer.byteLength(artifact.content)
      }))
    };
    const manifestPath = join(generationRoot, "manifest.json");
    await writeSyncedFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await syncTreeDirectories(generationRoot, artifacts);
    await boundary?.("generation-fsynced");
    await assertOwned();

    const currentPath = join(root, "current");
    const temporaryCurrent = join(root, `.current.${process.pid}.${randomUUID()}.tmp`);
    await symlink(join(".generations", generation), temporaryCurrent);
    await rename(temporaryCurrent, currentPath);
    await syncDirectory(root);
    await boundary?.("current-published");
    await assertOwned();

    // Fixed paths are single-artifact compatibility links. Readers that need
    // several files must pin once with pinManageEngineCurrentGeneration.
    for (const artifact of artifacts) {
      const relativeTarget = relative(dirname(artifact.fixedPath), join(root, "current", artifact.generationPath));
      await replaceWithSymlink(artifact.fixedPath, relativeTarget);
      await assertOwned();
    }
    for (const retiredPath of retiredFixedPaths) {
      await rm(retiredPath, { force: true });
      await assertOwned();
    }
    await boundary?.("compatibility-published");
    await assertOwned();
    await sweepManageEngineGenerations(root);
    return { generationPath: generationRoot, manifestPath };
  } catch (error) {
    const current = await realpath(join(root, "current")).catch(() => "");
    const publishedGeneration = await realpath(generationRoot).catch(() => "");
    if (!publishedGeneration || current !== publishedGeneration) await rm(generationRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function resolveManageEngineCurrentGeneration(outputDirectory: string): Promise<string> {
  const root = resolve(outputDirectory);
  const generation = await realpath(join(root, "current"));
  const generationsRoot = `${await realpath(join(root, ".generations"))}${sep}`;
  if (!`${generation}${sep}`.startsWith(generationsRoot)) throw new Error("ManageEngine current generation escapes its publication root.");
  return generation;
}

export async function pinManageEngineCurrentGeneration(outputDirectory: string): Promise<PinnedManageEngineGeneration> {
  const root = resolve(outputDirectory);
  await ensurePrivateDirectory(root);
  return await withManageEngineRootLock(root, async () => {
    const generationPath = await resolveManageEngineCurrentGeneration(root);
    const generation = basename(generationPath);
    const pinsRoot = join(root, ".pins");
    await ensurePrivateDirectory(pinsRoot);
    const pinPath = join(pinsRoot, `${generation}.${process.pid}.${randomUUID()}.pin`);
    const identity = await currentProcessIdentity(process.pid);
    const lease = pinLeaseRecord(generation, identity);
    await writeSyncedFile(pinPath, `${JSON.stringify(lease)}\n`);
    try {
      const manifestPath = join(generationPath, "manifest.json");
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("ManageEngine generation manifest must be a regular non-symlink file.");
      const manifest = parseGenerationManifest(await readBoundedTextFile(manifestPath, MANAGEENGINE_MAX_MANIFEST_BYTES), generation);
      const paths: PinnedManageEngineGeneration["paths"] = {};
      const generationRealPath = await realpath(generationPath);
      for (const artifact of manifest.artifacts) {
        const path = resolve(generationPath, artifact.path);
        const artifactInfo = await lstat(path);
        if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink()) {
          throw new Error(`ManageEngine artifact must be a regular non-symlink file: ${artifact.path}`);
        }
        const artifactRealPath = await realpath(path);
        if (!pathWithin(generationRealPath, artifactRealPath)) {
          throw new Error(`ManageEngine manifest path escapes its generation: ${artifact.path}`);
        }
        await verifyGenerationArtifact(path, artifact);
        paths[artifact.path] = { path, sha256: artifact.sha256, bytes: artifact.bytes };
      }
      const leaseHandle = startPinLease(pinPath, generation, identity, lease.token);
      return { generationPath, manifestPath, manifest, paths, ...leaseHandle };
    } catch (error) {
      await rm(pinPath, { force: true }).catch(() => {});
      throw error;
    }
  });
}

function parseGenerationManifest(source: string, expectedGeneration: string): ManageEngineGenerationManifest {
  const value = JSON.parse(source) as Partial<ManageEngineGenerationManifest>;
  if (value.version !== 1 || value.generation !== expectedGeneration || !Array.isArray(value.artifacts) || value.artifacts.length > 64) {
    throw new Error("Invalid ManageEngine generation manifest.");
  }
  const normalizedPaths = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/u.test(String(artifact.sha256)) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new Error("Invalid ManageEngine generation manifest artifact.");
    }
    const normalized = normalize(artifact.path);
    if (!artifact.path || artifact.path.includes("\0") || isAbsolute(artifact.path) || normalized === "." || normalized === ".."
      || normalized.startsWith(`..${sep}`) || normalized !== artifact.path) {
      throw new Error(`Invalid ManageEngine generation manifest path: ${artifact.path}`);
    }
    if (normalizedPaths.has(normalized)) throw new Error(`Duplicate ManageEngine generation manifest path: ${artifact.path}`);
    normalizedPaths.add(normalized);
    if (artifact.bytes > MANAGEENGINE_MAX_ARTIFACT_BYTES) throw new Error(`ManageEngine artifact exceeds the size limit: ${artifact.path}`);
  }
  return value as ManageEngineGenerationManifest;
}

const MANAGEENGINE_GENERATIONS_TO_RETAIN = 3;

async function sweepManageEngineGenerations(root: string): Promise<void> {
  const generationsRoot = join(root, ".generations");
  const currentGeneration = basename(await realpath(join(root, "current")).catch(() => ""));
  const pinned = await activePinnedGenerations(root);
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  const generations = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({ name: entry.name, path: join(generationsRoot, entry.name), modifiedAt: (await stat(join(generationsRoot, entry.name))).mtimeMs })));
  generations.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
  const retainedHistory = new Set(generations.slice(0, MANAGEENGINE_GENERATIONS_TO_RETAIN).map((entry) => entry.name));
  for (const entry of generations) {
    if (entry.name === currentGeneration || pinned.has(entry.name) || retainedHistory.has(entry.name)) continue;
    await rm(entry.path, { recursive: true, force: true });
  }
}

async function activePinnedGenerations(root: string): Promise<Set<string>> {
  const pinsRoot = join(root, ".pins");
  const entries = await readdir(pinsRoot, { withFileTypes: true }).catch(() => []);
  const pinned = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".pin")) continue;
    const pinPath = join(pinsRoot, entry.name);
    try {
      const pin = JSON.parse(await readBoundedTextFile(pinPath, 16 * 1024)) as Partial<LeaseRecord> & { generation?: unknown };
      const pid = Number(pin.pid);
      const generation = typeof pin.generation === "string" ? pin.generation : "";
      if (!generation || basename(generation) !== generation || !Number.isSafeInteger(pid) || pid <= 0
        || !validLeaseIdentity(pin) || !await leaseOwnerMatches(pin)) {
        await rm(pinPath, { force: true });
        continue;
      }
      pinned.add(generation);
    } catch {
      await rm(pinPath, { force: true });
    }
  }
  return pinned;
}

interface ProcessIdentity {
  pid: number;
  bootId: string;
  processStart: string;
}

interface LeaseRecord extends ProcessIdentity {
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

interface PinLeaseRecord extends LeaseRecord {
  generation: string;
}

async function withManageEngineRootLock<T>(root: string, operation: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const lockPath = join(root, ".publication.lock");
  const token = randomUUID();
  const identity = await currentProcessIdentity(process.pid);
  const deadline = Date.now() + MANAGEENGINE_LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      await writeSyncedFile(join(lockPath, "owner.json"), `${JSON.stringify(leaseRecord(identity, token, MANAGEENGINE_LOCK_LEASE_MS))}\n`);
      break;
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await recoverStaleRootLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring the ManageEngine publication lock at ${lockPath}.`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  let released = false;
  let renewals = Promise.resolve();
  let renewalError: Error | null = null;
  const queueRenewal = () => {
    const renewal = renewals.then(async () => {
      if (renewalError) throw renewalError;
      if (released) return;
      const owner = await readLease(join(lockPath, "owner.json"));
      if (owner?.token !== token) throw new Error("ManageEngine publication lock ownership changed while held.");
      await replacePrivateFile(join(lockPath, "owner.json"), `${JSON.stringify(leaseRecord(identity, token, MANAGEENGINE_LOCK_LEASE_MS))}\n`);
    });
    renewals = renewal.catch((error) => {
      renewalError ||= error instanceof Error ? error : new Error(String(error));
    });
    return renewals;
  };
  const assertOwned = async () => {
    await queueRenewal();
    if (renewalError) throw renewalError;
    const owner = await readLease(join(lockPath, "owner.json"));
    if (!owner || !validLeaseIdentity(owner) || owner.token !== token || !await leaseOwnerMatches(owner)) {
      throw new Error("ManageEngine publication lock ownership changed while held.");
    }
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, Math.floor(MANAGEENGINE_LOCK_LEASE_MS / 3));
  timer.unref();
  try {
    const result = await operation(assertOwned);
    await assertOwned();
    return result;
  } finally {
    released = true;
    clearInterval(timer);
    await renewals;
    const owner = await readLease(join(lockPath, "owner.json"));
    if (owner?.token === token) {
      await rm(lockPath, { recursive: true, force: true });
      await syncDirectory(root);
    }
  }
}

async function recoverStaleRootLock(lockPath: string): Promise<void> {
  const owner = await readLease(join(lockPath, "owner.json"));
  let stale = false;
  if (owner && validLeaseIdentity(owner)) {
    stale = !await leaseOwnerMatches(owner);
  } else {
    const lockInfo = await stat(lockPath).catch(() => null);
    stale = Boolean(lockInfo && Date.now() - lockInfo.mtimeMs > MANAGEENGINE_LOCK_LEASE_MS * 2);
  }
  if (!stale) return;
  const current = await readLease(join(lockPath, "owner.json"));
  if ((owner?.token || "") !== (current?.token || "")) return;
  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
}

function leaseRecord(identity: ProcessIdentity, token: string, durationMs: number): LeaseRecord {
  const now = Date.now();
  return {
    ...identity,
    token,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString()
  };
}

function pinLeaseRecord(generation: string, identity: ProcessIdentity): PinLeaseRecord {
  return { generation, ...leaseRecord(identity, randomUUID(), MANAGEENGINE_PIN_LEASE_MS) };
}

function startPinLease(
  pinPath: string,
  generation: string,
  identity: ProcessIdentity,
  token: string
): Pick<PinnedManageEngineGeneration, "assertValid" | "release"> {
  let released = false;
  let renewals = Promise.resolve();
  let renewalError: Error | null = null;
  const renew = async () => {
    if (renewalError) throw renewalError;
    if (released) return;
    const current = await readLease(pinPath);
    if (!current || !validLeaseIdentity(current) || current.token !== token || current.pid !== identity.pid || current.bootId !== identity.bootId || current.processStart !== identity.processStart) {
      throw new Error("ManageEngine generation pin ownership changed while held.");
    }
    const renewed: PinLeaseRecord = {
      generation,
      ...leaseRecord(identity, current.token, MANAGEENGINE_PIN_LEASE_MS)
    };
    await replacePrivateFile(pinPath, `${JSON.stringify(renewed)}\n`);
  };
  const queueRenewal = () => {
    const renewal = renewals.then(renew);
    renewals = renewal.catch((error) => {
      renewalError ||= error instanceof Error ? error : new Error(String(error));
    });
    return renewals;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, Math.floor(MANAGEENGINE_PIN_LEASE_MS / 3));
  timer.unref();
  return {
    async assertValid() {
      if (released) throw new Error("ManageEngine generation pin has been released.");
      await queueRenewal();
      if (renewalError) throw renewalError;
    },
    async release() {
      if (released) {
        if (renewalError) throw renewalError;
        return;
      }
      released = true;
      clearInterval(timer);
      await renewals;
      const current = await readLease(pinPath);
      if (current?.token === token) await rm(pinPath, { force: true });
      if (renewalError) throw renewalError;
    }
  };
}

function validLeaseIdentity(value: Partial<LeaseRecord>): value is LeaseRecord {
  return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
    && typeof value.bootId === "string" && value.bootId.length > 0
    && typeof value.processStart === "string" && value.processStart.length > 0
    && typeof value.token === "string" && value.token.length > 0
    && typeof value.acquiredAt === "string" && Number.isFinite(Date.parse(value.acquiredAt))
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
}

async function leaseOwnerMatches(value: LeaseRecord): Promise<boolean> {
  try {
    const current = await currentProcessIdentity(value.pid);
    return current.bootId === value.bootId && current.processStart === value.processStart;
  } catch {
    return false;
  }
}

let bootIdentityPromise: Promise<string> | null = null;

async function currentProcessIdentity(pid: number): Promise<ProcessIdentity> {
  return {
    pid,
    bootId: await bootIdentity(),
    processStart: await processStartIdentity(pid)
  };
}

async function bootIdentity(): Promise<string> {
  bootIdentityPromise ||= (async () => {
    try {
      return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    } catch {
      const command = process.platform === "darwin" ? "/usr/sbin/sysctl" : "sysctl";
      const { stdout } = await execFileAsync(command, ["-n", "kern.boottime"]);
      const value = stdout.trim();
      if (!value) throw new Error("Operating-system boot identity is unavailable.");
      return value;
    }
  })();
  return await bootIdentityPromise;
}

async function processStartIdentity(pid: number): Promise<string> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = source.lastIndexOf(")");
    const fields = closing >= 0 ? source.slice(closing + 2).trim().split(/\s+/u) : [];
    const startTicks = fields[19];
    if (!startTicks) throw new Error("Linux process start identity is unavailable.");
    return startTicks;
  } catch (error) {
    if (process.platform === "linux") throw error;
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    const value = stdout.trim();
    if (!value) throw new Error(`Process ${pid} is not running.`);
    return value;
  }
}

async function readLease(path: string): Promise<Partial<LeaseRecord> | null> {
  try {
    return JSON.parse(await readBoundedTextFile(path, 16 * 1024)) as Partial<LeaseRecord>;
  } catch {
    return null;
  }
}

async function verifyGenerationArtifact(path: string, artifact: { path: string; sha256: string; bytes: number }): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== artifact.bytes || before.size > MANAGEENGINE_MAX_ARTIFACT_BYTES) {
      throw new Error(`ManageEngine artifact byte count mismatch: ${artifact.path}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > artifact.bytes || bytes > MANAGEENGINE_MAX_ARTIFACT_BYTES) throw new Error(`ManageEngine artifact exceeds its declared size: ${artifact.path}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (bytes !== artifact.bytes || after.size !== artifact.bytes) throw new Error(`ManageEngine artifact byte count mismatch: ${artifact.path}`);
    if (hash.digest("hex") !== artifact.sha256) throw new Error(`ManageEngine artifact SHA-256 mismatch: ${artifact.path}`);
  } finally {
    await handle.close();
  }
}

async function readBoundedTextFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error(`File exceeds the ${maximumBytes}-byte read limit: ${path}`);
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) throw new Error(`File exceeds the ${maximumBytes}-byte read limit: ${path}`);
    }
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

function pathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function replacePrivateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeSyncedFile(temporary, content);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeSyncedFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncTreeDirectories(root: string, artifacts: GenerationArtifact[]): Promise<void> {
  for (const directory of new Set(artifacts.map((artifact) => dirname(join(root, artifact.generationPath))))) await syncDirectory(directory);
  await syncDirectory(root);
  await syncDirectory(dirname(root));
}

async function replaceWithSymlink(path: string, target: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.link`);
  try {
    await symlink(target, temporary);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
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
  return name === "manageengine" || name === "vigil-manageengine-mdm";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
