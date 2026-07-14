import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-server-transactions-"));
process.env.VIGIL_DATA_DIR = dataDir;
process.env.VIGIL_EXTENSION_TOKEN = "transaction-test-extension-token";
process.env.VIGIL_EXTENSION_ORIGIN = "chrome-extension://transaction-test";

const [{ startVigilRuntime, startVigilServer }, store] = await Promise.all([
  import("../src/server.js"),
  import("../src/store.js")
]);
const runtime = await startVigilRuntime({ port: 0 });

try {
  const initial = await currentState();
  const initialSettings = recordValue(initial.settings);

  await withStateWriteFailure(async () => {
    const response = await runtime.request({
      path: "/api/extension/check?url=https%3A%2F%2Fexample.com%2F&event=heartbeat&seconds=4",
      headers: extensionHeaders()
    });
    assert.equal(response.status, 500, "mutating extension GET must be coordinated in-app");
  });
  const stagedKeyPath = join(dataDir, "staged-distance-key.txt");
  await withStateWriteFailure(async () => {
    const response = await post("/api/distance-key", { rotate: true, writeKeyFile: true, keyFilePath: stagedKeyPath });
    assert.equal(response.status, 500);
  });
  await assert.rejects(access(stagedKeyPath), /ENOENT/u, "failed commit must remove its staged distance-key file");
  await withStateWriteFailure(async () => {
    const response = await runtime.request({ path: "/api/devices/ios/profile.mobileconfig" });
    assert.equal(response.status, 500, "mutating profile-download GET must be coordinated in-app");
  });

  const network = await startVigilServer({ port: 0 });
  await withStateWriteFailure(async () => {
    const response = await fetch(`${network.url}/api/extension/rules?version=1`, { headers: extensionHeaders() });
    assert.equal(response.status, 500, "mutating extension GET must be coordinated over the network transport");
  });

  await withStateWriteFailure(async () => {
    const response = await post("/api/settings", { browserNoiseBlockingEnabled: !initialSettings.browserNoiseBlockingEnabled });
    assert.equal(response.status, 500);
    assert.equal(recordValue((await currentState()).settings).browserNoiseBlockingEnabled, initialSettings.browserNoiseBlockingEnabled);
  });

  await withStateWriteFailure(async () => {
    const response = await post("/api/session/start", {
      title: "Transactional session",
      mode: "focus",
      profileId: "default",
      durationMinutes: 30,
      lockLevel: "light",
      deviceTargets: ["computer"]
    });
    assert.equal(response.status, 500);
    assert.equal((await currentState()).activeSession, null, "a failed session-start write must not change live enforcement");
  });

  assert.equal((await post("/api/session/start", {
    title: "Persisted session",
    mode: "focus",
    profileId: "default",
    durationMinutes: 30,
    lockLevel: "light",
    deviceTargets: ["computer"]
  })).status, 200);
  const activeId = recordValue((await currentState()).activeSession).id;

  await withStateWriteFailure(async () => {
    const response = await post("/api/session/end", { deviceTargets: ["computer"] });
    assert.equal(response.status, 500);
    assert.equal(recordValue((await currentState()).activeSession).id, activeId, "a failed session-end write must retain live enforcement");
  });

  assert.equal((await post("/api/session/end", { deviceTargets: ["computer"] })).status, 200);
  const [first, second] = await Promise.all([
    post("/api/settings", { browserNoiseBlockingEnabled: false }),
    post("/api/settings", { siteRedirectEnabled: false })
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const finalSettings = recordValue((await currentState()).settings);
  assert.equal(finalSettings.browserNoiseBlockingEnabled, false);
  assert.equal(finalSettings.siteRedirectEnabled, false, "serialized drafts must preserve concurrent updates");

  await runtime.stop();
  await assert.rejects(runtime.request({ path: "/api/state" }), /not accepting|not initialized/u);
  const restarted = await startVigilRuntime({ port: 0 });
  assert.equal((await restarted.request({ path: "/api/health" })).status, 200, "a fully stopped runtime must restart cleanly");
  await restarted.stop();
} finally {
  await runtime.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

function extensionHeaders(): Record<string, string> {
  return {
    Origin: "chrome-extension://transaction-test",
    "X-Vigil-Extension-Token": "transaction-test-extension-token"
  };
}

async function withStateWriteFailure(run: () => Promise<void>): Promise<void> {
  const persisted = await readFile(store.STATE_PATH);
  await rm(store.STATE_PATH, { force: true });
  await mkdir(store.STATE_PATH);
  try {
    await run();
  } finally {
    await rm(store.STATE_PATH, { recursive: true, force: true });
    await writeFile(store.STATE_PATH, persisted, { mode: 0o600 });
  }
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

async function currentState(): Promise<Record<string, unknown>> {
  const response = await runtime.request({ path: "/api/state" });
  assert.equal(response.status, 200);
  return recordValue(jsonBody(response).state);
}

function jsonBody(response: { body: Uint8Array }): Record<string, unknown> {
  return JSON.parse(Buffer.from(response.body).toString("utf8")) as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
