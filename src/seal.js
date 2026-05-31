import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

const ALGORITHM = "hmac-sha256";

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
  const actual = stateDigest(text, key.trim());
  if (!safeEqualHex(expected, actual)) {
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

export async function writeStateTextSeal(text, { keyPath, sealPath }, sealedAt = new Date().toISOString()) {
  const key = await ensureKey(keyPath);
  const seal = {
    algorithm: ALGORITHM,
    digest: stateDigest(text, key),
    sealedAt
  };
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
    ok: status === "sealed",
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
