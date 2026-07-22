import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BRICK_MODE_PROFILE_ID, NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { handlePolicyApiRoute, upsertProfile } from "../src/server/policyRoutes.js";

const BUILT_IN_PROFILE_IDS = ["default", NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID];

for (const id of BUILT_IN_PROFILE_IDS) {
  const state = defaultState();
  const before = structuredClone(state);
  assert.throws(
    () => upsertProfile(state, weakenedProfile(id)),
    isBuiltInProfileConflict,
    `${id} must not be mutable through the profile upsert`
  );
  assert.deepEqual(state, before, `${id} rejection must happen before state mutation`);

  const stateWithoutBuiltIn = defaultState();
  stateWithoutBuiltIn.profiles = stateWithoutBuiltIn.profiles.filter((profile) => profile.id !== id);
  const missingBefore = structuredClone(stateWithoutBuiltIn);
  assert.throws(
    () => upsertProfile(stateWithoutBuiltIn, weakenedProfile(id)),
    isBuiltInProfileConflict,
    `${id} must remain reserved when a migrated state temporarily omits it`
  );
  assert.deepEqual(stateWithoutBuiltIn, missingBefore, `${id} must not be recreated through the mutation API`);
}

{
  const state = defaultState();
  const initialCount = state.profiles.length;
  const created = upsertProfile(state, {
    id: "custom-study",
    name: "Custom study",
    mode: "blocklist",
    blockedApps: ["Steam"],
    blockedSites: ["example.test"],
    blockedUrlPatterns: ["example.test/games"],
    allowedApps: [],
    allowedSites: []
  });
  assert.equal(created.id, "custom-study");
  assert.equal(state.profiles.length, initialCount + 1);
  assert.equal(state.settings.activeProfileId, "custom-study");

  const updated = upsertProfile(state, {
    id: "custom-study",
    name: "Updated custom study",
    mode: "allowlist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: ["Safari"],
    allowedSites: ["openai.com"]
  });
  assert.equal(updated.name, "Updated custom study");
  assert.equal(updated.mode, "allowlist");
  assert.deepEqual(updated.allowedSites, ["openai.com"]);
  assert.equal(state.profiles.length, initialCount + 1, "custom profile updates must remain in-place");
}

for (const id of BUILT_IN_PROFILE_IDS) {
  const state = defaultState();
  const before = structuredClone(state);
  const queuedReasons: string[] = [];
  const enforcementReasons: string[] = [];
  await assert.rejects(
    () => handlePolicyApiRoute(
      mockRequest("POST", "/api/profile", weakenedProfile(id)),
      {} as ServerResponse,
      {
        state,
        recordIosMdmPolicyQueue: (reason) => queuedReasons.push(reason),
        schedulePolicyEnforcement: (reason) => enforcementReasons.push(reason)
      }
    ),
    isBuiltInProfileConflict,
    `POST /api/profile must reject ${id}`
  );
  assert.deepEqual(state, before, `${id} route rejection must leave state unchanged`);
  assert.deepEqual(queuedReasons, [], `${id} rejection must not queue an iPhone policy update`);
  assert.deepEqual(enforcementReasons, [], `${id} rejection must not schedule enforcement`);
}

function weakenedProfile(id: string) {
  return {
    id,
    name: "Weakened profile",
    mode: "allowlist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: ["Everything"],
    allowedSites: ["example.test"]
  };
}

function isBuiltInProfileConflict(error: unknown): boolean {
  const conflict = error as { status?: number; message?: string };
  assert.equal(conflict.status, 409);
  assert.match(conflict.message || "", /Built-in profiles cannot be modified/);
  return true;
}

function mockRequest(method: string, url: string, body: object): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url,
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}
