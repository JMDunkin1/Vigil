import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-adult-refresh-failure-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [
  { startVigilRuntime },
  { loadRuntimeOutbox, loadState, saveRuntimeSnapshot },
  { adultBlocklistSource, commitAdultBlocklistRefresh },
  { defaultState }
] = await Promise.all([
  import("../src/server.js"),
  import("../src/store.js"),
  import("../src/adultBlocklist.js"),
  import("../src/defaults.js")
]);
const runtime = await startVigilRuntime({ port: 0 });

for (const error of [new Error("obsolete source fetch failed"), null]) {
  const staleState = defaultState();
  const staleSource = adultBlocklistSource(staleState);
  staleState.settings.adultBlocklistSourceId = "stevenblack-porn";
  staleState.adultBlocklist.lastAttemptAt = "2026-07-14T12:00:00.000Z";
  staleState.adultBlocklist.lastError = "new source status";
  const attemptedAt = "2026-07-14T13:00:00.000Z";
  await assert.rejects(
    commitAdultBlocklistRefresh(staleState, {
      attemptedAt,
      source: staleSource,
      snapshot: error ? null : {
        version: 1,
        generatedAt: attemptedAt,
        domainCount: 1,
        hash: "obsolete-source-hash",
        source: staleSource,
        domains: ["obsolete.example"]
      },
      error
    }),
    (refreshError: Error & { status?: number }) => {
      assert.equal(refreshError.status, 409);
      assert.match(refreshError.message, /source changed/u);
      return true;
    },
    `${error ? "failed" : "successful"} preparation must be rejected after its source changes`
  );
  assert.equal(staleState.adultBlocklist.lastAttemptAt, "2026-07-14T12:00:00.000Z");
  assert.equal(staleState.adultBlocklist.lastError, "new source status");
}

const routeSource = await readFile(new URL("../src/server/adultBlocklistRoutes.js", import.meta.url), "utf8");
assert.match(
  routeSource,
  /await saveState\(state\);\s*afterCommit\([\s\S]*?kind: "adult-blocklist-finalize"/u,
  "adult blocklist cleanup must be queued as a recoverable durable effect after the refreshed state commits"
);
assert.doesNotMatch(
  routeSource,
  /await saveState\(state\);\s*await finalizeAdultBlocklistSnapshot\(state\)/u,
  "adult blocklist cleanup must not run inside the staged persistence transaction"
);
const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
assert.match(
  serverSource,
  /entry\.kind === "adult-blocklist-finalize"[\s\S]*?finalizeAdultBlocklistSnapshot\(state\)/u,
  "startup recovery must know how to replay adult blocklist cleanup"
);

try {
  assert.equal((await post("/api/adult-blocklist/settings", {
    adultBlocklistSourceId: "custom",
    adultBlocklistCustomUrl: "https://127.0.0.1/list.txt"
  })).status, 200);

  const response = await post("/api/adult-blocklist/refresh", {});
  assert.equal(response.status, 500);

  const liveState = stateFromResponse(await runtime.request({ path: "/api/state" }));
  assertFailureRecorded(liveState);

  await runtime.stop();
  const persistedState = await loadState();
  assertFailureRecorded(persistedState);

  await saveRuntimeSnapshot(persistedState, {}, { outbox: [{
    id: "adult-cleanup-recovery",
    key: "adult-blocklist-finalize:recovery-test",
    kind: "adult-blocklist-finalize",
    payload: { hash: "recovery-test", snapshotPath: "" },
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: "",
    status: "pending",
    startedAt: null,
    nextAttemptAt: null
  }] });
  const recoveredRuntime = await startVigilRuntime();
  assert.equal((await loadRuntimeOutbox()).length, 0, "startup recovery must complete and acknowledge adult blocklist cleanup");
  await recoveredRuntime.stop();
} finally {
  await runtime.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

async function post(path: string, body: Record<string, unknown>) {
  return await runtime.request({
    method: "POST",
    path,
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: JSON.stringify(body)
  });
}

function stateFromResponse(response: { status: number; body: Uint8Array }): Record<string, unknown> {
  assert.equal(response.status, 200);
  return recordValue((JSON.parse(Buffer.from(response.body).toString("utf8")) as Record<string, unknown>).state);
}

function assertFailureRecorded(stateValue: unknown): void {
  const state = recordValue(stateValue);
  const adultBlocklist = recordValue(state.adultBlocklist);
  assert.match(String(adultBlocklist.lastAttemptAt || ""), /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(String(adultBlocklist.lastError || ""), /private network/u);
  const events = Array.isArray(state.events) ? state.events.map(recordValue) : [];
  assert.equal(events.some((event) => event.type === "adult_blocklist_refresh_failed"), true);
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
