import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-account-auth-"));
const previous = {
  dataDir: process.env.VIGIL_DATA_DIR,
  auth: process.env.VIGIL_AUTH_ENABLED,
  signups: process.env.VIGIL_SIGNUPS_ENABLED
};

try {
  process.env.VIGIL_DATA_DIR = dataDir;
  process.env.VIGIL_AUTH_ENABLED = "1";
  process.env.VIGIL_SIGNUPS_ENABLED = "1";
  const auth = await import("../../src/auth.js");

  const james = await auth.createAccount({
    name: "James Dunkin",
    email: "james@example.test",
    password: "a-secure-password"
  }, request({ "x-forwarded-proto": "https" }));
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
    name: "Vigil Member",
    email: "member@example.test",
    password: "another-secure-password"
  }, request());
  assert.equal(member.session.user?.role, "member");
  const memberCookie = member.cookie.split(";", 1)[0] || "";
  await assert.rejects(auth.requireHostedAccount(request({ cookie: memberCookie }), { admin: true }), /Administrator access/);

  const login = await auth.signInAccount({
    email: "JAMES@EXAMPLE.TEST",
    password: "a-secure-password"
  }, request());
  assert.equal(login.session.user?.role, "admin");
  await assert.rejects(auth.signInAccount({
    email: "james@example.test",
    password: "wrong-password-value"
  }, request()), /Email or password is incorrect/);

  const tampered = `${jamesCookie}x`;
  assert.equal((await auth.accountSession(request({ cookie: tampered }))).authenticated, false);
  assert.equal((await stat(join(dataDir, "accounts.json"))).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(join(dataDir, "accounts.json"), "utf8")) as { accounts: Array<Record<string, unknown>> };
  assert.equal(stored.accounts.length, 2);
  assert.equal("password" in (stored.accounts[0] || {}), false);
  assert.equal(typeof stored.accounts[0]?.passwordHash, "string");
} finally {
  if (previous.dataDir === undefined) delete process.env.VIGIL_DATA_DIR;
  else process.env.VIGIL_DATA_DIR = previous.dataDir;
  if (previous.auth === undefined) delete process.env.VIGIL_AUTH_ENABLED;
  else process.env.VIGIL_AUTH_ENABLED = previous.auth;
  if (previous.signups === undefined) delete process.env.VIGIL_SIGNUPS_ENABLED;
  else process.env.VIGIL_SIGNUPS_ENABLED = previous.signups;
  await rm(dataDir, { recursive: true, force: true });
}

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}
