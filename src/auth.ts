import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { isLoopbackHostHeader } from "./apiSecurity.js";
import { DATA_DIR } from "./store.js";
import type { UnknownRecord } from "./types.js";

const SESSION_COOKIE = "vigil_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const ACCOUNTS_PATH = join(DATA_DIR, "accounts.json");
const AUTH_SECRET_PATH = join(DATA_DIR, "auth-secret.key");
const AUTH_ATTEMPT_LIMIT = 5;
const AUTH_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_AUTH_ATTEMPT_KEYS = 2_048;
const SENSITIVE_HOSTED_ADMIN_GET_PATHS = new Set([
  "/api/diagnostic/export",
  "/api/devices/ios/mdm/doctor",
  "/api/devices/ios/mdm/enrollment.mobileconfig",
  "/api/devices/ios/profile.mobileconfig"
]);

export const BOOTSTRAP_TOKEN_HEADER = "x-vigil-bootstrap-token";

export type AccountRole = "admin" | "member";

interface StoredAccount {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  passwordSalt: string;
  passwordHash: string;
  sessionVersion: number;
  createdAt: string;
}

interface StoredAccounts {
  version: 1;
  accounts: StoredAccount[];
}

interface SessionPayload {
  sub: string;
  ver: number;
  exp: number;
}

type AuthAttemptKind = "login" | "signup";

interface AuthAttemptBucket {
  count: number;
  resetAt: number;
}

export interface PublicAccount {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
}

export interface AccountSessionSummary {
  hostedAccountsEnabled: boolean;
  signupsEnabled: boolean;
  authenticated: boolean;
  user: PublicAccount | null;
  mode: "local" | "hosted";
}

let cachedSecret: Buffer | null = null;
let accountMutationQueue: Promise<unknown> | null = null;
const authIpAttemptBuckets = new Map<string, AuthAttemptBucket>();
const authAccountAttemptBuckets = new Map<string, AuthAttemptBucket>();

export function hostedAccountsEnabled(): boolean {
  return truthy(process.env.VIGIL_AUTH_ENABLED);
}

export function hostedSignupsEnabled(): boolean {
  return hostedAccountsEnabled() && truthy(process.env.VIGIL_SIGNUPS_ENABLED);
}

export function hostedAdminRequired(method: string, path: string): boolean {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return true;
  if (normalizedMethod !== "GET") return false;
  return SENSITIVE_HOSTED_ADMIN_GET_PATHS.has(path) || path.startsWith("/api/devices/ios/mdm/");
}

function assertHostedAccountsEnabled(): void {
  if (!hostedAccountsEnabled()) throw authError(409, "Hosted accounts are not enabled for this Vigil installation.");
}

export async function accountSession(request: IncomingMessage): Promise<AccountSessionSummary> {
  if (!hostedAccountsEnabled()) {
    return {
      hostedAccountsEnabled: false,
      signupsEnabled: false,
      authenticated: true,
      user: {
        id: "local-admin",
        name: process.env.VIGIL_LOCAL_ADMIN_NAME?.trim() || "James Dunkin",
        email: "",
        role: "admin"
      },
      mode: "local"
    };
  }

  const user = await authenticatedAccount(request);
  return {
    hostedAccountsEnabled: true,
    signupsEnabled: hostedSignupsEnabled(),
    authenticated: Boolean(user),
    user,
    mode: "hosted"
  };
}

export async function createAccount(body: UnknownRecord, request: IncomingMessage): Promise<{ session: AccountSessionSummary; cookie: string }> {
  assertHostedAccountsEnabled();
  if (!hostedSignupsEnabled()) throw authError(403, "New account registration is closed.");

  const email = cleanEmail(body.email);
  recordAuthAttempt("signup", email, request);
  const name = cleanName(body.name);
  const password = cleanPassword(body.password);

  return queueAccountMutation(async () => {
    const store = await loadAccounts();
    if (store.accounts.some((account) => account.email === email)) {
      throw authError(409, "An account with that email already exists.");
    }
    if (store.accounts.length === 0) assertFirstAdminBootstrapAuthorized(request);

    const salt = randomBytes(16);
    const account: StoredAccount = {
      id: randomUUID(),
      name,
      email,
      role: store.accounts.length === 0 ? "admin" : "member",
      passwordSalt: salt.toString("base64"),
      passwordHash: (await derivePassword(password, salt)).toString("base64"),
      sessionVersion: 1,
      createdAt: new Date().toISOString()
    };
    store.accounts.push(account);
    await saveAccounts(store);
    const result = await authenticatedResult(account, request);
    clearAuthAttempts("signup", email, request);
    return result;
  });
}

