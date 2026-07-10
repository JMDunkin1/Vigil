import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Session } from "../../src/types.js";

process.env.SENTINEL_DATA_DIR = await mkdtemp(join(tmpdir(), "sentinel-protection-level-"));

const { BRICK_MODE_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } = await import("../../src/defaults.js");
const { handleSessionApiRoute } = await import("../../src/server/sessionRoutes.js");

const state = defaultState();
const existing: Session = {
  id: "existing-commitment",
  title: "Existing Commitment",
  mode: "brick",
  profileId: BRICK_MODE_PROFILE_ID,
  lockLevel: "deep",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  canEndEarly: false,
  commitmentLock: true,
  emergencyUnlocksAllowed: false,
  source: "manual",
  deviceTargets: ["computer", "phone"]
};
state.activeSession = existing;
state.activeSessions = { computer: existing, phone: existing };

const queuedReasons: string[] = [];
const enforcedSessions: string[] = [];
const context = {
  state,
  recordIosMdmPolicyQueue(reason: string) {
    queuedReasons.push(reason);
    return null;
  },
  scheduleImmediateSessionEnforcement(sessionId: string) {
    enforcedSessions.push(sessionId);
  },
  assertStrictLockAllowed: async () => {}
};

const levelTwo = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 2 }), levelTwo, context), true);
assert.equal(levelTwo.statusCodeValue, 200);
assert.equal(state.activeSessions.computer?.profileId, SOFT_BLOCK_PROFILE_ID);
assert.equal(state.activeSessions.phone?.profileId, SOFT_BLOCK_PROFILE_ID);
assert.equal(state.activeSessions.computer?.canEndEarly, true);
assert.equal(state.activeSessions.computer?.commitmentLock, false);
assert.ok(new Date(state.activeSessions.computer?.endsAt || 0).getUTCFullYear() >= new Date().getUTCFullYear() + 99);
assert.equal(queuedReasons.at(-1), "protection-level-2");
assert.equal(enforcedSessions.at(-1), state.activeSessions.computer?.id);

const underlyingSessionId = state.activeSessions.computer?.id;
state.settings.panicLockDurationMinutes = 9;
const panic = response();
assert.equal(await handleSessionApiRoute(request("/api/panic/start", { durationMinutes: 3 }), panic, context), true);
assert.equal(panic.statusCodeValue, 200);
assert.equal(state.activeSessions.computer?.id, underlyingSessionId, "Panic should leave the selected level underneath it");
assert.ok(state.panicLock);
const panicDurationMs = new Date(state.panicLock.endsAt).getTime() - new Date(state.panicLock.startedAt).getTime();
assert.equal(panicDurationMs, 3 * 60_000);

const blockedDuringPanic = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), blockedDuringPanic, context), true);
assert.equal(blockedDuringPanic.statusCodeValue, 423);
assert.equal(state.activeSessions.computer?.id, underlyingSessionId);

state.panicLock.endsAt = new Date(Date.now() - 1_000).toISOString();
const levelOne = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), levelOne, context), true);
assert.equal(levelOne.statusCodeValue, 200);
assert.equal(state.panicLock, null);
assert.equal(state.activeSessions.computer, null);
assert.equal(state.activeSessions.phone, null);
assert.equal(queuedReasons.at(-1), "protection-level-1");

function request(url: string, body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

interface MockResponse {
  statusCodeValue?: number;
  bodyText: string;
  writeHead(statusCode: number): MockResponse;
  end(chunk?: unknown): MockResponse;
}

function response(): ServerResponse & MockResponse {
  const target: MockResponse = {
    bodyText: "",
    writeHead(statusCode: number) {
      this.statusCodeValue = statusCode;
      return this;
    },
    end(chunk?: unknown) {
      this.bodyText += chunk ? String(chunk) : "";
      return this;
    }
  };
  return target as ServerResponse & MockResponse;
}
