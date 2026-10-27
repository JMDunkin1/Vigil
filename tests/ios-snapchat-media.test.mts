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
type Request = { audio?: unknown; video?: unknown };
function harness({ hostname = "www.snapchat.com", pathname = "/web/", iframe = false, denied = false } = {}) {
  const calls: Request[] = [];
  const permissionError = new DOMException("Camera denied", "NotAllowedError");
  const cameras = Object.freeze([
    Object.freeze({kind:"videoinput",deviceId:"real-front",label:"Front Ultra Wide"}),
    Object.freeze({kind:"videoinput",deviceId:"real-back",label:"Back Wide"})
  ]);
  const streams: Array<{ request: Request; stopped: boolean; stop: () => void }> = [];
  const devices = Object.freeze({
    async enumerateDevices() { return cameras; },
    async getUserMedia(request: Request) {
      calls.push(request);
      if (denied) throw permissionError;
      const stream = { request, stopped:false, stop() { this.stopped=true; } };
      streams.push(stream); return stream;
    }
  });
  const window: { top?: unknown; __vigilSnapchatCameraInstalled?: boolean; webkit: unknown } = {
    // A stale/unsupported bridge must never be required to open a real camera.
    webkit:{messageHandlers:{vigilSnapchatCamera:{postMessage(){throw new Error("Native capture must not run");}}}}
  };
  window.top = iframe ? {} : window;
  const context = { window, navigator:{mediaDevices:devices}, location:{hostname,pathname},
    document:{createElement(){throw new Error("Never create a detached capture consumer or canvas stream");}} };
  runInNewContext(bootstrap!, context);
  return {devices,cameras,calls,streams,permissionError,window,
    reinstall(){runInNewContext(bootstrap!,context);} };
}
const h = harness();
const getUserMedia = h.devices.getUserMedia, enumerateDevices = h.devices.enumerateDevices;
h.reinstall();
assert.equal(h.window.__vigilSnapchatCameraInstalled,true);
assert.equal(h.devices.getUserMedia,getUserMedia);
assert.equal(h.devices.enumerateDevices,enumerateDevices);
assert.equal(await h.devices.enumerateDevices(),h.cameras,"Keep WebKit's actual device IDs, labels, and list identity");
for (const id of ["real-front","real-back","real-front"]) {
  const request = {audio:{echoCancellation:true},video:{deviceId:{exact:id},width:{ideal:406},height:{ideal:720},aspectRatio:{exact:9/16}}};
  const copy = structuredClone(request);
  const stream = await h.devices.getUserMedia(request);
  assert.equal(h.calls.at(-1),request,"Preserve the original request object and selected camera");
  assert.equal(stream,h.streams.at(-1),"Return the real stream, without replacing track methods or settings");
  assert.deepEqual(request,copy);
}
const preflight = {audio:true,video:true};
const selected = {audio:false,video:{deviceId:{exact:"real-back"}}};
const [first,second] = await Promise.all([h.devices.getUserMedia(preflight),h.devices.getUserMedia(selected)]);
assert.equal(first.request,preflight); assert.equal(second.request,selected);
assert.equal(first.stopped,false,"A permission preflight must not be canceled by camera acquisition");
first.stop(); assert.equal(second.stopped,false,"Stopping the preflight cannot stop the selected camera");
const denied = harness({denied:true});
await assert.rejects(denied.devices.getUserMedia({video:true}),reason=>reason===denied.permissionError);
assert.equal(denied.calls.length,1,"Do not retry or transform permission errors");
for (const options of [
  {hostname:"accounts.snapchat.com",pathname:"/v2/login"},
  {hostname:"www.snapchat.com.evil.example"},{pathname:"/spotlight"},{iframe:true}
]) {
  const other=harness(options);
  assert.equal(other.window.__vigilSnapchatCameraInstalled,undefined);
}
console.log("Snapchat camera recovery: original capture/enumeration APIs, real streams, device choices, overlapping preflight, cleanup, denials and scope passed.");
