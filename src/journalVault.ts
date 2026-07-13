import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDefaultDataDir } from "./dataPaths.js";
import { clampNumber } from "./time.js";
import { getTouchIdSecret } from "./touchIdAuth.js";
import type { JournalVaultState, VigilState, UnknownRecord } from "./types.js";

const SESSION_TOKEN_BYTES = 32;
const TOUCH_ID_SECRET_HEADER = "x-vigil-touch-id-secret";
const DEFAULT_DATA_DIR = process.env.VIGIL_DATA_DIR || resolveDefaultDataDir(dirname(dirname(fileURLToPath(import.meta.url))));

interface JournalVaultSession {
  token: string;
  createdAt: string;
  expiresAt: string;
  method: "touch-id";
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
    configured: true,
    autoLockMinutes: vault.autoLockMinutes,
    touchIdAvailable: process.platform === "darwin",
    entries: state.intentionalUse?.journalEntries?.length || 0
  };
}

export function setJournalVaultAutoLockMinutes(state: VigilState, body: UnknownRecord = {}) {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  state.intentionalUse.journalVault = {
    ...vault,
    autoLockMinutes: clampNumber(body.autoLockMinutes, 1, 120, vault.autoLockMinutes || 15)
  };
  revokeAllJournalVaultSessions();
  return journalVaultSummary(state);
}

export async function unlockJournalVaultWithTouchId(
  state: VigilState,
  headers: IncomingHttpHeaders,
  now = new Date(),
  dataDir = DEFAULT_DATA_DIR
) {
  const vault = normalizeJournalVaultState(state.intentionalUse.journalVault || {});
  if (!await validTouchIdSecret(headers, dataDir)) {
    throw new JournalVaultError("Touch ID proof was not accepted.", 403);
  }
  return createJournalVaultSession(vault, "touch-id", now);
}

export function requireJournalVaultSession(
  _state: VigilState,
  headers: IncomingHttpHeaders,
  now = new Date()
): JournalVaultSession | null {
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

async function validTouchIdSecret(headers: IncomingHttpHeaders, dataDir: string): Promise<boolean> {
  const expected = await getTouchIdSecret(dataDir);
  const actual = headerValue(headers[TOUCH_ID_SECRET_HEADER]);
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}
