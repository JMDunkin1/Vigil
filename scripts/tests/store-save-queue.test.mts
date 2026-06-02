import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VigilState } from "../../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-state-save-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [{ defaultState }, store, seal] = await Promise.all([
  import("../../src/defaults.js"),
  import("../../src/store.js"),
  import("../../src/seal.js")
]);

const state = defaultState();
const saves: Array<Promise<void>> = [];

for (let index = 0; index < 25; index += 1) {
  state.settings.pollIntervalMs = 3000 + index;
  state.events.unshift({
    id: `race-${index}`,
    type: "race_save",
    detail: { index },
    at: new Date(1_800_000_000_000 + index).toISOString()
  });
  saves.push(store.saveState(state));
}

await Promise.all(saves);

const text = await readFile(store.STATE_PATH, "utf8");
const verification = await seal.verifyStateTextSeal(text, {
  keyPath: store.STATE_SEAL_KEY_PATH,
  sealPath: store.STATE_SEAL_PATH
});
const saved = JSON.parse(text) as VigilState;

assert.equal(verification.ok, true);
assert.equal(saved.settings.pollIntervalMs, 3024);
assert.equal(saved.events[0].id, "race-24");
assert.equal(saved.integrity.stateSeal.lastSealedAt, verification.sealedAt);

const snapshotState = defaultState();
snapshotState.settings.pollIntervalMs = 4111;
const snapshotSave = store.saveState(snapshotState);
snapshotState.settings.pollIntervalMs = 4222;
await snapshotSave;

const snapshotText = await readFile(store.STATE_PATH, "utf8");
const snapshotSaved = JSON.parse(snapshotText) as VigilState;
const snapshotVerification = await seal.verifyStateTextSeal(snapshotText, {
  keyPath: store.STATE_SEAL_KEY_PATH,
  sealPath: store.STATE_SEAL_PATH
});

assert.equal(snapshotVerification.ok, true);
assert.equal(snapshotSaved.settings.pollIntervalMs, 4111);
