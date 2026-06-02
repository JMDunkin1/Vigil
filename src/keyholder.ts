import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parseBoolean } from "./booleans.js";
import type { KeyholderState, VigilState, UnknownRecord } from "./types.js";

const KEY_LENGTH = 32;

export class KeyholderError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export function keyholderSummary(state: VigilState) {
  const current = state.keyholder;
  return {
    enabled: Boolean(current.enabled),
    hasPasscode: Boolean(current.hash && current.salt),
    updatedAt: current.updatedAt || null
  };
}

export function updateKeyholderSettings(state: VigilState, body: UnknownRecord = {}, now = new Date()) {
  const current = state.keyholder;
  const passcode = String(body.passcode || "");
  const next: KeyholderState = {
    enabled: body.enabled === undefined ? Boolean(current.enabled) : parseBoolean(body.enabled, false),
    salt: current.salt || null,
    hash: current.hash || null,
    updatedAt: current.updatedAt || null
  };

  if (passcode) {
    const salt = randomBytes(16).toString("hex");
    next.salt = salt;
    next.hash = hashPasscode(passcode, salt);
    next.updatedAt = now.toISOString();
  }

  if (next.enabled && (!next.salt || !next.hash)) {
    throw new KeyholderError("Set a keyholder passcode before enabling keyholder mode.", 400);
  }

  state.keyholder = next;
  return keyholderSummary(state);
}

export function assertKeyholderPasscode(state: VigilState, passcode: unknown): void {
  const current = state.keyholder;
  const requiredByTamperLockdown = Boolean(state.integrity?.stateSeal?.tamperDetectedAt && current.salt && current.hash);
  if (!current.enabled && !requiredByTamperLockdown) return;
  if (!current.salt || !current.hash) {
    throw new KeyholderError("Keyholder mode needs a passcode before it can confirm unlocks.", 423);
  }

  const provided = hashPasscode(String(passcode || ""), current.salt);
  const expected = Buffer.from(current.hash, "hex");
  const actual = Buffer.from(provided, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new KeyholderError("Keyholder passcode is incorrect.", 401);
  }
}

function hashPasscode(passcode: string, salt: string): string {
  return scryptSync(passcode, salt, KEY_LENGTH).toString("hex");
}
