import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { clampNumber } from "./time.js";
import type { JournalVaultState, VigilState, UnknownRecord } from "./types.js";

const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 256;
const SESSION_TOKEN_BYTES = 32;
const HASH_BYTES = 32;
const TOUCH_ID_SECRET_HEADER = "x-vigil-touch-id-secret";

interface JournalVaultSession {
  token: string;
  createdAt: string;
  expiresAt: string;
  method: "password" | "touch-id";
}

const sessions = new Map<string, JournalVaultSession>();

export class JournalVaultError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeJournalVaultState(
  current: Partial<JournalVaultState> = {},
  fresh: Partial<JournalVaultState> = {}
): JournalVaultState {
  return {
    passwordSalt: String(current.passwordSalt || fresh.passwordSalt || ""),
    passwordHash: String(current.passwordHash || fresh.passwordHash || ""),
    passwordSetAt: current.passwordSetAt || fresh.passwordSetAt || null,
    autoLockMinutes: clampNumber(current.autoLockMinutes ?? fresh.autoLockMinutes, 1, 120, 15)
  };
}

export function journalVaultSummary(state: VigilState) {
  const vault = normalizeJournalVaultState(state.intentionalUse?.journalVault || {});
  return {
    configured: journalVaultConfigured(vault),
    passwordSetAt: vault.passwordSetAt,
    autoLockMinutes: vault.autoLockMinutes,
    touchIdAvailable: Boolean(process.env.VIGIL_TOUCH_ID_SECRET),
    entries: state.intentionalUse?.journalEntries?.length || 0
  };
}

export function journalVaultConfigured(vault: Partial<JournalVaultState> | undefined): boolean {
  return Boolean(vault?.passwordSalt && vault?.passwordHash);
}

export function setJournalVaultPassword(state: VigilState, body: UnknownRecord = {}, now = new Date()) {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  const nextPassword = normalizePassword(body.password);
  if (journalVaultConfigured(vault)) {
    const currentPassword = String(body.currentPassword || "");
    if (!verifyJournalVaultPassword(vault, currentPassword)) {
      throw new JournalVaultError("Current journal password is incorrect.", 401);
    }
  }

  const salt = randomBytes(16).toString("hex");
  state.intentionalUse.journalVault = {
    passwordSalt: salt,
    passwordHash: passwordHash(nextPassword, salt),
    passwordSetAt: now.toISOString(),
    autoLockMinutes: clampNumber(body.autoLockMinutes, 1, 120, vault.autoLockMinutes || 15)
  };
  revokeAllJournalVaultSessions();
  return journalVaultSummary(state);
}

export function unlockJournalVaultWithPassword(state: VigilState, body: UnknownRecord = {}, now = new Date()) {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  if (!journalVaultConfigured(vault)) {
    throw new JournalVaultError("Set a journal password before unlocking the journal.", 409);
  }
  if (!verifyJournalVaultPassword(vault, String(body.password || ""))) {
    throw new JournalVaultError("Journal password is incorrect.", 401);
  }
  return createJournalVaultSession(vault, "password", now);
}

export function unlockJournalVaultWithTouchId(
  state: VigilState,
  headers: IncomingHttpHeaders,
  now = new Date()
) {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  if (!journalVaultConfigured(vault)) {
    throw new JournalVaultError("Set a journal password before enabling Touch ID fallback.", 409);
  }
  if (!validTouchIdSecret(headers)) {
    throw new JournalVaultError("Touch ID proof was not accepted.", 403);
  }
  return createJournalVaultSession(vault, "touch-id", now);
}

export function requireJournalVaultSession(
  state: VigilState,
  headers: IncomingHttpHeaders,
  now = new Date()
): JournalVaultSession | null {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  if (!journalVaultConfigured(vault)) return null;
  cleanupSessions(now);
  const token = headerValue(headers["x-vigil-journal-token"]);
  const session = token ? sessions.get(token) || null : null;
  if (!session || Date.parse(session.expiresAt) <= now.getTime()) {
    if (token) sessions.delete(token);
    throw new JournalVaultError("Unlock the journal to continue.", 401);
  }
  return session;
}

export function revokeJournalVaultSession(headers: IncomingHttpHeaders): boolean {
  const token = headerValue(headers["x-vigil-journal-token"]);
  return Boolean(token && sessions.delete(token));
}

export function revokeAllJournalVaultSessions(): void {
  sessions.clear();
}

export function verifyJournalVaultPassword(vault: Partial<JournalVaultState>, password: string): boolean {
  if (!journalVaultConfigured(vault) || !password) return false;
  const actual = passwordHash(password, String(vault.passwordSalt));
  const expectedBuffer = Buffer.from(String(vault.passwordHash), "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function createJournalVaultSession(
  vault: JournalVaultState,
  method: JournalVaultSession["method"],
  now: Date
) {
  cleanupSessions(now);
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + vault.autoLockMinutes * 60_000).toISOString();
  const session: JournalVaultSession = {
    token,
    createdAt: now.toISOString(),
    expiresAt,
    method
  };
  sessions.set(token, session);
  return session;
}

function cleanupSessions(now: Date): void {
  for (const [token, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now.getTime()) sessions.delete(token);
  }
}

function normalizePassword(value: unknown): string {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new JournalVaultError(`Journal password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new JournalVaultError(`Journal password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return password;
}

function passwordHash(password: string, salt: string): string {
  return scryptSync(password, salt, HASH_BYTES).toString("hex");
}

function validTouchIdSecret(headers: IncomingHttpHeaders): boolean {
  const expected = process.env.VIGIL_TOUCH_ID_SECRET || "";
  const actual = headerValue(headers[TOUCH_ID_SECRET_HEADER]);
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}
