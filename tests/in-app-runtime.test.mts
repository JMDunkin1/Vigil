import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-in-app-runtime-"));
process.env.VIGIL_DATA_DIR = dataDir;
process.env.VIGIL_EXTENSION_TOKEN = "runtime-test-token";
const { startVigilCompanionServer, startVigilRuntime } = await import("../src/server.js");
const { createLoopbackRuntimeProxy } = await import("../src/server/inAppTransport.js");
const port = await unusedPort();
const runtime = await startVigilRuntime({ port });

try {
  const health = await runtime.request({ path: "/api/health" });
  assert.equal(health.status, 200);
  assert.equal(recordValue(jsonBody(health).monitor).status, "healthy");

  const index = await runtime.request({ path: "/" });
  assert.equal(index.status, 200);
  assert.match(String(index.headers["Content-Type"]), /text\/html/u);
  assert.match(Buffer.from(index.body).toString("utf8"), /<title>Vigil<\/title>/u);

  const settings = await runtime.request({
    method: "POST",
    path: "/api/settings",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: JSON.stringify({ browserNoiseBlockingEnabled: false })
  });
  assert.equal(settings.status, 200);
  assert.equal(jsonBody(settings).ok, true);

  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }),
    /fetch failed|aborted|ECONNREFUSED/iu,
    "starting the in-app runtime must not open a localhost listener"
  );

  await startVigilCompanionServer({ port });
  const proxy = createLoopbackRuntimeProxy(port);
  const proxiedHealth = await proxy.request({ path: "/api/health" });
  assert.equal(proxiedHealth.status, 200, "Electron must be able to reuse the verified development server without starting another runtime");
  await proxy.stop();
  const healthAfterProxyStop = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthAfterProxyStop.status, 200, "stopping Electron's proxy must not stop the separately owned development server");
  const malformedTargetResponse = await rawHttpRequest(port, "GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  assert.match(malformedTargetResponse, /^HTTP\/1\.1 500 /u, "malformed request targets must receive a guarded error response");
  const companionHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(companionHealth.status, 200, "the companion listener must remain healthy after a malformed request target");
  const companionPairing = await fetch(`http://127.0.0.1:${port}/api/extension/pairing`, {
    headers: { "X-Vigil-Extension-Token": "runtime-test-token" }
  });
  assert.equal(companionPairing.status, 200, "the companion listener must preserve extension reachability");
  const blockedPage = await fetch(`http://127.0.0.1:${port}/blocked?site=example.com`);
  assert.equal(blockedPage.status, 200, "the companion listener must preserve browser redirect pages");
  const companionIndex = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(companionIndex.status, 200, "pause-page links must reach the Vigil handoff page");
  const companionIndexHtml = await companionIndex.text();
  assert.match(companionIndexHtml, /<title>Open Vigil<\/title>/u);
  assert.match(companionIndexHtml, /Open Vigil from the menu bar/u);
  assert.doesNotMatch(companionIndexHtml, /<script\b/u, "the restricted companion must not expose the interactive app shell");
  for (const path of ["/api/panic/start", "/api/protection/level"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vigil-Intent": "vigil-app"
      },
      body: "{}"
    });
    assert.equal(response.status, 404, `${path} must remain private now that the companion serves a handoff page`);
  }
  for (const path of [
    "/api/emergency/request",
    "/api/emergency/confirm",
    "/api/app-lock/unlock/request",
    "/api/app-lock/unlock/confirm"
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vigil-Intent": "vigil-app"
      },
      body: "{}"
    });
    assert.notEqual(recordValue(await response.json()).error, "Not found", `${path} must reach the blocked-page unlock handler`);
  }
  const companionState = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(companionState.status, 200, "the companion listener must preserve agent snapshots and iOS profile state reads");
  const companionSettings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: JSON.stringify({ browserNoiseBlockingEnabled: true })
  });
  assert.equal(companionSettings.status, 200, "the companion listener must preserve agent configuration mutations");
  process.env.VIGIL_AUTH_ENABLED = "1";
  process.env.VIGIL_SIGNUPS_ENABLED = "1";
  process.env.VIGIL_BOOTSTRAP_TOKEN = "companion-bootstrap-token";
  const rejectedBootstrap = await fetch(`http://127.0.0.1:${port}/api/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Vigil Admin", email: "admin@example.test", password: "a-secure-password" })
  });
  assert.equal(rejectedBootstrap.status, 403, "the companion signup route must still require the hosted bootstrap token");
  const acceptedBootstrap = await fetch(`http://127.0.0.1:${port}/api/account/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Bootstrap-Token": "companion-bootstrap-token"
    },
    body: JSON.stringify({ name: "Vigil Admin", email: "admin@example.test", password: "a-secure-password" })
  });
  assert.equal(acceptedBootstrap.status, 201, "the restricted companion must preserve a token-authenticated first-admin bootstrap path");
  delete process.env.VIGIL_AUTH_ENABLED;
  delete process.env.VIGIL_SIGNUPS_ENABLED;
  delete process.env.VIGIL_BOOTSTRAP_TOKEN;
  for (const path of [
    "/api/profile",
    "/api/schedule",
    "/api/limit",
    "/api/app-lock",
    "/api/intentional-use/goal",
    "/api/intentional-use/rule",
    "/api/intentional-use/accountability",
    "/api/grayscale/settings",
    "/api/grayscale/schedule",
    "/api/devices/ios/settings",
    "/api/devices/ios/mdm/settings",
    "/api/intentional-use/journal/security"
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vigil-Intent": "vigil-app"
      },
      body: "{}"
    });
    assert.notEqual(response.status, 404, `${path} must remain reachable by the agent configuration interface`);
  }
  const usbProfileApply = await fetch(`http://127.0.0.1:${port}/api/devices/ios/usb-profile-apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: "{}"
  });
  assert.notEqual(usbProfileApply.status, 404, "the iOS USB workflow must be able to prepare the active profile");
  const iosProfile = await fetch(`http://127.0.0.1:${port}/api/devices/ios/profile.mobileconfig`);
  assert.notEqual(iosProfile.status, 404, "the iOS USB workflow must be able to download the active profile");
  const privateDiagnostics = await fetch(`http://127.0.0.1:${port}/api/diagnostic/export`);
  assert.equal(privateDiagnostics.status, 404, "the companion listener must keep unrelated private app APIs off the network");
} finally {
  await runtime.stop();
  await rm(dataDir, { recursive: true, force: true });
}

function jsonBody(response: { body: Uint8Array }): Record<string, unknown> {
  return JSON.parse(Buffer.from(response.body).toString("utf8")) as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("connect", () => socket.end(request));
  });
}
