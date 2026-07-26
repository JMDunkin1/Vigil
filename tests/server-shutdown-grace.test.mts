import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-shutdown-grace-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [{ startVigilRuntime, startVigilServer, stopVigilServer }, store] = await Promise.all([
  import("../src/server.js"),
  import("../src/store.js")
]);
let markNetworkStatusStarted = () => {};
const networkStatusStarted = new Promise<void>((resolve) => { markNetworkStatusStarted = resolve; });
let finishNetworkStatus = (_result: unknown) => {};
const networkStatusGate = new Promise<unknown>((resolve) => { finishNetworkStatus = resolve; });
const handle = await startVigilServer({
  host: "127.0.0.1",
  port: 0,
  appUpdate: {
    async status() {
      markNetworkStatusStarted();
      return await networkStatusGate;
    },
    async start() { return { ok: true }; },
    async relaunch() { return { ok: true, relaunching: true }; }
  }
});
const socket = connect(handle.port, "127.0.0.1");

try {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    "POST /api/settings HTTP/1.1",
    `Host: 127.0.0.1:${handle.port}`,
    "Content-Type: application/json",
    "X-Vigil-Intent: vigil-app",
    "Content-Length: 100",
    "Connection: keep-alive",
    "",
    "{"
  ].join("\r\n"));
  socket.resume();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stalledNetworkStatus = fetch(`http://127.0.0.1:${handle.port}/api/app-update/status`, {
    headers: { "X-Vigil-Intent": "vigil-app" }
  }).then(() => "resolved", () => "rejected");
  await networkStatusStarted;

  const persistedState = await readFile(store.STATE_PATH);
  await replaceStateFileWithDirectory();
  const socketClosed = new Promise<boolean>((resolve) => socket.once("close", () => resolve(true)));
  const started = Date.now();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(stopVigilServer(), "the forced final snapshot failure must reject shutdown");
  } finally {
    console.error = originalConsoleError;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4_500, `shutdown cut off the active request too early (${elapsed} ms)`);
  assert.ok(elapsed < 6_500, `shutdown exceeded its five-second grace period (${elapsed} ms)`);
  assert.equal(await Promise.race([
    socketClosed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
  ]), true, "shutdown must close the stalled request socket");
  const resumed = await fetch(`http://127.0.0.1:${handle.port}/favicon.ico`);
  assert.equal(resumed.status, 204, "a failed shutdown must restore the force-closed listener before reporting resumed");
  await rm(store.STATE_PATH, { recursive: true, force: true });
  await writeFile(store.STATE_PATH, persistedState, { mode: 0o600 });
  finishNetworkStatus({ ok: true });
  await stalledNetworkStatus;
  await stopVigilServer();

  let markInAppStatusStarted = () => {};
  const inAppStatusStarted = new Promise<void>((resolve) => { markInAppStatusStarted = resolve; });
  let finishInAppStatus = (_result: unknown) => {};
  const inAppStatusGate = new Promise<unknown>((resolve) => { finishInAppStatus = resolve; });
  const runtime = await startVigilRuntime({
    appUpdate: {
      async status() {
        markInAppStatusStarted();
        return await inAppStatusGate;
      },
      async start() { return { ok: true }; },
      async relaunch() { return { ok: true, relaunching: true }; }
    }
  });
  const stalledInAppRequest = runtime.request({
    method: "GET",
    path: "/api/app-update/status",
    headers: { "X-Vigil-Intent": "vigil-app" }
  });
  await inAppStatusStarted;
  let runtimeStopped = false;
  const stoppingRuntime = runtime.stop().then(() => { runtimeStopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtimeStopped, false, "shutdown must retain the old runtime while an admitted in-app request is active");
  await assert.rejects(
    startVigilRuntime(),
    /stopping/u,
    "a replacement runtime must not start before admitted work is quiescent"
  );
  finishInAppStatus({ ok: true });
  assert.equal((await stalledInAppRequest).status, 200);
  await stoppingRuntime;
  const restarted = await startVigilRuntime();
  await restarted.stop();
} finally {
  socket.destroy();
  await stopVigilServer().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

async function replaceStateFileWithDirectory(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await rm(store.STATE_PATH, { recursive: true, force: true });
    try {
      await mkdir(store.STATE_PATH);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 9) throw error;
    }
  }
}