export async function signInAccount(body: UnknownRecord, request: IncomingMessage): Promise<{ session: AccountSessionSummary; cookie: string }> {
  assertHostedAccountsEnabled();
  const email = cleanEmail(body.email);
  recordAuthAttempt("login", email, request);
  const password = cleanPassword(body.password);
  const store = await loadAccounts();
  const account = store.accounts.find((item) => item.email === email);
  if (!account || !(await passwordMatches(password, account))) {
    throw authError(401, "Email or password is incorrect.");
  }
  const result = await authenticatedResult(account, request);
  clearAuthAttempts("login", email, request);
  return result;
}

export function signOutAccount(request: IncomingMessage): string {
  return serializeCookie("", request, 0);
}

export async function requireHostedAccount(request: IncomingMessage, options: { admin?: boolean } = {}): Promise<PublicAccount | null> {
  if (!hostedAccountsEnabled()) return null;
  const account = await authenticatedAccount(request);
  if (!account) throw authError(401, "Sign in to continue.");
  if (options.admin && account.role !== "admin") throw authError(403, "Administrator access is required.");
  return account;
}

export function authError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function authenticatedResult(account: StoredAccount, request: IncomingMessage): Promise<{ session: AccountSessionSummary; cookie: string }> {
  const user = publicAccount(account);
  return {
    session: {
      hostedAccountsEnabled: true,
      signupsEnabled: hostedSignupsEnabled(),
      authenticated: true,
      user,
      mode: "hosted"
    },
    cookie: serializeCookie(await createSessionToken(account), request, SESSION_TTL_SECONDS)
  };
}

async function authenticatedAccount(request: IncomingMessage): Promise<PublicAccount | null> {
  const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) return null;
  const account = (await loadAccounts()).accounts.find((item) => item.id === payload.sub);
  if (!account || account.sessionVersion !== payload.ver) return null;
  return publicAccount(account);
}

