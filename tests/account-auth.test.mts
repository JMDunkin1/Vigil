import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "sentinel-account-auth-"));
const previous = {
  dataDir: process.env.SENTINEL_DATA_DIR,
  auth: process.env.SENTINEL_AUTH_ENABLED,
  signups: process.env.SENTINEL_SIGNUPS_ENABLED,
  bootstrap: process.env.SENTINEL_BOOTSTRAP_TOKEN
};

try {
  process.env.SENTINEL_DATA_DIR = dataDir;
  process.env.SENTINEL_AUTH_ENABLED = "1";
  delete process.env.SENTINEL_SIGNUPS_ENABLED;
  process.env.SENTINEL_BOOTSTRAP_TOKEN = "local-bootstrap-secret";
  const auth = await import("../src/auth.js");

  assert.equal(auth.hostedSignupsEnabled(), false);
  await assert.rejects(auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request({ host: "127.0.0.1:8787" })), hasStatus(403, /registration is closed/i));

  process.env.SENTINEL_SIGNUPS_ENABLED = "1";
  assert.equal(auth.hostedSignupsEnabled(), true);
  await assert.rejects(auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request()), hasStatus(403, /bootstrap token/i));
  await assert.rejects(auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request({ host: "127.0.0.1:8787" }, "203.0.113.10")), hasStatus(403, /bootstrap token/i));
  await assert.rejects(auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request({ host: "sentinel.example.test" }, "203.0.113.11")), hasStatus(403, /bootstrap token/i));

  const james = await auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request({
    host: "127.0.0.1:8787",
    "x-forwarded-proto": "https",
    [auth.BOOTSTRAP_TOKEN_HEADER]: "local-bootstrap-secret"
  }));
  assert.equal(james.session.authenticated, true);
  assert.equal(james.session.user?.role, "admin");
  assert.match(james.cookie, /HttpOnly/);
  assert.match(james.cookie, /SameSite=Strict/);
  assert.match(james.cookie, /Secure/);

  const jamesCookie = james.cookie.split(";", 1)[0] || "";
  const restored = await auth.accountSession(request({ cookie: jamesCookie }));
  assert.equal(restored.user?.name, "James Dunkin");
  assert.equal(restored.user?.email, "james@example.test");

  const member = await auth.createAccount({
    name: "Sentinel Member",
    email: "member@example.test",
    password: "another-secure-password"
  }, request({ host: "sentinel.example.test" }, "203.0.113.12"));
  assert.equal(member.session.user?.role, "member");
  const memberCookie = member.cookie.split(";", 1)[0] || "";
  await assert.rejects(
    auth.requireHostedAccount(request({ cookie: memberCookie }), { admin: true }),
    hasStatus(403, /Administrator access/)
  );

  assert.equal(auth.hostedAdminRequired("GET", "/api/state"), false);
  assert.equal(auth.hostedAdminRequired("POST", "/api/state"), true);
  assert.equal(auth.hostedAdminRequired("GET", "/api/diagnostic/export"), true);
  assert.equal(auth.hostedAdminRequired("GET", "/api/devices/ios/mdm/doctor"), true);
  assert.equal(auth.hostedAdminRequired("GET", "/api/devices/ios/mdm/enrollment.mobileconfig"), true);
  assert.equal(auth.hostedAdminRequired("GET", "/api/devices/ios/profile.mobileconfig"), true);

  const login = await auth.signInAccount({
    email: "JAMES@EXAMPLE.TEST",
    password: "a-secure-password"
  }, request({}, "198.51.100.10"));
  assert.equal(login.session.user?.role, "admin");

  const throttledLoginIp = "198.51.100.20";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.signInAccount({
      email: attempt % 2 === 0 ? "JAMES@EXAMPLE.TEST" : "james@example.test",
      password: "definitely-wrong-password"
    }, request({}, throttledLoginIp)), hasStatus(401, /incorrect/i));
  }
  await assert.rejects(auth.signInAccount({
    email: "james@example.test",
    password: "definitely-wrong-password"
  }, request({}, throttledLoginIp)), hasStatus(429, /Too many account attempts/i));
  await assert.rejects(auth.signInAccount({
    email: "james@example.test",
    password: "definitely-wrong-password"
  }, request({}, "198.51.100.21")), hasStatus(429, /Too many account attempts/i));

  const sprayIp = "198.51.100.22";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.signInAccount({
      email: `unknown-${attempt}@example.test`,
      password: "definitely-wrong-password"
    }, request({}, sprayIp)), hasStatus(401, /incorrect/i));
  }
  await assert.rejects(auth.signInAccount({
    email: "unknown-final@example.test",
    password: "definitely-wrong-password"
  }, request({}, sprayIp)), hasStatus(429, /Too many account attempts/i));

  const throttledSignupIp = "198.51.100.30";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.createAccount({
      name: "Duplicate Member",
      email: attempt % 2 === 0 ? "MEMBER@EXAMPLE.TEST" : "member@example.test",
      password: "another-secure-password"
    }, request({ host: "sentinel.example.test" }, throttledSignupIp)), hasStatus(409, /already exists/i));
  }
  await assert.rejects(auth.createAccount({
    name: "Duplicate Member",
    email: "member@example.test",
    password: "another-secure-password"
  }, request({ host: "sentinel.example.test" }, throttledSignupIp)), hasStatus(429, /Too many account attempts/i));
  await assert.rejects(auth.createAccount({
    name: "Duplicate Member",
    email: "member@example.test",
    password: "another-secure-password"
  }, request({ host: "sentinel.example.test" }, "198.51.100.31")), hasStatus(429, /Too many account attempts/i));

  const tampered = `${jamesCookie}x`;
  assert.equal((await auth.accountSession(request({ cookie: tampered }))).authenticated, false);
  assert.equal((await stat(join(dataDir, "accounts.json"))).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(join(dataDir, "accounts.json"), "utf8")) as { accounts: Array<Record<string, unknown>> };
  assert.equal(stored.accounts.length, 2);
  assert.equal("password" in (stored.accounts[0] || {}), false);
  assert.equal(typeof stored.accounts[0]?.passwordHash, "string");
} finally {
  restoreEnv("SENTINEL_DATA_DIR", previous.dataDir);
  restoreEnv("SENTINEL_AUTH_ENABLED", previous.auth);
  restoreEnv("SENTINEL_SIGNUPS_ENABLED", previous.signups);
  restoreEnv("SENTINEL_BOOTSTRAP_TOKEN", previous.bootstrap);
  await rm(dataDir, { recursive: true, force: true });
}

function request(headers: Record<string, string> = {}, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function hasStatus(status: number, message: RegExp): (error: unknown) => boolean {
  return (error) => Number(objectValue(error, "status")) === status && message.test(String(objectValue(error, "message") || ""));
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
