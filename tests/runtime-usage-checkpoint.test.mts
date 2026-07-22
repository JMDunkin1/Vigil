import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { defaultState } from "../src/defaults.js";
import {
  MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES,
  MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES,
  RUNTIME_USAGE_CHECKPOINT_VERSION,
  RuntimeUsageCheckpointSaveError,
  isNonRetryableRuntimeUsageCheckpointError,
  quarantineRuntimeUsageCheckpoint,
  recoverRuntimeUsageCheckpoint,
  runtimeUsageCheckpointPath,
  saveRuntimeUsageCheckpoint
} from "../src/runtimeUsageCheckpoint.js";
import { createStateTextSeal } from "../src/seal.js";
import { dateKey, weekKey } from "../src/time.js";
import type { IntentionalGrant, UsageState } from "../src/types.js";
import { syncDeviceUsageSnapshot } from "../src/usage.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-runtime-usage-checkpoint-"));
const keyPath = join(dataDir, "state-seal.key");
const checkpointPath = runtimeUsageCheckpointPath(dataDir);
const now = new Date(2026, 6, 21, 14, 30, 0, 0);
const day = dateKey(now);

try {
  await chmod(dataDir, 0o755);
  await createStateTextSeal("seed\n", { keyPath });

  const sourceState = defaultState();
  sourceState.intentionalUse.ledger[day] = {
    weekKey: weekKey(now),
    rules: {
      "rule-a": intentionalRuleLedger({
        seconds: 120,
        pauses: 2,
        continued: 1,
        targets: { "example.com": 90 }
      })
    }
  };
  sourceState.intentionalUse.grants = [
    grant("grant-a", 120, new Date(now.getTime() - 1_000).toISOString()),
    grant("grant-not-in-recovered-state", 40, new Date(now.getTime() - 2_000).toISOString())
  ];
  const sourceUsage = usageWithDevices(now, {
    computer: usageSnapshot(120, { Safari: 120 }, { "example.com": 90 }, 3, now),
    phone: usageSnapshot(60, { YouTube: 60 }, { "youtube.com": 60 }, 2, now)
  });

  const saved = await saveRuntimeUsageCheckpoint(sourceState, sourceUsage, {
    checkpointPath,
    keyPath,
    now
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.status, "saved");
  assert.equal(saved.dayKey, day);
  assert.ok(saved.payloadBytes > saved.compressedBytes);
  assert.ok(saved.fileBytes <= MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700, "checkpoint directory must be private");
  assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600, "checkpoint file must be private");
  const savedText = await readFile(checkpointPath, "utf8");
  const savedEnvelope = JSON.parse(savedText) as Record<string, unknown>;
  assert.equal(savedEnvelope.algorithm, "hmac-sha256");
  assert.equal(savedEnvelope.encoding, "gzip+base64");
  assert.equal(savedText.includes("Safari"), false, "usage details must be compressed rather than stored as plaintext");
  assert.deepEqual((await readdir(dataDir)).sort(), ["runtime-usage.checkpoint.json", "state-seal.key"],
    "checkpoint authentication must stay inside one atomic file");

  const recoveredState = defaultState();
  recoveredState.intentionalUse.ledger[day] = {
    weekKey: weekKey(now),
    rules: {
      "rule-a": intentionalRuleLedger({
        seconds: 150,
        pauses: 1,
        skipped: 3,
        targets: { "example.com": 50, "current-only.example": 5 }
      })
    }
  };
  recoveredState.intentionalUse.grants = [
    grant("grant-a", 150, new Date(now.getTime() - 10_000).toISOString()),
    grant("grant-current-only", 22, new Date(now.getTime() - 3_000).toISOString())
  ];
  const recoveredUsage = usageWithDevices(now, {
    computer: usageSnapshot(80, { Safari: 80 }, { "example.com": 60 }, 2, now),
    phone: usageSnapshot(80, { YouTube: 80 }, { "youtube.com": 80 }, 4, now)
  });

  const recovery = await recoverRuntimeUsageCheckpoint(recoveredState, recoveredUsage, {
    checkpointPath,
    keyPath,
    now
  });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.status, "recovered");
  assert.equal(recovery.mergedDevices, 1, "newer checkpoint device usage must be recovered");
  assert.equal(recovery.staleDevices, 1, "newer durable device usage must never regress");
  assert.equal(recovery.mergedGrants, 1);
  assert.equal(recovery.unmatchedGrants, 1, "counter-only records must not fabricate grants without their policy fields");
  assert.equal(recoveredUsage[day].devices.computer.totalSeconds, 120);
  assert.equal(recoveredUsage[day].devices.computer.opens.apps.Safari, 3);
  assert.equal(recoveredUsage[day].devices.phone.totalSeconds, 80);
  assert.equal(recoveredUsage[day].devices.phone.opens.apps.YouTube, 4);
  const mergedRule = recoveredState.intentionalUse.ledger[day].rules["rule-a"];
  assert.equal(mergedRule.seconds, 150, "intentional counters must max-merge");
  assert.equal(mergedRule.pauses, 2);
  assert.equal(mergedRule.skipped, 3);
  assert.equal(mergedRule.targets["example.com"], 90);
  assert.equal(mergedRule.targets["current-only.example"], 5);
  assert.equal(recoveredState.intentionalUse.grants.find((item) => item.id === "grant-a")?.usedSeconds, 150);
  assert.equal(
    recoveredState.intentionalUse.grants.find((item) => item.id === "grant-a")?.lastSeenAt,
    sourceState.intentionalUse.grants[0].lastSeenAt,
    "grant timestamps must independently max-merge"
  );
  assert.equal(recoveredState.intentionalUse.grants.some((item) => item.id === "grant-current-only"), true);
  assert.equal(recoveredState.intentionalUse.grants.some((item) => item.id === "grant-not-in-recovered-state"), false);

  const afterFirstRecoveryState = structuredClone(recoveredState);
  const afterFirstRecoveryUsage = structuredClone(recoveredUsage);
  const repeated = await recoverRuntimeUsageCheckpoint(recoveredState, recoveredUsage, {
    checkpointPath,
    keyPath,
    now
  });
  assert.equal(repeated.ok, true);
  assert.deepEqual(recoveredState, afterFirstRecoveryState, "checkpoint recovery must be idempotent for state counters");
  assert.deepEqual(recoveredUsage, afterFirstRecoveryUsage, "checkpoint recovery must be idempotent for usage counters");

  const midnight = new Date(2026, 6, 22, 0, 0, 2, 0);
  const midnightDay = dateKey(midnight);
  const previousDate = new Date(midnight);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousDay = dateKey(previousDate);
  const midnightState = defaultState();
  midnightState.intentionalUse.ledger[midnightDay] = {
    weekKey: weekKey(midnight),
    rules: { "rule-a": intentionalRuleLedger({ seconds: 120, targets: { "current.example": 120 } }) }
  };
  midnightState.intentionalUse.ledger[previousDay] = {
    weekKey: weekKey(previousDate),
    rules: { "rule-a": intentionalRuleLedger({ seconds: 200, targets: { "previous.example": 200 } }) }
  };
  midnightState.intentionalUse.grants = [grant("grant-midnight", 123, midnight.toISOString())];
  const midnightUsage = {
    ...usageWithDevices(midnight, {
      computer: usageSnapshot(120, { Current: 120 }, { "current.example": 120 }, 2, midnight)
    }),
    ...usageWithDevices(previousDate, {
      computer: usageSnapshot(200, { Previous: 200 }, { "previous.example": 200 }, 3, previousDate)
    })
  };
  const midnightSaved = await saveRuntimeUsageCheckpoint(midnightState, midnightUsage, {
    checkpointPath,
    keyPath,
    now: midnight
  });
  assert.deepEqual(midnightSaved.dayKeys, [midnightDay, previousDay], "a midnight checkpoint must bundle both adjacent local days");
  const midnightEnvelope = JSON.parse(await readFile(checkpointPath, "utf8")) as { payload: string };
  const midnightPayload = JSON.parse(gunzipSync(Buffer.from(midnightEnvelope.payload, "base64")).toString("utf8")) as {
    days: Array<{ dayKey: string; grants?: unknown }>;
    grants: unknown[];
  };
  assert.deepEqual(midnightPayload.days.map((entry) => entry.dayKey), [midnightDay, previousDay]);
  assert.equal(midnightPayload.grants.length, 1, "grant counters must occur once outside the day bundle");
  assert.equal(midnightPayload.days.some((entry) => "grants" in entry), false);

  const midnightRecoveredState = defaultState();
  midnightRecoveredState.intentionalUse.ledger[midnightDay] = {
    weekKey: weekKey(midnight),
    rules: { "rule-a": intentionalRuleLedger({ seconds: 150, targets: { "current.example": 150 } }) }
  };
  midnightRecoveredState.intentionalUse.ledger[previousDay] = {
    weekKey: weekKey(previousDate),
    rules: { "rule-a": intentionalRuleLedger({ seconds: 100, targets: { "previous.example": 100 } }) }
  };
  midnightRecoveredState.intentionalUse.grants = [grant("grant-midnight", 100, new Date(midnight.getTime() - 1_000).toISOString())];
  const midnightRecoveredUsage = {
    ...usageWithDevices(midnight, {
      computer: usageSnapshot(150, { Current: 150 }, { "current.example": 150 }, 4, midnight)
    }),
    ...usageWithDevices(previousDate, {
      computer: usageSnapshot(100, { Previous: 100 }, { "previous.example": 100 }, 1, previousDate)
    })
  };
  const midnightRecovery = await recoverRuntimeUsageCheckpoint(midnightRecoveredState, midnightRecoveredUsage, {
    checkpointPath,
    keyPath,
    now: midnight
  });
  assert.equal(midnightRecovery.status, "recovered");
  assert.deepEqual(midnightRecovery.dayKeys, [midnightDay, previousDay]);
  assert.equal(midnightRecoveredUsage[midnightDay].devices.computer.totalSeconds, 150, "current-day durable usage must not regress");
  assert.equal(midnightRecoveredUsage[previousDay].devices.computer.totalSeconds, 200, "previous-day checkpoint usage must recover after midnight");
  assert.equal(midnightRecoveredState.intentionalUse.ledger[midnightDay].rules["rule-a"].seconds, 150);
  assert.equal(midnightRecoveredState.intentionalUse.ledger[previousDay].rules["rule-a"].seconds, 200);
  assert.equal(midnightRecoveredState.intentionalUse.grants[0].usedSeconds, 123, "grant counters must max-merge once");

  const missing = await recoverRuntimeUsageCheckpoint(defaultState(), {}, {
    checkpointPath: join(dataDir, "missing.checkpoint.json"),
    keyPath,
    now
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.status, "missing");

  await saveRuntimeUsageCheckpoint(sourceState, sourceUsage, { checkpointPath, keyPath, now });
  const tamperedEnvelope = JSON.parse(await readFile(checkpointPath, "utf8")) as { digest: string };
  tamperedEnvelope.digest = `${tamperedEnvelope.digest[0] === "0" ? "1" : "0"}${tamperedEnvelope.digest.slice(1)}`;
  const tamperedText = `${JSON.stringify(tamperedEnvelope)}\n`;
  await writeFile(checkpointPath, tamperedText, { mode: 0o600 });
  const tamperState = defaultState();
  const tamperUsage = usageWithDevices(now, {
    computer: usageSnapshot(7, { Notes: 7 }, {}, 1, now)
  });
  const tamperStateBefore = structuredClone(tamperState);
  const tamperUsageBefore = structuredClone(tamperUsage);
  const tampered = await recoverRuntimeUsageCheckpoint(tamperState, tamperUsage, { checkpointPath, keyPath, now });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.status, "invalid");
  assert.match(tampered.detail, /failed closed|authentication/u);
  assert.deepEqual(tamperState, tamperStateBefore, "invalid checkpoints must not partially mutate state");
  assert.deepEqual(tamperUsage, tamperUsageBefore, "invalid checkpoints must not partially mutate usage");

  const evidencePath = await quarantineRuntimeUsageCheckpoint(checkpointPath, now);
  assert.ok(evidencePath.startsWith(`${checkpointPath}.corrupt.`));
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600, "quarantined evidence must stay private");
  assert.equal(await readFile(evidencePath, "utf8"), tamperedText, "quarantine must preserve invalid evidence exactly");
  await assert.rejects(stat(checkpointPath), { code: "ENOENT" }, "quarantine must atomically vacate the live path");
  await assert.rejects(
    quarantineRuntimeUsageCheckpoint(checkpointPath, now),
    { code: "ENOENT" },
    "quarantine must never consume existing evidence when the live path is absent"
  );
  assert.equal(await readFile(evidencePath, "utf8"), tamperedText);

  await writeFile(checkpointPath, Buffer.alloc(MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES + 1, 0x20), { mode: 0o600 });
  const oversized = await recoverRuntimeUsageCheckpoint(tamperState, tamperUsage, { checkpointPath, keyPath, now });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, "invalid");
  assert.match(oversized.detail, /file-size limit/u);
  assert.deepEqual(tamperState, tamperStateBefore);
  assert.deepEqual(tamperUsage, tamperUsageBefore);

  const oversizedPayload = Buffer.alloc(MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES + 1, 0x20);
  const compressedBomb = gzipSync(oversizedPayload, { level: 1 });
  const createdAt = now.toISOString();
  const bombEnvelope = {
    version: RUNTIME_USAGE_CHECKPOINT_VERSION,
    algorithm: "hmac-sha256",
    encoding: "gzip+base64",
    createdAt,
    payloadBytes: MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES,
    compressedBytes: compressedBomb.byteLength,
    payload: compressedBomb.toString("base64"),
    digest: ""
  };
  const key = (await readFile(keyPath, "utf8")).trim();
  bombEnvelope.digest = createHmac("sha256", key).update([
    String(bombEnvelope.version),
    bombEnvelope.algorithm,
    bombEnvelope.encoding,
    bombEnvelope.createdAt,
    String(bombEnvelope.payloadBytes),
    String(bombEnvelope.compressedBytes),
    bombEnvelope.payload
  ].join("\n"), "utf8").digest("hex");
  await writeFile(checkpointPath, `${JSON.stringify(bombEnvelope)}\n`, { mode: 0o600 });
  const bomb = await recoverRuntimeUsageCheckpoint(tamperState, tamperUsage, { checkpointPath, keyPath, now });
  assert.equal(bomb.ok, false);
  assert.equal(bomb.status, "invalid");
  assert.match(bomb.detail, /failed closed/u);
  assert.deepEqual(tamperState, tamperStateBefore);
  assert.deepEqual(tamperUsage, tamperUsageBefore);

  const largeUsageState = defaultState();
  const largeUsage = usageWithDevices(now, {
    computer: usageSnapshot(750, { Vigil: 750 }, {}, 0, now)
  });
  largeUsage[day].devices.computer.apps = Object.fromEntries(
    Array.from({ length: 750 }, (_value, index) => [`app-${index}`, 1])
  );
  await saveRuntimeUsageCheckpoint(largeUsageState, largeUsage, { checkpointPath, keyPath, now });
  const largeRecoveredUsage: UsageState = {};
  const largeRecovery = await recoverRuntimeUsageCheckpoint(defaultState(), largeRecoveredUsage, { checkpointPath, keyPath, now });
  assert.equal(largeRecovery.status, "recovered");
  assert.equal(Object.keys(largeRecoveredUsage[day].devices.computer.apps).length, 750, "ordinary maps above 500 entries must round-trip without truncation");
  assert.equal(largeRecoveredUsage[day].devices.computer.apps["app-749"], 1);

  const structurallyOversizedUsage = structuredClone(largeUsage);
  structurallyOversizedUsage[day].devices.computer.apps = Object.fromEntries(
    Array.from({ length: 50_001 }, (_value, index) => [`oversized-app-${index}`, 1])
  );
  const structuralError = await saveRuntimeUsageCheckpoint(
    largeUsageState,
    structurallyOversizedUsage,
    { checkpointPath, keyPath, now }
  ).then(() => null, (error: unknown) => error);
  assert.equal(structuralError instanceof RuntimeUsageCheckpointSaveError, true);
  assert.equal(isNonRetryableRuntimeUsageCheckpointError(structuralError), true, "deterministic structural failures must be non-retryable");
  assert.equal((structuralError as RuntimeUsageCheckpointSaveError).retryable, false);

  const transientKeyError = await saveRuntimeUsageCheckpoint(largeUsageState, largeUsage, {
    checkpointPath,
    keyPath: join(dataDir, "temporarily-missing.key"),
    now
  }).then(() => null, (error: unknown) => error);
  assert.equal(isNonRetryableRuntimeUsageCheckpointError(transientKeyError), false, "filesystem and key availability failures must remain retryable");
  assert.equal((await readdir(dataDir)).some((name) => name.endsWith(".tmp")), false,
    "atomic checkpoint writes must not leave temporary files behind");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function usageWithDevices(
  now: Date,
  devices: Partial<Record<"computer" | "phone", Record<string, unknown>>>
): UsageState {
  const usage: UsageState = {};
  for (const [device, snapshot] of Object.entries(devices)) {
    syncDeviceUsageSnapshot(usage, {
      ...snapshot,
      device,
      dayKey: dateKey(now)
    }, now, { allowedDevices: ["computer", "phone"] });
  }
  return usage;
}

