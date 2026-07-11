import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SentinelState, UsageState } from "../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "sentinel-state-save-"));
await chmod(dataDir, 0o755);
process.env.SENTINEL_DATA_DIR = dataDir;

const [{ defaultState }, store, seal] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/store.js"),
  import("../src/seal.js")
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
const saved = JSON.parse(text) as SentinelState;

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
const snapshotSaved = JSON.parse(snapshotText) as SentinelState;
const snapshotVerification = await seal.verifyStateTextSeal(snapshotText, {
  keyPath: store.STATE_SEAL_KEY_PATH,
  sealPath: store.STATE_SEAL_PATH
});

assert.equal(snapshotVerification.ok, true);
assert.equal(snapshotSaved.settings.pollIntervalMs, 4111);

const usage = {} as UsageState;
const usageSaves: Array<Promise<void>> = [];
for (let index = 0; index < 25; index += 1) {
  usage["2026-07-10"] = {
    totalSeconds: index,
    apps: { Sentinel: index },
    sites: {},
    contexts: {},
    openContexts: {},
    opens: { apps: {}, sites: {} },
    devices: {},
    updatedAt: new Date(1_800_000_000_000 + index).toISOString()
  };
  usageSaves.push(store.saveUsage(usage));
}
usage["2026-07-10"].totalSeconds = 999;
usage["2026-07-10"].apps.Sentinel = 999;
await Promise.all(usageSaves);

const savedUsage = JSON.parse(await readFile(store.USAGE_PATH, "utf8")) as UsageState;
assert.equal(savedUsage["2026-07-10"].totalSeconds, 24);
assert.equal(savedUsage["2026-07-10"].apps.Sentinel, 24);

await store.saveUsage({});
assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
assert.equal((await stat(store.STATE_PATH)).mode & 0o777, 0o600);
assert.equal((await stat(store.USAGE_PATH)).mode & 0o777, 0o600);

await rm(store.USAGE_PATH, { force: true });
await mkdir(store.USAGE_PATH);
await assert.rejects(store.saveUsage({}), /EISDIR|ENOTEMPTY|directory/i);
const remainingFiles = await readdir(dataDir);
assert.equal(remainingFiles.some((name) => name.startsWith("usage.json.") && name.endsWith(".tmp")), false);
await rm(store.USAGE_PATH, { recursive: true, force: true });
await store.saveUsage({});
assert.equal((await stat(store.USAGE_PATH)).isFile(), true);

await rm(dataDir, { recursive: true, force: true });
