import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Session } from "../src/types.js";

const { SOFT_BLOCK_PROFILE_ID, defaultState } = await import("../src/defaults.js");
const { loadState, STATE_PATH } = await import("../src/store.js");

const state = defaultState();
const legacySoftLock: Session = {
  id: "legacy-sticky-soft-lock",
  title: "Soft Lock",
  mode: "focus",
  profileId: SOFT_BLOCK_PROFILE_ID,
  lockLevel: "deep",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  canEndEarly: false,
  commitmentLock: true,
  emergencyUnlocksAllowed: false,
  source: "protection-level",
  deviceTargets: ["computer", "phone"]
};
state.activeSession = legacySoftLock;
state.activeSessions = { computer: legacySoftLock, phone: legacySoftLock };

await mkdir(dirname(STATE_PATH), { recursive: true });
await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

const migrated = await loadState();
for (const target of ["computer", "phone"] as const) {
  const session = migrated.activeSessions[target];
  assert.ok(session);
  assert.equal(session.canEndEarly, true, `legacy ${target} Soft Lock must be immediately reversible`);
  assert.equal(session.commitmentLock, false, `legacy ${target} Soft Lock must not remain a commitment`);
  assert.equal(session.emergencyUnlocksAllowed, true, `legacy ${target} Soft Lock must not advertise emergency unavailability`);
}
