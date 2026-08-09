import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Session } from "../src/types.js";

process.env.VIGIL_DATA_DIR = await mkdtemp(join(tmpdir(), "vigil-protection-level-"));

const { BRICK_MODE_PROFILE_ID, defaultState } = await import("../src/defaults.js");
const { confirmMaintenanceWindow, requestMaintenanceWindow } = await import("../src/protection.js");
const { handleSessionApiRoute } = await import("../src/server/sessionRoutes.js");

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
const effectOrder: string[] = [];
const context = {
  state,
  recordIosMdmPolicyQueue(reason: string) {
    effectOrder.push(`mdm:${reason}`);
    queuedReasons.push(reason);
    return null;
  },
  scheduleImmediateSessionEnforcement(sessionId: string) {
    effectOrder.push(`enforce:${sessionId}`);
    enforcedSessions.push(sessionId);
  },
  assertStrictLockAllowed: async () => {}
};

const levelTwo = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 2 }), levelTwo, context), true);
assert.equal(levelTwo.statusCodeValue, 423);
assert.match(JSON.parse(levelTwo.bodyText).error, /validated maintenance or emergency unlock/);
assert.equal(state.activeSessions.computer?.id, existing.id);
assert.equal(state.activeSessions.phone?.id, existing.id);
assert.deepEqual(queuedReasons, []);
assert.deepEqual(enforcedSessions, []);

const levelOne = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), levelOne, context), true);
assert.equal(levelOne.statusCodeValue, 423);
assert.equal(state.activeSessions.computer?.id, existing.id);
assert.equal(state.activeSessions.phone?.id, existing.id);

existing.commitmentLock = false;
existing.emergencyUnlocksAllowed = true;
const lockedNonCommitment = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 3 }), lockedNonCommitment, context), true);
assert.equal(lockedNonCommitment.statusCodeValue, 423);
assert.equal(state.activeSessions.computer?.id, existing.id);
assert.equal(state.activeSessions.phone?.id, existing.id);
existing.commitmentLock = true;
existing.emergencyUnlocksAllowed = false;

const underlyingSessionId = existing.id;
state.settings.panicLockDurationMinutes = 9;
const panic = response();
assert.equal(await handleSessionApiRoute(request("/api/panic/start", { durationMinutes: 3 }), panic, context), true);
assert.equal(panic.statusCodeValue, 200);
assert.equal(state.activeSessions.computer?.id, underlyingSessionId, "Panic should leave the selected level underneath it");
assert.ok(state.panicLock);
assert.deepEqual(effectOrder.slice(-2), [`enforce:${state.panicLock.id}`, "mdm:panic-start"], "panic must register local enforcement before phone work");
const panicDurationMs = new Date(state.panicLock.endsAt).getTime() - new Date(state.panicLock.startedAt).getTime();
assert.equal(panicDurationMs, 3 * 60_000);

const blockedDuringPanic = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), blockedDuringPanic, context), true);
assert.equal(blockedDuringPanic.statusCodeValue, 423);
assert.equal(state.activeSessions.computer?.id, underlyingSessionId);

state.panicLock.endsAt = new Date(Date.now() - 1_000).toISOString();
const blockedAfterPanic = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), blockedAfterPanic, context), true);
assert.equal(blockedAfterPanic.statusCodeValue, 423);
assert.equal(state.panicLock, null);
assert.equal(state.activeSessions.computer?.id, existing.id);
assert.equal(state.activeSessions.phone?.id, existing.id);

state.settings.protectedEditDelaySeconds = 0;
const maintenanceNow = new Date();
const maintenanceRequest = requestMaintenanceWindow(state, "I need to correct the selected protection level without bypassing its lock.", maintenanceNow).pending;
assert.ok(maintenanceRequest);
const maintenance = confirmMaintenanceWindow(state, maintenanceRequest.id, {
  challengeText: maintenanceRequest.challenge?.text
}, maintenanceNow);
assert.ok(new Date(maintenance.until) > maintenanceNow);

const allowedLevelTwo = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 2 }), allowedLevelTwo, context), true);
assert.equal(allowedLevelTwo.statusCodeValue, 200);
assert.equal(state.activeSessions.computer?.profileId, BRICK_MODE_PROFILE_ID);
assert.equal(state.activeSessions.phone?.profileId, BRICK_MODE_PROFILE_ID);
assert.equal(state.activeSessions.computer?.title, "Full Brick");
assert.equal(state.activeSessions.computer?.mode, "brick");
assert.equal(state.activeSessions.computer?.canEndEarly, true);
assert.equal(state.activeSessions.computer?.commitmentLock, false);
assert.equal(state.activeSessions.computer?.emergencyUnlocksAllowed, true);
assert.equal(state.activeSessions.computer?.source, "protection-level");
assert.ok(new Date(state.activeSessions.computer?.endsAt || 0).getUTCFullYear() >= new Date().getUTCFullYear() + 99);
assert.equal(queuedReasons.at(-1), "protection-level-2");
assert.equal(enforcedSessions.at(-1), state.activeSessions.computer?.id);
assert.deepEqual(effectOrder.slice(-2), [`enforce:${state.activeSessions.computer?.id}`, "mdm:protection-level-2"]);

state.maintenance.windows = [];
const reversibleBrickLevelOne = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), reversibleBrickLevelOne, context), true);
assert.equal(reversibleBrickLevelOne.statusCodeValue, 200, "Full Brick must remain directly reversible");
assert.equal(state.activeSessions.computer, null);
assert.equal(state.activeSessions.phone, null);
assert.equal(queuedReasons.at(-1), "protection-level-1");

const levelThree = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 3 }), levelThree, context), true);
assert.equal(levelThree.statusCodeValue, 200);
assert.equal(JSON.parse(levelThree.bodyText).level, 2, "legacy Level 3 requests should normalize to current Level 2");
const activeLevelThree = state.activeSessions.computer as Session | null;
assert.ok(activeLevelThree);
assert.equal(activeLevelThree.profileId, BRICK_MODE_PROFILE_ID);
assert.equal(activeLevelThree.canEndEarly, true);
assert.equal(activeLevelThree.commitmentLock, false);

state.maintenance.windows = [];
const reversibleLevelOne = response();
assert.equal(await handleSessionApiRoute(request("/api/protection/level", { level: 1 }), reversibleLevelOne, context), true);
assert.equal(reversibleLevelOne.statusCodeValue, 200, "Full Brick must remain directly reversible");
assert.equal(state.activeSessions.computer, null);
assert.equal(state.activeSessions.phone, null);

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
