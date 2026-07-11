import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "sentinel-bootstrap-token-"));
const previous = {
  dataDir: process.env.SENTINEL_DATA_DIR,
  auth: process.env.SENTINEL_AUTH_ENABLED,
  signups: process.env.SENTINEL_SIGNUPS_ENABLED,
  bootstrap: process.env.SENTINEL_BOOTSTRAP_TOKEN
};

try {
  process.env.SENTINEL_DATA_DIR = dataDir;
  process.env.SENTINEL_AUTH_ENABLED = "1";
  process.env.SENTINEL_SIGNUPS_ENABLED = "1";
  process.env.SENTINEL_BOOTSTRAP_TOKEN = "bootstrap-secret-value";
  const auth = await import("../src/auth.js");
  const account = {
    name: "Remote Administrator",
    email: "remote-admin@example.test",
    password: "a-secure-remote-password"
  };

  await assert.rejects(auth.createAccount(account, request({
    host: "sentinel.example.test",
    [auth.BOOTSTRAP_TOKEN_HEADER]: "wrong-bootstrap-token"
  })), (error: unknown) => errorStatus(error) === 403);

  const created = await auth.createAccount(account, request({
    host: "sentinel.example.test",
    [auth.BOOTSTRAP_TOKEN_HEADER]: "bootstrap-secret-value"
  }));
  assert.equal(created.session.user?.role, "admin");
} finally {
  restoreEnv("SENTINEL_DATA_DIR", previous.dataDir);
  restoreEnv("SENTINEL_AUTH_ENABLED", previous.auth);
  restoreEnv("SENTINEL_SIGNUPS_ENABLED", previous.signups);
  restoreEnv("SENTINEL_BOOTSTRAP_TOKEN", previous.bootstrap);
  await rm(dataDir, { recursive: true, force: true });
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers, socket: { remoteAddress: "203.0.113.40" } } as unknown as IncomingMessage;
}

function errorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
