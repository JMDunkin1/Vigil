import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-startup-continuity-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [
  { defaultState },
  { recoverStartupContinuity },
  store,
  runtimeReady,
  runtimeCheckpoint,
  { dateKey },
  { syncDeviceUsageSnapshot }
] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/server.js"),
  import("../src/store.js"),
  import("../src/runtimeReady.js"),
  import("../src/runtimeUsageCheckpoint.js"),
  import("../src/time.js"),
  import("../src/usage.js")
]);

try {
  const now = new Date();
  const day = dateKey(now);
  const durableState = defaultState();
  durableState.activeSession = {
    id: "startup-continuity-session",
    title: "Startup continuity session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const durableUsage = usageSnapshot(now, 10);
  await store.saveRuntimeSnapshot(durableState, durableUsage);

  const checkpointUsage = usageSnapshot(now, 120);
  await runtimeCheckpoint.saveRuntimeUsageCheckpoint(durableState, checkpointUsage, {
    checkpointPath: runtimeCheckpoint.runtimeUsageCheckpointPath(dataDir),
    keyPath: store.STATE_SEAL_KEY_PATH,
    now
  });

  const previousStartedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const interruption = {
    version: 1 as const,
    id: runtimeReady.runtimeInterruptionId({ pid: 4242, startedAt: previousStartedAt }),
    pid: 4242,
    startedAt: previousStartedAt,
    appPath: process.execPath,
    transport: "in-app" as const,
    detectedAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
    reason: "process-missing" as const
  };
  await writeFile(runtimeReady.runtimeInterruptionPath(dataDir), `${JSON.stringify(interruption)}\n`, { mode: 0o600 });
  await chmod(runtimeReady.runtimeInterruptionPath(dataDir), 0o600);

  const recoveredState = await store.loadState();
  const recoveredUsage = await store.loadUsage(recoveredState);
  const recovery = await recoverStartupContinuity(recoveredState, recoveredUsage, [], now);
  assert.equal(recovery.runtimeUsageCheckpointEnabled, true);
  assert.equal(recovery.checkpointChanged, true);
  assert.equal(recovery.snapshotPersisted, true);
  assert.equal(recoveredUsage[day]?.devices?.computer?.totalSeconds, 120, "startup must recover newer authenticated hot usage");
  assert.equal(recoveredState.integrity.runtime.lastInterruptionId, interruption.id);
  assert.ok(recoveredState.integrity.runtime.downtimeDetectedAt, "a supervised interruption during a protected lock must fail closed");
  assert.equal(recoveredState.events.some((event) => event.type === "runtime_downtime_lockdown"), true);
  assert.deepEqual(await runtimeReady.readRuntimeInterruption(dataDir), { status: "valid", record: interruption },
    "the server must leave valid evidence for the app readiness handshake to acknowledge");
  assert.equal(await runtimeReady.clearRuntimeInterruption(dataDir, interruption.id), true);

  const alreadyFoldedState = await store.loadState();
  const alreadyFoldedUsage = await store.loadUsage(alreadyFoldedState);
  let redundantSnapshotWrites = 0;
  const alreadyFoldedRecovery = await recoverStartupContinuity(alreadyFoldedState, alreadyFoldedUsage, [], new Date(), {
    persistSnapshot: async () => { redundantSnapshotWrites += 1; }
  });
  assert.equal(alreadyFoldedRecovery.checkpointChanged, false, "an older/equal hot checkpoint must not force a redundant startup snapshot");
  assert.equal(alreadyFoldedRecovery.snapshotPersisted, false);
  assert.equal(redundantSnapshotWrites, 0);

  const checkpointPath = runtimeCheckpoint.runtimeUsageCheckpointPath(dataDir);
  const tamperedEnvelope = JSON.parse(await readFile(checkpointPath, "utf8")) as { digest: string };
  tamperedEnvelope.digest = `${tamperedEnvelope.digest.startsWith("0") ? "1" : "0"}${tamperedEnvelope.digest.slice(1)}`;
  await writeFile(checkpointPath, `${JSON.stringify(tamperedEnvelope)}\n`, { mode: 0o600 });
  const failedCheckpointAlarmState = defaultState();
  await assert.rejects(
    recoverStartupContinuity(failedCheckpointAlarmState, {}, [], new Date(), {
      persistSnapshot: async () => { throw new Error("injected startup snapshot failure"); }
    }),
    /injected startup snapshot failure/
  );
  assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).digest, tamperedEnvelope.digest,
    "invalid checkpoint evidence must remain canonical until its alarm is durable");
  assert.equal((await readdir(dataDir)).some((name) => name.startsWith("runtime-usage.checkpoint.json.corrupt.")), false);

  const invalidCheckpointState = defaultState();
  const invalidCheckpointUsage = {};
  const invalidCheckpointRecovery = await recoverStartupContinuity(invalidCheckpointState, invalidCheckpointUsage, [], new Date());
  assert.equal(invalidCheckpointRecovery.runtimeUsageCheckpointEnabled, true, "successful quarantine must keep compact checkpoints available");
  assert.ok(invalidCheckpointState.integrity.stateSeal.tamperDetectedAt);
  assert.equal(invalidCheckpointState.events.some((event) => event.type === "runtime_usage_checkpoint_invalid"), true);
  assert.equal((await readdir(dataDir)).some((name) => name.startsWith("runtime-usage.checkpoint.json.corrupt.")), true,
    "invalid checkpoint bytes must be preserved outside the canonical path");

  await writeFile(runtimeReady.runtimeInterruptionPath(dataDir), "{invalid-json\n", { mode: 0o600 });
  const failedReceiptAlarmState = defaultState();
  await assert.rejects(
    recoverStartupContinuity(failedReceiptAlarmState, {}, [], new Date(), {
      persistSnapshot: async () => { throw new Error("injected receipt alarm persistence failure"); }
    }),
    /injected receipt alarm persistence failure/
  );
  assert.equal(await readFile(runtimeReady.runtimeInterruptionPath(dataDir), "utf8"), "{invalid-json\n",
    "invalid interruption evidence must remain canonical until its alarm is durable");

  const invalidReceiptState = defaultState();
  await recoverStartupContinuity(invalidReceiptState, {}, [], new Date());
  assert.ok(invalidReceiptState.integrity.stateSeal.tamperDetectedAt);
  assert.equal(invalidReceiptState.events.some((event) => event.type === "runtime_interruption_evidence_invalid"), true);
  assert.deepEqual(await runtimeReady.readRuntimeInterruption(dataDir), { status: "missing" });
  assert.equal((await readdir(dataDir)).some((name) => name.startsWith("runtime-interruption.json.corrupt.")), true,
    "invalid interruption evidence must be preserved without blocking future supervisor receipts");

  const malformedReadyStartedAt = new Date().toISOString();
  const invalidReadyReceipt = {
    version: 1 as const,
    id: runtimeReady.runtimeInterruptionId({ pid: 5151, startedAt: malformedReadyStartedAt }),
    pid: 5151,
    startedAt: malformedReadyStartedAt,
    appPath: process.execPath,
    transport: "in-app" as const,
    detectedAt: malformedReadyStartedAt,
    reason: "invalid-ready-record" as const
  };
  await writeFile(runtimeReady.runtimeInterruptionPath(dataDir), `${JSON.stringify(invalidReadyReceipt)}\n`, { mode: 0o600 });
  const invalidReadyState = defaultState();
  await recoverStartupContinuity(invalidReadyState, {}, [], new Date());
  assert.ok(invalidReadyState.integrity.stateSeal.tamperDetectedAt, "malformed readiness evidence must fail closed regardless of gap duration");
  assert.equal(invalidReadyState.events.some((event) => event.type === "runtime_interruption_evidence_invalid"), true);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function usageSnapshot(now: Date, seconds: number) {
  const usage = {};
  syncDeviceUsageSnapshot(usage, {
    device: "computer",
    dayKey: dateKey(now),
    totalSeconds: seconds,
    apps: { Safari: seconds },
    sites: { "example.com": seconds },
    opens: { apps: { Safari: 1 }, sites: { "example.com": 1 } },
    updatedAt: now.toISOString()
  }, now, { allowedDevices: ["computer", "phone"] });
  return usage;
}