function usageSnapshot(
  totalSeconds: number,
  apps: Record<string, number>,
  sites: Record<string, number>,
  opens: number,
  now: Date
): Record<string, unknown> {
  const app = Object.keys(apps)[0] || "Vigil";
  const site = Object.keys(sites)[0] || "";
  return {
    totalSeconds,
    apps,
    sites,
    opens: {
      apps: opens ? { [app]: opens } : {},
      sites: opens && site ? { [site]: opens } : {}
    },
    updatedAt: now.toISOString()
  };
}

function intentionalRuleLedger(
  values: Partial<{ seconds: number; pauses: number; continued: number; skipped: number; targets: Record<string, number> }>
) {
  return {
    seconds: values.seconds || 0,
    pauses: values.pauses || 0,
    continued: values.continued || 0,
    skipped: values.skipped || 0,
    targets: values.targets || {}
  };
}

function grant(id: string, usedSeconds: number, lastSeenAt: string): IntentionalGrant {
  return {
    id,
    pauseId: `pause-${id}`,
    ruleId: "rule-a",
    status: "active",
    targetType: "site",
    targetLabel: "example.com",
    app: "Safari",
    hostname: "example.com",
    createdAt: new Date(Date.parse(lastSeenAt) - 60_000).toISOString(),
    until: new Date(Date.parse(lastSeenAt) + 60_000).toISOString(),
    intention: "Focused work",
    mood: "steady",
    usedSeconds,
    lastSeenAt
  };
}
