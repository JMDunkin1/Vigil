import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VigilState, UsageState } from "../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-persistence-integrity-"));
await chmod(dataDir, 0o755);
process.env.VIGIL_DATA_DIR = dataDir;

const [{ defaultState }, { integrityLockdownActive }, { dateKey }, store, seal] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/integrityLockdown.js"),
  import("../src/time.js"),
  import("../src/store.js"),
  import("../src/seal.js")
]);

try {
  const state = await store.loadState();
  assert.equal(state.integrity.stateSeal.tamperDetectedAt, null);
  assert.equal(state.integrity.usageSeal.required, false);

  const migrationTransition = structuredClone(state);
  migrationTransition.integrity.usageSeal = {
    required: true,
    migrationVersion: 1,
    migratedAt: "2026-07-10T12:00:00.000Z"
  };
  assert.equal((await seal.verifyStateTextSeal(`${JSON.stringify(migrationTransition, null, 2)}\n`, {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.STATE_SEAL_PATH
  })).status, "trusted-migration");

  const legacyUsage: UsageState = {
    "2026-07-10": usageDay(137)
  };
  await writeFile(store.USAGE_PATH, `${JSON.stringify(legacyUsage, null, 2)}\n`);
  await rm(store.USAGE_SEAL_PATH, { force: true });

  const migratedUsage = await store.loadUsage(state);
  assert.equal(migratedUsage["2026-07-10"].totalSeconds, 137);
  assert.deepEqual(state.integrity.usageSeal, {
    required: true,
    migrationVersion: 1,
    migratedAt: state.integrity.usageSeal.migratedAt
  });
  assert.equal(Boolean(state.integrity.usageSeal.migratedAt), true);
  assert.equal((await verifyUsageSeal()).ok, true);

  const sealedStateText = await readFile(store.STATE_PATH, "utf8");
  const weakenedMarker = JSON.parse(sealedStateText) as VigilState;
  weakenedMarker.integrity.usageSeal = {
    required: false,
    migrationVersion: 0,
    migratedAt: null
  };
  const weakenedMarkerText = `${JSON.stringify(weakenedMarker, null, 2)}\n`;
  assert.equal((await seal.verifyStateTextSeal(weakenedMarkerText, {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.STATE_SEAL_PATH
  })).status, "mismatch");

  const ordinaryUsage: UsageState = {
    "2026-07-10": usageDay(300)
  };
  await store.saveUsage(ordinaryUsage);
  const editedUsage: UsageState = {
    "2026-07-10": usageDay(0)
  };
  await writeFile(store.USAGE_PATH, `${JSON.stringify(editedUsage, null, 2)}\n`);

  const editRecovery = await store.loadUsage(state);
  const editRecoveryDay = editRecovery[dateKey()];
  assert.equal(editRecoveryDay.totalSeconds, 24 * 60 * 60);
  assert.equal(editRecoveryDay.apps.Instagram, 24 * 60 * 60);
  assert.equal(editRecoveryDay.opens.apps.Instagram, 100_000);
  assert.equal(Boolean(state.integrity.stateSeal.tamperDetectedAt), true);
  assert.equal(integrityLockdownActive(state), true);
  assert.match(state.integrity.stateSeal.tamperDetail || "", /usage file does not match/i);
  assert.equal((await verifyUsageSeal()).ok, true);

  const deletionState = defaultState();
  await store.saveState(deletionState);
  await store.loadUsage(deletionState);
  await store.saveUsage({ "2026-07-10": usageDay(600) });
  await rm(store.USAGE_PATH, { force: true });
  await rm(store.USAGE_SEAL_PATH, { force: true });

  const deletionRecovery = await store.loadUsage(deletionState);
  assert.equal(deletionRecovery[dateKey()].totalSeconds, 24 * 60 * 60);
  assert.equal(Boolean(deletionState.integrity.stateSeal.tamperDetectedAt), true);
  assert.equal(integrityLockdownActive(deletionState), true);
  assert.match(deletionState.integrity.stateSeal.tamperDetail || "", /usage seal file is missing/i);
  assert.equal((await verifyUsageSeal()).ok, true);

  const stateWithoutBookkeeping = defaultState();
  await store.saveState(stateWithoutBookkeeping);
  const unsealedText = JSON.parse(await readFile(store.STATE_PATH, "utf8")) as VigilState;
  unsealedText.integrity.stateSeal = {
    lastStatus: "unknown",
    lastDetail: "",
    lastCheckedAt: null,
    lastSealedAt: null,
    tamperDetectedAt: null,
    tamperDetail: ""
  };
  await writeFile(store.STATE_PATH, `${JSON.stringify(unsealedText, null, 2)}\n`);
  await rm(store.STATE_SEAL_PATH, { force: true });
  await rm(store.STATE_SEAL_KEY_PATH, { force: true });

  const recoveredState = await store.loadState();
  assert.equal(Boolean(recoveredState.integrity.stateSeal.tamperDetectedAt), true);
  assert.equal(integrityLockdownActive(recoveredState), true);
  assert.match(recoveredState.integrity.stateSeal.tamperDetail || "", /existing state file has no integrity key or seal/i);
  const recoveredStateText = await readFile(store.STATE_PATH, "utf8");
  assert.equal((await seal.verifyStateTextSeal(recoveredStateText, {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.STATE_SEAL_PATH
  })).ok, true);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function usageDay(totalSeconds: number): UsageState[string] {
  return {
    totalSeconds,
    apps: { Instagram: totalSeconds },
    sites: { "instagram.com": totalSeconds },
    opens: {
      apps: { Instagram: totalSeconds ? 3 : 0 },
      sites: { "instagram.com": totalSeconds ? 3 : 0 }
    },
    devices: {},
    updatedAt: "2026-07-10T12:00:00.000Z"
  };
}

async function verifyUsageSeal() {
  return seal.verifyStateTextSeal(await readFile(store.USAGE_PATH, "utf8"), {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.USAGE_SEAL_PATH
  });
}
