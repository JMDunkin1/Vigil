import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { normalizeFocusedSocialSettings } from "./socialFeatureFilters.js";
import type { VigilState, UnknownRecord } from "./types.js";

const ALGORITHM = "hmac-sha256";
const STATE_SCOPE = "state";
const STATE_PROTECTION_VERSION = 1;
const BOOKKEEPING_MISMATCH_STATUS = "bookkeeping-mismatch";
const TRUSTED_MIGRATION_STATUS = "trusted-migration";
const LEGACY_APP_NAME = "Vigil";
const CURRENT_APP_NAME = "Vigil";
export const PROTECTED_SETTINGS = [
  "pollIntervalMs",
  "idleUsageTrackingEnabled",
  "idleUsageThresholdSeconds",
  "strictByDefault",
  "emergencyTokensPerWeek",
  "emergencyDelaySeconds",
  "panicLockDurationMinutes",
  "intentReasonEnabled",
  "intentReasonMinLength",
  "typingChallengeEnabled",
  "interventionEnabled",
  "interventionWindowMinutes",
  "interventionThreshold",
  "interventionExtraDelaySeconds",
  "interventionMaxExtraDelaySeconds",
  "intentionalUseEnabled",
  "runtimeGapLockdownSeconds",
  "clockTamperLockdownSeconds",
  "activeProfileId",
  "baselineProfileId",
  "foolproofModeEnabled",
  "appQuitEscalationSeconds",
  "siteRedirectEnabled",
  "contentFilterEnabled",
  "adultBlocklistEnabled",
  "adultBlocklistSourceId",
  "adultBlocklistCustomUrl",
  "adultBlocklistPreloadLimit",
  "browserNoiseBlockingEnabled",
  "appQuitEnabled",
  "strictBypassProtectionEnabled",
  "processSweepEnabled",
  "processSweepIntervalSeconds",
  "systemSleepLockEnabled",
  "systemSleepLockIntervalSeconds",
  "focusShortcutEnabled",
  "focusShortcutOnName",
  "focusShortcutOffName",
  "systemNetworkBlockingEnabled",
  "safariUrlFilterEnabled",
  "externalNetworkBlockEnabled",
  "externalNetworkBlockProvider",
  "hostsBlockingEnabled",
  "protectedEditsEnabled",
  "protectedEditDelaySeconds",
  "protectedEditWindowMinutes"
] as const;

const protectedSettingKeys = new Set<string>(PROTECTED_SETTINGS);

export function isProtectedSetting(key: string): boolean {
  return protectedSettingKeys.has(key);
}

interface SealPaths {
  keyPath: string;
  sealPath: string;
  scope?: string;
}

interface StateSealFile extends UnknownRecord {
  algorithm?: string;
  digest?: string;
  sealedAt?: string | null;
  scope?: string;
  protectedVersion?: number;
  protectedDigest?: string;
}

interface SealVerification extends UnknownRecord {
  ok: boolean;
  status: string;
  detail: string;
  sealedAt: string | null;
  checkedAt: string;
  hasKey?: boolean;
  hasSeal?: boolean;
  repairable?: boolean;
}

type ProtectedSnapshot = UnknownRecord;

export async function verifyStateTextSeal(text: string, { keyPath, sealPath }: SealPaths): Promise<SealVerification> {
  const [key, seal] = await Promise.all([
    readOptional(keyPath),
    readOptional(sealPath)
  ]);
  const hasKey = Boolean(key);
  const hasSeal = Boolean(seal);

  if (!hasKey && !hasSeal) return sealResult("missing", "State file has not been sealed yet.", { hasKey, hasSeal });
  if (!hasKey) return sealResult("missing-key", "State seal key is missing.", { hasKey, hasSeal });
  if (!hasSeal) return sealResult("missing-seal", "State seal file is missing.", { hasKey, hasSeal });

  let parsed: StateSealFile;
  try {
    parsed = asRecord(JSON.parse(seal)) as StateSealFile;
  } catch {
    return sealResult("invalid-seal", "State seal file is not valid JSON.", { hasKey, hasSeal });
  }
  if (parsed.algorithm !== ALGORITHM) {
    return sealResult("invalid-seal", "State seal file uses an unknown algorithm.", { hasKey, hasSeal, sealedAt: parsed.sealedAt || null });
  }

  const expected = String(parsed.digest || "");
  const trimmedKey = key.trim();
  const actual = stateDigest(text, trimmedKey);
  if (!safeEqualHex(expected, actual)) {
    const repair = repairableProtectedStateDigestMatch(text, parsed, trimmedKey);
    if (repair) {
      return {
        ok: true,
        status: repair.status,
        detail: repair.detail,
        sealedAt: parsed.sealedAt || null,
        checkedAt: new Date().toISOString(),
        hasKey,
        hasSeal,
        repairable: true
      };
    }
    return sealResult("mismatch", "State file does not match its integrity seal.", { hasKey, hasSeal, sealedAt: parsed.sealedAt || null });
  }

  return {
    ok: true,
    status: "sealed",
    detail: "State file matches its integrity seal.",
    sealedAt: parsed.sealedAt || null,
    checkedAt: new Date().toISOString(),
    hasKey,
    hasSeal
  };
}

