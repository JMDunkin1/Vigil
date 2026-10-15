import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = await readFile(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const bootstrap = source.match(/private static let snapchatCameraBootstrap = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(bootstrap);

type Constraints = Record<string, unknown>;
function harness({ width = 390, hostname = "www.snapchat.com", pathname = "/web/", iframe = false,
  resizeMode = true, zoom = true, zoomFails = false, denied = false } = {}) {
  const calls: Constraints[] = [];
  const zoomCalls: Constraints[] = [];
  const permissionError = new Error("Permission denied");
  let active: Constraints = {};
  const track = {
    getCapabilities: () => zoom ? { zoom: { min: 1, max: 5 } } : {},
    getConstraints: () => active,
    async applyConstraints(value: Constraints) {
      zoomCalls.push(value);
      if (zoomFails) throw new Error("Optional zoom is unavailable");
    }
  };
  const stream = { getVideoTracks: () => [track] };
  const devices = {
    getSupportedConstraints: () => ({ resizeMode }),
    async getUserMedia(value: Constraints) {
      calls.push(value);
      if (denied) throw permissionError;
      active = value.video as Constraints;
      return stream;
    }
  };
  const original = devices.getUserMedia;
  const window: { top?: unknown } = {};
  window.top = iframe ? {} : window;
  const location = { hostname, pathname };
  const context = { window, navigator: { mediaDevices: devices }, location,
    matchMedia: () => ({ matches: width <= 600 }) };
  runInNewContext(bootstrap!, context);
  return { devices, original, calls, zoomCalls, stream, permissionError, location,
    reinstall() { runInNewContext(bootstrap!, context); } };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
for (const width of [320, 390, 430]) for (const resizeMode of [false, true]) {
  const h = harness({ width, resizeMode });
  const request = { audio: { deviceId: { exact: "chosen-mic" }, echoCancellation: true },
    video: { deviceId: { exact: "chosen-camera" }, height: { ideal: 2160 }, aspectRatio: { exact: 9 / 16 },
      frameRate: { max: 30 }, advanced: [{ aspectRatio: 9 / 16, zoom: 3, facingMode: "environment" }] } };
  const copy = structuredClone(request);
  assert.equal(await h.devices.getUserMedia(request), h.stream, "Return the original stream to Snapchat");
  const actual = plain(h.calls[0]);
  assert.deepEqual(request, copy, "Do not mutate Snapchat's retained request");
  assert.deepEqual(actual.audio, request.audio);
  assert.deepEqual(actual.video.deviceId, request.video.deviceId);
  assert.deepEqual(actual.video.frameRate, request.video.frameRate);
  assert.equal(actual.video.aspectRatio, undefined);
  assert.equal(actual.video.facingMode, undefined, "An explicit camera must not be replaced");
  assert.deepEqual(actual.video.advanced, [{ facingMode: "environment" }]);
  assert.deepEqual(actual.video.resizeMode, resizeMode ? { ideal: "none" } : undefined);
  const applied = plain(h.zoomCalls[0]);
  assert.deepEqual(applied.frameRate, { max: 30 }, "Optional zoom must retain acquisition constraints");
  assert.deepEqual(applied.advanced, [{ facingMode: "environment" }, { zoom: 1 }]);
  const wrapped = h.devices.getUserMedia;
  h.reinstall(); assert.equal(h.devices.getUserMedia, wrapped, "Start/end injection is idempotent");
  assert.equal(h.calls.length, 1);
}
for (const zoom of [false, true]) {
  const h = harness({ zoom, zoomFails: true });
  assert.equal(await h.devices.getUserMedia({ audio: false, video: true }), h.stream);
  const actual = plain(h.calls[0]);
  assert.equal(actual.audio, false);
  assert.deepEqual(actual.video.facingMode, { ideal: "user" });
  assert.equal(h.zoomCalls.length, zoom ? 1 : 0);
}
const rear = harness();
await rear.devices.getUserMedia({ audio: true, video: { facingMode: { exact: "environment" } } });
assert.deepEqual(plain(rear.calls[0]).video.facingMode, { exact: "environment" });
const audio = harness();
const audioRequest = { audio: true, video: false };
await audio.devices.getUserMedia(audioRequest);
assert.equal(audio.calls[0], audioRequest); assert.equal(audio.zoomCalls.length, 0);
const denied = harness({ denied: true });
await assert.rejects(denied.devices.getUserMedia({ video: true }), error => error === denied.permissionError);
assert.equal(denied.calls.length, 1, "Never retry or bypass a permission denial");
for (const options of [
  { hostname: "accounts.snapchat.com", pathname: "/v2/login" },
  { hostname: "www.snapchat.com.evil.test" }, { pathname: "/spotlight" }, { iframe: true }
]) {
  const h = harness(options);
  assert.equal(h.devices.getUserMedia, h.original, "Keep auth, other origins, and subframes untouched");
}
const desktop = harness({ width: 1100 });
const desktopRequest = { audio: false, video: { width: { ideal: 406 }, height: { ideal: 720 } } };
await desktop.devices.getUserMedia(desktopRequest);
assert.equal(desktop.calls[0], desktopRequest); assert.equal(desktop.zoomCalls.length, 0);
const changedRoute = harness(); changedRoute.location.pathname = "/discover";
await changedRoute.devices.getUserMedia(desktopRequest);
assert.equal(changedRoute.calls[0], desktopRequest);
console.log("Snapchat uncropped camera: sensor preferences, selected devices, audio, zoom fallback, permission denial, scope and idempotence passed.");
