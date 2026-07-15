import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { parseBoolean, truthy } from "./booleans.js";
import { registerPersistenceRollback } from "./store.js";
import type { DistanceKeyState, VigilState, UnknownRecord } from "./types.js";

const KEY_LENGTH = 32;

export class DistanceKeyError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export function distanceKeySummary(state: VigilState) {
  const current = state.distanceKey;
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

export function updateDistanceKeySettings(state: VigilState, body: UnknownRecord = {}, now = new Date()) {
  const current = state.distanceKey;
  const next: DistanceKeyState = {
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
    registerPersistenceRollback(() => unlinkSync(next.keyFilePath));
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

export function assertDistanceKey(state: VigilState, token: unknown, now = new Date()): void {
  const current = state.distanceKey;
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

export function generateDistanceKeyToken(): string {
  const code = randomBytes(6).toString("hex").toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function hashToken(token: unknown, salt: string): string {
  return scryptSync(normalizeToken(token), salt, KEY_LENGTH).toString("hex");
}

function normalizeToken(token: unknown): string {
  return String(token || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeKeyFilePath(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return resolve(homedir(), text.slice(2));
  return resolve(text);
}

function writeKeyFile(path: string, token: string): void {
  const directory = dirname(path);
  assertNoSymlinkComponents(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(directory);

  let descriptor = -1;
  let created = false;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    created = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${token}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original write error; a newly-created partial file is never reused.
      }
    }
    if (isNodeErrorCode(error, "EEXIST") || isNodeErrorCode(error, "ELOOP")) {
      throw new DistanceKeyError(
        `Distance key file already exists or is a symbolic link: ${path}. Choose a new path, or move the existing file first.`,
        409
      );
    }
    throw error;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        try {
          accessSync(dirname(current), fsConstants.W_OK);
          throw new DistanceKeyError(`Distance key path cannot pass through a replaceable symbolic link: ${current}.`, 400);
        } catch (error) {
          if (error instanceof DistanceKeyError) throw error;
          if (
            !isNodeErrorCode(error, "EACCES")
            && !isNodeErrorCode(error, "EPERM")
            && !isNodeErrorCode(error, "EROFS")
          ) throw error;
        }
      }
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) continue;
      throw error;
    }
  }
}

function readKeyFileToken(path: string): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
