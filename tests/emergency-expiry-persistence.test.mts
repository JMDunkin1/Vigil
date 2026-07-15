import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-emergency-expiry-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [{ defaultState }, store] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/store.js")
]);
const expiredId = "expired-emergency-request";
const realDate = Date;
let now = realDate.now();
const initial = defaultState();
initial.settings.pollIntervalMs = 60_000;
initial.emergency.pending.push({
  id: expiredId,
  status: "pending",
  requestedAt: new realDate(now).toISOString(),
  eligibleAt: new realDate(now).toISOString(),
  expiresAt: new realDate(now + 60 * 60 * 1000).toISOString()
});
await store.saveRuntimeSnapshot(initial, {});

const { startVigilRuntime } = await import("../src/server.js");
const runtime = await startVigilRuntime();
const monitorBarrier = await runtime.request({
  method: "POST",
  path: "/api/settings",
  headers: {
    "Content-Type": "application/json",
    "X-Vigil-Intent": "vigil-app"
  },
  body: JSON.stringify({ siteRedirectEnabled: initial.settings.siteRedirectEnabled })
});
assert.equal(monitorBarrier.status, 200);
class AdjustableDate extends realDate {
  constructor(value?: string | number | Date) {
    if (value === undefined) super(now);
    else super(value);
  }

  static override now(): number {
    return now;
  }
}
globalThis.Date = AdjustableDate as DateConstructor;
now += 2 * 60 * 60 * 1000;

try {
  const response = await runtime.request({
    method: "POST",
    path: "/api/emergency/confirm",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: JSON.stringify({ requestId: expiredId })
  });
  assert.equal(response.status, 410);

  const liveResponse = await runtime.request({ path: "/api/state" });
  assert.equal(liveResponse.status, 200);
  const livePayload = JSON.parse(Buffer.from(liveResponse.body).toString("utf8")) as { state: typeof initial };
  assert.equal(livePayload.state.emergency.pending.some((item) => item.id === expiredId), false, "expired requests are hidden from the public pending list");
  assert.equal(livePayload.state.events.some((event) => event.type === "emergency_expired" && event.detail.requestId === expiredId), true);

  const persisted = await store.loadState();
  assert.equal(persisted.emergency.pending.find((item) => item.id === expiredId)?.status, "expired");
  assert.equal(persisted.events.some((event) => event.type === "emergency_expired" && event.detail.requestId === expiredId), true);
} finally {
  globalThis.Date = realDate;
  await runtime.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}