export async function writeStateTextSeal(text: string, { keyPath, sealPath, scope }: SealPaths, sealedAt = new Date().toISOString()): Promise<StateSealFile> {
  const key = await ensureKey(keyPath);
  const seal: StateSealFile = {
    algorithm: ALGORITHM,
    digest: stateDigest(text, key),
    sealedAt
  };
  if (scope === STATE_SCOPE) {
    seal.scope = STATE_SCOPE;
    seal.protectedVersion = STATE_PROTECTION_VERSION;
    seal.protectedDigest = protectedStateDigest(text, key);
  }
  await mkdir(dirname(sealPath), { recursive: true });
  const tempPath = `${sealPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => {});
  await rename(tempPath, sealPath);
  await chmod(sealPath, 0o600).catch(() => {});
  return seal;
}

export function applySealVerificationToState(state: VigilState, verification: SealVerification, now = new Date()): void {
  state.integrity.stateSeal ||= {};
  const seal = state.integrity.stateSeal;
  const tamperStatus = ["mismatch", "missing", "missing-key", "missing-seal", "invalid-seal"];
  const detail = verification.status === "missing"
    ? "An existing state file has no integrity key or seal. Both seal artifacts may have been removed."
    : verification.detail;

  seal.lastCheckedAt = now.toISOString();
  seal.lastStatus = verification.status;
  seal.lastDetail = detail;
  if (verification.sealedAt) seal.lastSealedAt = verification.sealedAt;

  if (tamperStatus.includes(verification.status)) {
    seal.tamperDetectedAt ||= now.toISOString();
    seal.tamperDetail = detail;
  }
}

export function markStateSealed(state: VigilState, sealedAt = new Date().toISOString()): void {
  state.integrity.stateSeal ||= {};
  const seal = state.integrity.stateSeal;
  seal.lastCheckedAt = sealedAt;
  seal.lastSealedAt = sealedAt;
  seal.lastStatus = seal.tamperDetectedAt ? "tamper-detected" : "sealed";
  seal.lastDetail = seal.tamperDetectedAt
    ? "State file is sealed, but earlier tampering is still recorded."
    : "State file matches its integrity seal.";
}

export function stateSealSummary(state: Partial<VigilState> | null | undefined, liveVerification: SealVerification | null = null) {
  const seal = state?.integrity?.stateSeal || {};
  const status = seal.tamperDetectedAt ? "tamper-detected" : (liveVerification?.status || seal.lastStatus || "unknown");
  const detail = seal.tamperDetectedAt
    ? (seal.tamperDetail || "Manual state-file tampering was detected.")
    : (liveVerification?.detail || seal.lastDetail || "State seal has not been checked yet.");
  return {
    ok: status === "sealed" || status === BOOKKEEPING_MISMATCH_STATUS || status === TRUSTED_MIGRATION_STATUS,
    status,
    detail,
    tamperDetectedAt: seal.tamperDetectedAt || null,
    lastCheckedAt: liveVerification?.checkedAt || seal.lastCheckedAt || null,
    lastSealedAt: liveVerification?.sealedAt || seal.lastSealedAt || null
  };
}

export function stateDigest(text: string, key: string): string {
  return createHmac("sha256", key).update(String(text || ""), "utf8").digest("hex");
}

function repairableProtectedStateDigestMatch(text: string, seal: StateSealFile, key: string): { status: string; detail: string } | null {
  const expected = String(seal.protectedDigest || "");
  if (seal.scope !== STATE_SCOPE || seal.protectedVersion !== STATE_PROTECTION_VERSION || !expected) return null;
  try {
    const state: unknown = JSON.parse(text);
    const snapshot = protectedStateSnapshot(asRecord(state));
    if (protectedSnapshotDigestMatches(snapshot, expected, key)) {
      return {
        status: BOOKKEEPING_MISMATCH_STATUS,
        detail: "State file changed only in unprotected runtime bookkeeping; the seal can be refreshed without entering lockdown."
      };
    }

    for (const variant of trustedProtectedStateMigrationVariants(snapshot)) {
      if (protectedSnapshotDigestMatches(variant.snapshot, expected, key)) {
        return {
          status: TRUSTED_MIGRATION_STATUS,
          detail: variant.detail
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function protectedStateDigest(text: string, key: string): string {
  const state = asRecord(JSON.parse(text));
  return createHmac("sha256", key).update(stableText(protectedStateSnapshot(state)), "utf8").digest("hex");
}

function protectedSnapshotDigestMatches(snapshot: ProtectedSnapshot, expected: string, key: string): boolean {
  return safeEqualHex(expected, createHmac("sha256", key).update(stableText(snapshot), "utf8").digest("hex"));
}

function trustedProtectedStateMigrationVariants(snapshot: ProtectedSnapshot): Array<{ snapshot: ProtectedSnapshot; detail: string }> {
  const variants: Array<{ snapshot: ProtectedSnapshot; detail: string }> = [];
  const legacyBranding = legacyBrandingVariant(snapshot);
  if (legacyBranding) {
    variants.push({
      snapshot: legacyBranding,
      detail: "State file changed only by the trusted Vigil to Vigil branding migration; the seal can be refreshed without entering lockdown."
    });
  }
  for (const intentionalUseSchema of intentionalUseSchemaVariants(snapshot)) {
    variants.push({
      snapshot: intentionalUseSchema,
      detail: "State file changed only by the trusted Intentional Use protected-state schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  for (const grayscaleSchema of grayscaleSchemaVariants(snapshot)) {
    variants.push({
      snapshot: grayscaleSchema,
      detail: "State file changed only by the trusted Grayscale protected-state schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  for (const externalNetworkSchema of externalNetworkSchemaVariants(snapshot)) {
    variants.push({
      snapshot: externalNetworkSchema,
      detail: "State file changed only by the trusted external DNS/router protected-state schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  for (const activeSessionsSchema of activeSessionsSchemaVariants(snapshot)) {
    variants.push({
      snapshot: activeSessionsSchema,
      detail: "State file changed only by the trusted per-device sessions protected-state schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  for (const usageSealSchema of usageSealSchemaVariants(snapshot)) {
    variants.push({
      snapshot: usageSealSchema,
      detail: "State file changed only by the trusted usage-seal protected-state schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  const enforcementSchema = enforcementStateSchemaVariant(snapshot);
  if (enforcementSchema) {
    variants.push({
      snapshot: enforcementSchema,
      detail: "State file changed only by the trusted enforcement-state seal schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  const iosEnforcementSchema = iosEnforcementStateSchemaVariant(snapshot);
  if (iosEnforcementSchema) {
    variants.push({
      snapshot: iosEnforcementSchema,
      detail: "State file changed only by the trusted iOS enforcement-state seal schema migration; the seal can be refreshed without entering lockdown."
    });
  }
  return variants;
}

function usageSealSchemaVariants(snapshot: ProtectedSnapshot): ProtectedSnapshot[] {
  const integrity = asRecord(snapshot.integrity);
  if (!Object.hasOwn(integrity, "usageSeal")) return [];
  const variants: ProtectedSnapshot[] = [];
  const absent = structuredClone(snapshot);
  delete asRecord(absent.integrity).usageSeal;
  variants.push(absent);

  const usageSeal = asRecord(integrity.usageSeal);
  if (usageSeal.required === true && Number(usageSeal.migrationVersion) >= 1) {
    const unmigrated = structuredClone(snapshot);
    asRecord(unmigrated.integrity).usageSeal = {
      required: false,
      migrationVersion: 0,
      migratedAt: null
    };
    variants.push(unmigrated);
  }
  return variants;
}

function enforcementStateSchemaVariant(snapshot: ProtectedSnapshot): ProtectedSnapshot | null {
  if (!snapshot || !Object.hasOwn(snapshot, "adultBlocklist")) return null;
  const variant = structuredClone(snapshot);
  delete variant.adultBlocklist;
  const intentionalUse = asRecord(variant.intentionalUse);
  delete intentionalUse.pauses;
  delete intentionalUse.grants;
  delete intentionalUse.planBlocks;
  const deviceControls = asRecord(variant.deviceControls);
  const ios = asRecord(deviceControls.ios);
  const mdm = asRecord(ios.mdm);
  delete ios.allowSafariHistoryClearing;
  delete mdm.enrollmentTokens;
  delete mdm.lastGrayscaleHash;
  return variant;
}

function iosEnforcementStateSchemaVariant(snapshot: ProtectedSnapshot): ProtectedSnapshot | null {
  const deviceControls = asRecord(snapshot.deviceControls);
  const ios = asRecord(deviceControls.ios);
  const mdm = asRecord(ios.mdm);
  if (!Object.hasOwn(ios, "allowSafariHistoryClearing") || !Object.hasOwn(mdm, "lastGrayscaleHash")) return null;
  const variant = structuredClone(snapshot);
  const variantIos = asRecord(asRecord(variant.deviceControls).ios);
  const variantMdm = asRecord(variantIos.mdm);
  delete variantIos.allowSafariHistoryClearing;
  delete variantMdm.lastGrayscaleHash;
  return variant;
}

function legacyBrandingVariant(snapshot: ProtectedSnapshot): ProtectedSnapshot | null {
  const settings = asRecord(snapshot.settings);
  const onName = `${CURRENT_APP_NAME} Focus On`;
  const offName = `${CURRENT_APP_NAME} Focus Off`;
  if (settings.focusShortcutOnName !== onName && settings.focusShortcutOffName !== offName) return null;

  const variant = structuredClone(snapshot);
  const variantSettings = asRecord(variant.settings);
  if (variantSettings.focusShortcutOnName === onName) {
    variantSettings.focusShortcutOnName = `${LEGACY_APP_NAME} Focus On`;
  }
  if (variantSettings.focusShortcutOffName === offName) {
    variantSettings.focusShortcutOffName = `${LEGACY_APP_NAME} Focus Off`;
  }
  return variant;
}

function intentionalUseSchemaVariants(snapshot: ProtectedSnapshot): ProtectedSnapshot[] {
  if (!snapshot || (!Object.hasOwn(snapshot, "intentionalUse") && !Object.hasOwn(asRecord(snapshot.settings), "intentionalUseEnabled"))) return [];
  const base = structuredClone(snapshot);
  const baseSettings = asRecord(base.settings);
  if (base.settings) delete baseSettings.intentionalUseEnabled;

  const absent = structuredClone(base);
  delete absent.intentionalUse;

  const currentEmpty = structuredClone(base);
  currentEmpty.intentionalUse = protectedIntentionalUse({});

  const empty = structuredClone(base);
  empty.intentionalUse = { accountability: {}, goal: {}, ledger: {}, rules: [] };
  return [base, absent, currentEmpty, empty];
}

function grayscaleSchemaVariants(snapshot: ProtectedSnapshot): ProtectedSnapshot[] {
  if (!snapshot || !Object.hasOwn(snapshot, "grayscale")) return [];
  const grayscale = asRecord(snapshot.grayscale);
  if (stableText(grayscale) !== stableText(protectedGrayscale({}))) return [];
  const absent = structuredClone(snapshot);
  delete absent.grayscale;
  return [absent];
}

function externalNetworkSchemaVariants(snapshot: ProtectedSnapshot): ProtectedSnapshot[] {
  const settings = asRecord(snapshot.settings);
  if (
    settings.externalNetworkBlockEnabled !== false ||
    settings.externalNetworkBlockProvider !== "manual"
  ) return [];
  const absent = structuredClone(snapshot);
  const absentSettings = asRecord(absent.settings);
  delete absentSettings.externalNetworkBlockEnabled;
  delete absentSettings.externalNetworkBlockProvider;
  return [absent];
}

function activeSessionsSchemaVariants(snapshot: ProtectedSnapshot): ProtectedSnapshot[] {
  if (!snapshot || !Object.hasOwn(snapshot, "activeSessions")) return [];
  const activeSession = snapshot.activeSession || null;
  const activeSessions = asRecord(snapshot.activeSessions);
  const migratedComputerOnly = {
    computer: activeSession,
    phone: null
  };
  const migratedBothDevices = {
    computer: activeSession,
    phone: activeSession
  };
  const variants: ProtectedSnapshot[] = [];
  const activeSessionsText = stableText(activeSessions);
  const matchesComputerOnly = activeSessionsText === stableText(migratedComputerOnly);
  const matchesBothDevices = Boolean(activeSession) && activeSessionsText === stableText(migratedBothDevices);
  if (!matchesComputerOnly && !matchesBothDevices) return variants;

  const absent = structuredClone(snapshot);
  delete absent.activeSessions;
  variants.push(absent);

  if (matchesBothDevices) {
    const computerOnly = structuredClone(snapshot);
    computerOnly.activeSessions = migratedComputerOnly;
    variants.push(computerOnly);
  }
  return variants;
}

function protectedStateSnapshot(state: UnknownRecord = {}): ProtectedSnapshot {
  const snapshot: ProtectedSnapshot = {
    version: state.version ?? null,
    settings: pick(state.settings, PROTECTED_SETTINGS),
    profiles: state.profiles || [],
    schedules: state.schedules || [],
    limitRules: state.limitRules || [],
    limitBlocks: state.limitBlocks || [],
    appLocks: state.appLocks || [],
    appLockUnlocks: state.appLockUnlocks || [],
    appLockRequests: state.appLockRequests || [],
    appLockLedger: state.appLockLedger || {},
    adultBlocklist: protectedAdultBlocklist(state.adultBlocklist || {}),
    intentionalUse: protectedIntentionalUse(state.intentionalUse || {}),
    extension: protectedExtension(state.extension || {}),
    keyholder: state.keyholder || {},
    distanceKey: state.distanceKey || {},
    deviceControls: protectedDeviceControls(state.deviceControls || {}),
    maintenance: state.maintenance || {},
    panicLock: state.panicLock || null,
    activeSessions: protectedActiveSessions(state.activeSessions || {}, state.activeSession || null),
    activeSession: state.activeSession || null,
    emergency: state.emergency || {},
    overrides: state.overrides || [],
    environment: {
      wifiSsid: asRecord(state.environment).wifiSsid || ""
    },
    integrity: protectedIntegrity(state.integrity || {})
  };
  if (Object.hasOwn(state, "grayscale")) {
    snapshot.grayscale = protectedGrayscale(state.grayscale || {});
  }
  return snapshot;
}

function protectedActiveSessions(activeSessions: unknown, activeSession: unknown): UnknownRecord {
  const sessions = asRecord(activeSessions);
  return {
    computer: sessions.computer || activeSession || null,
    phone: sessions.phone || null
  };
}

function protectedIntentionalUse(intentionalUse: unknown): UnknownRecord {
  const record = asRecord(intentionalUse);
  return {
    goal: record.goal || {},
    rules: record.rules || [],
    pauses: record.pauses || [],
    grants: record.grants || [],
    planBlocks: record.planBlocks || [],
    accountability: record.accountability || {},
    ledger: record.ledger || {}
  };
}

function protectedAdultBlocklist(adultBlocklist: unknown): UnknownRecord {
  const record = asRecord(adultBlocklist);
  return {
    allowlist: record.allowlist || [],
    domainCount: record.domainCount || 0,
    activeDomainCount: record.activeDomainCount || 0,
    hash: record.hash || "",
    snapshotPath: record.snapshotPath || "",
    lastRefreshAt: record.lastRefreshAt || null,
    source: record.source || null
  };
}

function protectedGrayscale(grayscale: unknown): UnknownRecord {
  const record = asRecord(grayscale);
  return {
    softBlockEnabled: Boolean(record.softBlockEnabled),
    preventManualChanges: record.preventManualChanges === false ? false : true,
    schedules: Array.isArray(record.schedules) ? record.schedules : []
  };
}

function protectedDeviceControls(deviceControls: unknown): UnknownRecord {
  const controls = asRecord(deviceControls);
  const ios = asRecord(controls.ios);
  const mdm = asRecord(ios.mdm);
  return {
    ios: {
      enabled: ios.enabled,
      status: ios.status,
      mode: ios.mode,
      webMode: ios.webMode,
      blockApps: ios.blockApps,
      blockWeb: ios.blockWeb,
      hardenRemoval: ios.hardenRemoval,
      restrictInstallAndErase: ios.restrictInstallAndErase,
      allowSafariHistoryClearing: ios.allowSafariHistoryClearing,
      blockedAppBundleIds: ios.blockedAppBundleIds || [],
      allowedAppBundleIds: ios.allowedAppBundleIds || [],
      deniedUrls: ios.deniedUrls || [],
      allowedUrls: ios.allowedUrls || [],
      focusedSocial: normalizeFocusedSocialSettings(ios.focusedSocial),
      removalPassword: ios.removalPassword || null,
      mdm: {
        enabled: mdm.enabled,
        publicBaseUrl: mdm.publicBaseUrl || "",
        topic: mdm.topic || "",
        identityCertificateUuid: mdm.identityCertificateUuid || "",
        identityCertificatePayloadBase64: mdm.identityCertificatePayloadBase64 || "",
        identityCertificatePassword: mdm.identityCertificatePassword || "",
        pushCertificatePayloadBase64: mdm.pushCertificatePayloadBase64 || "",
        pushCertificatePassword: mdm.pushCertificatePassword || "",
        accessRights: mdm.accessRights,
        signMessage: mdm.signMessage,
        useDevelopmentApns: mdm.useDevelopmentApns,
        checkOutWhenRemoved: mdm.checkOutWhenRemoved,
        enrollmentSecret: mdm.enrollmentSecret || "",
        enrollmentTokens: mdm.enrollmentTokens || [],
        devices: mdm.devices || [],
        commands: mdm.commands || [],
        lastPolicyHash: mdm.lastPolicyHash || "",
        lastGrayscaleHash: mdm.lastGrayscaleHash || ""
      }
    }
  };
}

function protectedExtension(extension: unknown): UnknownRecord {
  const record = asRecord(extension);
  const dynamicRules = asRecord(record.dynamicRules);
  return {
    lastSeenAt: record.lastSeenAt || null,
    lastVersion: record.lastVersion || null,
    lastHost: record.lastHost || null,
    dynamicRules: {
      count: dynamicRules.count || 0,
      expectedCount: dynamicRules.expectedCount || 0,
      signature: dynamicRules.signature || "",
      expectedSignature: dynamicRules.expectedSignature || "",
      status: dynamicRules.status || "",
      ok: Boolean(dynamicRules.ok),
      fallbackRequired: Boolean(dynamicRules.fallbackRequired)
    }
  };
}

function protectedIntegrity(integrity: unknown): UnknownRecord {
  const record = asRecord(integrity);
  const stateSeal = asRecord(record.stateSeal);
  const usageSeal = asRecord(record.usageSeal);
  const runtime = asRecord(record.runtime);
  return {
    stateSeal: {
      tamperDetectedAt: stateSeal.tamperDetectedAt || null,
      tamperDetail: stateSeal.tamperDetail || ""
    },
    usageSeal: {
      required: usageSeal.required === true,
      migrationVersion: usageSeal.migrationVersion ?? 0,
      migratedAt: typeof usageSeal.migratedAt === "string" ? usageSeal.migratedAt : null
    },
    runtime: {
      downtimeDetectedAt: runtime.downtimeDetectedAt || null,
      downtimeDetail: runtime.downtimeDetail || "",
      hardeningDriftDetectedAt: runtime.hardeningDriftDetectedAt || null,
      hardeningDriftDetail: runtime.hardeningDriftDetail || "",
      hardeningDriftIssues: runtime.hardeningDriftIssues || [],
      clockTamperDetectedAt: runtime.clockTamperDetectedAt || null,
      clockTamperDetail: runtime.clockTamperDetail || "",
      clockTamperSeconds: runtime.clockTamperSeconds || 0,
      clockTamperDirection: runtime.clockTamperDirection || ""
    }
  };
}

function pick(value: unknown = {}, keys: readonly string[] = []): UnknownRecord {
  const record = asRecord(value);
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function stableText(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as UnknownRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
}

async function ensureKey(keyPath: string): Promise<string> {
  const existing = await readOptional(keyPath);
  if (existing) return existing.trim();
  await mkdir(dirname(keyPath), { recursive: true });
  const key = randomBytes(32).toString("hex");
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600).catch(() => {});
  return key;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function sealResult(status: string, detail: string, extra: Partial<SealVerification> = {}): SealVerification {
  return { ok: false, status, detail, sealedAt: null, checkedAt: new Date().toISOString(), ...extra };
}

function safeEqualHex(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]+$/i.test(expected) || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