async function createSessionToken(account: StoredAccount): Promise<string> {
  const payload: SessionPayload = {
    sub: account.id,
    ver: account.sessionVersion,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", await authSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expectedSignature = createHmac("sha256", await authSecret()).update(encoded).digest();
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof value.sub !== "string" || !Number.isInteger(value.ver) || !Number.isInteger(value.exp)) return null;
    if ((value.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    return value as SessionPayload;
  } catch {
    return null;
  }
}

async function authSecret(): Promise<Buffer> {
  if (cachedSecret) return cachedSecret;
  await mkdir(dirname(AUTH_SECRET_PATH), { recursive: true });
  try {
    cachedSecret = Buffer.from((await readFile(AUTH_SECRET_PATH, "utf8")).trim(), "base64");
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    const generated = randomBytes(32);
    try {
      await writeFile(AUTH_SECRET_PATH, `${generated.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      cachedSecret = generated;
    } catch (writeError) {
      if (!isNodeErrorCode(writeError, "EEXIST")) throw writeError;
      cachedSecret = Buffer.from((await readFile(AUTH_SECRET_PATH, "utf8")).trim(), "base64");
    }
  }
  if (cachedSecret.length < 32) throw new Error("Vigil auth secret is invalid.");
  return cachedSecret;
}

async function loadAccounts(): Promise<StoredAccounts> {
  try {
    const parsed = JSON.parse(await readFile(ACCOUNTS_PATH, "utf8")) as Partial<StoredAccounts>;
    return {
      version: 1,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { version: 1, accounts: [] };
    throw error;
  }
}

async function saveAccounts(store: StoredAccounts): Promise<void> {
  await mkdir(dirname(ACCOUNTS_PATH), { recursive: true });
  const temp = `${ACCOUNTS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, ACCOUNTS_PATH);
  await chmod(ACCOUNTS_PATH, 0o600);
}

function queueAccountMutation<T>(work: () => Promise<T>): Promise<T> {
  const next = accountMutationQueue ? accountMutationQueue.then(work, work) : work();
  accountMutationQueue = next.catch(() => undefined);
  return next;
}

function publicAccount(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role
  };
}

function serializeCookie(token: string, request: IncomingMessage, maxAge: number): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim().toLowerCase();
  const secure = forwardedProto === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function cookieValue(header: string | undefined, key: string): string {
  for (const pair of String(header || "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === key) return pair.slice(index + 1).trim();
  }
  return "";
}

function assertFirstAdminBootstrapAuthorized(request: IncomingMessage): void {
  if (hostedAccountsEnabled()) {
    if (bootstrapTokenMatches(request)) return;
    throw authError(403, "First administrator creation requires a valid bootstrap token in hosted mode.");
  }
  if (
    isLoopbackHostHeader(request.headers.host)
    && isLoopbackRemoteAddress(request.socket?.remoteAddress)
  ) return;
  if (bootstrapTokenMatches(request)) return;
  throw authError(403, "First administrator creation requires loopback access or a valid bootstrap token.");
}

function isLoopbackRemoteAddress(value: unknown): boolean {
  const address = String(value || "").trim().toLowerCase();
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4)
    && ipv4.split(".").slice(1).every((part) => Number(part) <= 255);
}

function bootstrapTokenMatches(request: IncomingMessage): boolean {
  const expected = String(process.env.VIGIL_BOOTSTRAP_TOKEN || "");
  const supplied = requestHeader(request, BOOTSTRAP_TOKEN_HEADER);
  if (!expected || !supplied) return false;
  const comparisonKey = "vigil-bootstrap-token-comparison";
  const expectedDigest = createHmac("sha256", comparisonKey).update(expected).digest();
  const suppliedDigest = createHmac("sha256", comparisonKey).update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function recordAuthAttempt(kind: AuthAttemptKind, email: string, request: IncomingMessage, now = Date.now()): void {
  pruneAuthAttemptBuckets(now);
  incrementAuthAttemptBucket(authIpAttemptBuckets, authIpAttemptKey(kind, request), now);
  incrementAuthAttemptBucket(authAccountAttemptBuckets, authAccountAttemptKey(kind, email), now);
}

function clearAuthAttempts(kind: AuthAttemptKind, email: string, request: IncomingMessage): void {
  authAccountAttemptBuckets.delete(authAccountAttemptKey(kind, email));
  authIpAttemptBuckets.delete(authIpAttemptKey(kind, request));
}

function pruneAuthAttemptBuckets(now: number): void {
  for (const buckets of [authIpAttemptBuckets, authAccountAttemptBuckets]) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
}

function incrementAuthAttemptBucket(buckets: Map<string, AuthAttemptBucket>, key: string, now: number): void {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now && existing.count >= AUTH_ATTEMPT_LIMIT) {
    throw authError(429, "Too many account attempts. Try again later.");
  }
  if (!existing && buckets.size >= MAX_AUTH_ATTEMPT_KEYS) {
    const oldestKey = buckets.keys().next().value;
    if (typeof oldestKey === "string") buckets.delete(oldestKey);
  }
  buckets.delete(key);
  buckets.set(key, {
    count: existing && existing.resetAt > now ? existing.count + 1 : 1,
    resetAt: existing && existing.resetAt > now ? existing.resetAt : now + AUTH_ATTEMPT_WINDOW_MS
  });
}

function authIpAttemptKey(kind: AuthAttemptKind, request: IncomingMessage): string {
  const remoteAddress = String(request.socket?.remoteAddress || "unknown").trim().toLowerCase() || "unknown";
  return `${kind}\u0000ip\u0000${remoteAddress}`;
}

function authAccountAttemptKey(kind: AuthAttemptKind, email: string): string {
  return `${kind}\u0000account\u0000${email}`;
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : String(value || "");
}

function cleanName(value: unknown): string {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw authError(400, "Enter a name between 2 and 80 characters.");
  return name;
}

function cleanEmail(value: unknown): string {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError(400, "Enter a valid email address.");
  return email;
}

function cleanPassword(value: unknown): string {
  const password = String(value || "");
  if (password.length < 12 || password.length > 200) throw authError(400, "Password must be between 12 and 200 characters.");
  return password;
}

async function passwordMatches(password: string, account: StoredAccount): Promise<boolean> {
  const expected = Buffer.from(account.passwordHash, "base64");
  const actual = await derivePassword(password, Buffer.from(account.passwordSalt, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveValue, rejectValue) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) rejectValue(error);
      else resolveValue(key);
    });
  });
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
