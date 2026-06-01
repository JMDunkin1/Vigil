import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parseBoolean, truthy } from "./booleans.js";

const KEY_LENGTH = 32;

export class DistanceKeyError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function distanceKeySummary(state) {
  const current = state.distanceKey || {};
  return {
    enabled: Boolean(current.enabled),
    hasToken: Boolean(current.hash && current.salt),
    keyFilePath: current.keyFilePath || "",
    hasKeyFile: Boolean(current.keyFilePath),
    updatedAt: current.updatedAt || null,
    lastVerifiedAt: current.lastVerifiedAt || null,
    lastFileVerifiedAt: current.lastFileVerifiedAt || null
  };
}

export function updateDistanceKeySettings(state, body = {}, now = new Date()) {
  const current = state.distanceKey || {};
  const next = {
    enabled: body.enabled === undefined ? Boolean(current.enabled) : parseBoolean(body.enabled, false),
    salt: current.salt || null,
    hash: current.hash || null,
    keyFilePath: current.keyFilePath || "",
    updatedAt: current.updatedAt || null,
    lastVerifiedAt: current.lastVerifiedAt || null,
    lastFileVerifiedAt: current.lastFileVerifiedAt || null
  };
  if (body.keyFilePath !== undefined) {
    next.keyFilePath = normalizeKeyFilePath(body.keyFilePath);
  }

  const token = (truthy(body.rotate) || truthy(body.writeKeyFile)) ? generateDistanceKeyToken() : String(body.token || "").trim();

  if (token) {
    const salt = randomBytes(16).toString("hex");
    next.salt = salt;
    next.hash = hashToken(token, salt);
    next.updatedAt = now.toISOString();
    next.lastVerifiedAt = null;
    next.lastFileVerifiedAt = null;
  }

  if (truthy(body.writeKeyFile)) {
    if (!next.keyFilePath) throw new DistanceKeyError("Choose a key-file path before writing the distance key file.", 400);
    writeKeyFile(next.keyFilePath, token);
  }

  if (next.enabled && (!next.salt || !next.hash)) {
    throw new DistanceKeyError("Generate or enter a distance key before enabling distance-key mode.", 400);
  }

  state.distanceKey = next;
  return {
    summary: distanceKeySummary(state),
    token: truthy(body.rotate) && !truthy(body.writeKeyFile) ? token : null,
    keyFilePath: truthy(body.writeKeyFile) ? next.keyFilePath : null
  };
}

export function assertDistanceKey(state, token, now = new Date()) {
  const current = state.distanceKey || {};
  const requiredByTamperLockdown = Boolean(state.integrity?.stateSeal?.tamperDetectedAt && current.salt && current.hash);
  if (!current.enabled && !requiredByTamperLockdown) return;
  if (!current.salt || !current.hash) {
    throw new DistanceKeyError("Distance key needs a token before it can confirm unlocks.", 423);
  }

  const candidate = String(token || "").trim() || readKeyFileToken(current.keyFilePath);
  const provided = hashToken(candidate, current.salt);
  const expected = Buffer.from(current.hash, "hex");
  const actual = Buffer.from(provided, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DistanceKeyError("Distance key is incorrect.", 401);
  }
  current.lastVerifiedAt = now.toISOString();
  if (!String(token || "").trim() && current.keyFilePath) current.lastFileVerifiedAt = now.toISOString();
}

export function generateDistanceKeyToken() {
  const code = randomBytes(6).toString("hex").toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function hashToken(token, salt) {
  return scryptSync(normalizeToken(token), salt, KEY_LENGTH).toString("hex");
}

function normalizeToken(token) {
  return String(token || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeKeyFilePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return resolve(homedir(), text.slice(2));
  return resolve(text);
}

function writeKeyFile(path, token) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
}

function readKeyFileToken(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
