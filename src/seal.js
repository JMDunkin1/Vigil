import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

const ALGORITHM = "hmac-sha256";
const STATE_SCOPE = "state";
const STATE_PROTECTION_VERSION = 1;
const BOOKKEEPING_MISMATCH_STATUS = "bookkeeping-mismatch";
const TRUSTED_MIGRATION_STATUS = "trusted-migration";
const LEGACY_APP_NAME = "Vigil";
const CURRENT_APP_NAME = "Vigil";
const PROTECTED_SETTINGS = [
  "pollIntervalMs",
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
  "foolproofModeEnabled",
  "appQuitEscalationSeconds",
  "siteRedirectEnabled",
  "contentFilterEnabled",
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
  "hostsBlockingEnabled",
  "protectedEditsEnabled",
  "protectedEditDelaySeconds",
  "protectedEditWindowMinutes"
];

export async function verifyStateTextSeal(text, { keyPath, sealPath }) {
  const [key, seal] = await Promise.all([
    readOptional(keyPath),
    readOptional(sealPath)
  ]);
  const hasKey = Boolean(key);
  const hasSeal = Boolean(seal);

  if (!hasKey && !hasSeal) return sealResult("missing", "State file has not been sealed yet.", { hasKey, hasSeal });
  if (!hasKey) return sealResult("missing-key", "State seal key is missing.", { hasKey, hasSeal });
  if (!hasSeal) return sealResult("missing-seal", "State seal file is missing.", { hasKey, hasSeal });

  let parsed;
  try {
    parsed = JSON.parse(seal);
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

export async function writeStateTextSeal(text, { keyPath, sealPath, scope } = {}, sealedAt = new Date().toISOString()) {
  const key = await ensureKey(keyPath);
  const seal = {
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

export function applySealVerificationToState(state, verification, now = new Date()) {
  state.integrity ||= {};
  state.integrity.stateSeal ||= {};
  const seal = state.integrity.stateSeal;
  const previousSealed = Boolean(seal.lastSealedAt);
  const previousSealArtifacts = Boolean(verification.sealedAt || verification.hasKey || verification.hasSeal);
  const tamperStatus = ["mismatch", "missing", "missing-key", "missing-seal", "invalid-seal"];

  seal.lastCheckedAt = now.toISOString();
  seal.lastStatus = verification.status;
  seal.lastDetail = verification.detail;
  if (verification.sealedAt) seal.lastSealedAt = verification.sealedAt;

  if (tamperStatus.includes(verification.status) && (previousSealed || previousSealArtifacts)) {
    seal.tamperDetectedAt ||= now.toISOString();
    seal.tamperDetail = verification.detail;
  }
}

export function markStateSealed(state, sealedAt = new Date().toISOString()) {
  state.integrity ||= {};
  state.integrity.stateSeal ||= {};
  const seal = state.integrity.stateSeal;
  seal.lastCheckedAt = sealedAt;
  seal.lastSealedAt = sealedAt;
  seal.lastStatus = seal.tamperDetectedAt ? "tamper-detected" : "sealed";
  seal.lastDetail = seal.tamperDetectedAt
    ? "State file is sealed, but earlier tampering is still recorded."
    : "State file matches its integrity seal.";
}

export function stateSealSummary(state, liveVerification = null) {
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

export function stateDigest(text, key) {
  return createHmac("sha256", key).update(String(text || ""), "utf8").digest("hex");
}

function repairableProtectedStateDigestMatch(text, seal, key) {
  const expected = String(seal.protectedDigest || "");
  if (seal.scope !== STATE_SCOPE || seal.protectedVersion !== STATE_PROTECTION_VERSION || !expected) return false;
  try {
    const state = JSON.parse(text);
    const snapshot = protectedStateSnapshot(state);
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

function protectedStateDigest(text, key) {
  const state = JSON.parse(text);
  return createHmac("sha256", key).update(stableText(protectedStateSnapshot(state)), "utf8").digest("hex");
}

function protectedSnapshotDigestMatches(snapshot, expected, key) {
  return safeEqualHex(expected, createHmac("sha256", key).update(stableText(snapshot), "utf8").digest("hex"));
}

function trustedProtectedStateMigrationVariants(snapshot) {
  const variants = [];
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
  return variants;
}

function legacyBrandingVariant(snapshot) {
  const settings = snapshot?.settings || {};
  const onName = `${CURRENT_APP_NAME} Focus On`;
  const offName = `${CURRENT_APP_NAME} Focus Off`;
  if (settings.focusShortcutOnName !== onName && settings.focusShortcutOffName !== offName) return null;

  const variant = structuredClone(snapshot);
  if (variant.settings.focusShortcutOnName === onName) {
    variant.settings.focusShortcutOnName = `${LEGACY_APP_NAME} Focus On`;
  }
  if (variant.settings.focusShortcutOffName === offName) {
    variant.settings.focusShortcutOffName = `${LEGACY_APP_NAME} Focus Off`;
  }
  return variant;
}

function intentionalUseSchemaVariants(snapshot) {
  if (!snapshot || (!Object.hasOwn(snapshot, "intentionalUse") && !Object.hasOwn(snapshot?.settings || {}, "intentionalUseEnabled"))) return [];
  const base = structuredClone(snapshot);
  if (base.settings) delete base.settings.intentionalUseEnabled;

  const absent = structuredClone(base);
  delete absent.intentionalUse;

  const empty = structuredClone(base);
  empty.intentionalUse = { accountability: {}, goal: {}, ledger: {}, rules: [] };
  return [absent, empty];
}

function protectedStateSnapshot(state = {}) {
  return {
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
    intentionalUse: protectedIntentionalUse(state.intentionalUse || {}),
    extension: protectedExtension(state.extension || {}),
    keyholder: state.keyholder || {},
    distanceKey: state.distanceKey || {},
    deviceControls: protectedDeviceControls(state.deviceControls || {}),
    maintenance: state.maintenance || {},
    panicLock: state.panicLock || null,
    activeSession: state.activeSession || null,
    emergency: state.emergency || {},
    overrides: state.overrides || [],
    environment: {
      wifiSsid: state.environment?.wifiSsid || ""
    },
    integrity: protectedIntegrity(state.integrity || {})
  };
}

function protectedIntentionalUse(intentionalUse) {
  return {
    goal: intentionalUse.goal || {},
    rules: intentionalUse.rules || [],
    accountability: intentionalUse.accountability || {},
    ledger: intentionalUse.ledger || {}
  };
}

function protectedDeviceControls(deviceControls) {
  const ios = deviceControls.ios || {};
  const mdm = ios.mdm || {};
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
      blockedAppBundleIds: ios.blockedAppBundleIds || [],
      allowedAppBundleIds: ios.allowedAppBundleIds || [],
      deniedUrls: ios.deniedUrls || [],
      allowedUrls: ios.allowedUrls || [],
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
        devices: mdm.devices || [],
        commands: mdm.commands || [],
        lastPolicyHash: mdm.lastPolicyHash || ""
      }
    }
  };
}

function protectedExtension(extension) {
  const dynamicRules = extension.dynamicRules || {};
  return {
    lastSeenAt: extension.lastSeenAt || null,
    lastVersion: extension.lastVersion || null,
    lastHost: extension.lastHost || null,
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

function protectedIntegrity(integrity) {
  const stateSeal = integrity.stateSeal || {};
  const runtime = integrity.runtime || {};
  return {
    stateSeal: {
      tamperDetectedAt: stateSeal.tamperDetectedAt || null,
      tamperDetail: stateSeal.tamperDetail || ""
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

function pick(value = {}, keys = []) {
  return Object.fromEntries(keys.map((key) => [key, value?.[key]]));
}

function stableText(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function ensureKey(keyPath) {
  const existing = await readOptional(keyPath);
  if (existing) return existing.trim();
  await mkdir(dirname(keyPath), { recursive: true });
  const key = randomBytes(32).toString("hex");
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600).catch(() => {});
  return key;
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function sealResult(status, detail, extra = {}) {
  return { ok: false, status, detail, sealedAt: null, checkedAt: new Date().toISOString(), ...extra };
}

function safeEqualHex(expected, actual) {
  if (!/^[a-f0-9]+$/i.test(expected) || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
