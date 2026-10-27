import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = await readFile(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const bootstrap = source.match(/private static let snapchatCameraBootstrap = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(bootstrap);
type Request = Record<string, unknown>;
type NativeWindow = {
  top: unknown; __vigilDocumentID: string;
  __vigilSnapchatNativeFrame: (token: string | null, jpeg: string) => Promise<boolean>;
  __vigilSnapchatNativeEnd: (token: string | null) => void;
};
type NativeTrack = Track & {
  getSettings: () => Record<string, unknown>;
  applyConstraints: (request: Request) => Promise<void>;
};
class Track extends EventTarget {
  stopped = false;
  stop() { this.stopped = true; }
}
class Stream {
  tracks: Track[];
  constructor(tracks = [new Track()]) { this.tracks = tracks; }
  getVideoTracks() { return this.tracks.filter(track => track !== microphone); }
  getAudioTracks() { return this.tracks.filter(track => track === microphone); }
  getTracks() { return this.tracks; }
  addTrack(track: Track) { this.tracks.push(track); }
}
const microphone = new Track();
function harness({ native = true, width = 390, hostname = "www.snapchat.com", pathname = "/web/", iframe = false,
  denied = false, audioDenied = false } = {}) {
  const requests: Request[] = [], browserCalls: Request[] = [], rendered: string[] = [];
  const cameras = [
    { deviceId: "front-ultra", facingMode: "user", label: "Front Ultra Wide" },
    { deviceId: "back-wide", facingMode: "environment", label: "Back Wide" },
    { deviceId: "back-ultra", facingMode: "environment", label: "Back Ultra Wide" }
  ];
  let activeToken: string | null = null;
  const bridge = { async postMessage(request: Request) {
    requests.push(request);
    assert.equal(request.documentID, "current-document");
    if (request.action === "devices") return cameras;
    if (request.action === "stop") { if (request.token === activeToken) activeToken = null; return {}; }
    if (denied) throw new Error("NotAllowedError");
    const camera = request.deviceId ? cameras.find(camera => camera.deviceId === request.deviceId)
      : cameras.find(camera => camera.facingMode === request.facingMode);
    if (!camera) throw new Error("OverconstrainedError");
    activeToken = String(request.token);
    return { ...camera, frameRate: 20 };
  }};
  const devices = Object.assign(new EventTarget(), {
    async enumerateDevices() { return [{kind:"videoinput",deviceId:"webkit-front"},{kind:"audioinput",deviceId:"mic"}]; },
    async getUserMedia(request: Request) {
      browserCalls.push(request);
      if (audioDenied) throw new DOMException("Microphone denied", "NotAllowedError");
      return new Stream(request.video ? [new Track()] : [microphone]);
    }
  });
  const originalCapture = devices.getUserMedia, originalEnumerate = devices.enumerateDevices;
  class Canvas {
    width = 0; height = 0;
    getContext() { return { drawImage: (image: ImageFixture) => rendered.push(image.key) }; }
    captureStream() { return new Stream(); }
  }
  class ImageFixture {
    src = ""; naturalWidth = 0; naturalHeight = 0; key = "";
    async decode() {
      const [key, w, h] = this.src.split(",")[1]!.split(":");
      this.key = key!; this.naturalWidth = Number(w); this.naturalHeight = Number(h);
      await Promise.resolve();
    }
  }
  const window = { __vigilDocumentID: "current-document",
    ...(native ? { webkit: { messageHandlers: { vigilSnapchatCamera: bridge } } } : {}) } as unknown as NativeWindow;
  window.top = iframe ? {} : window;
  const location = { hostname, pathname };
  const context = { window, navigator: { mediaDevices: devices }, location,
    matchMedia: () => ({ matches: width <= 600 }), crypto: { randomUUID },
    document: { createElement: () => new Canvas() }, Image: ImageFixture,
    DOMException, Event, setTimeout, clearTimeout, addEventListener: () => {} };
  runInNewContext(bootstrap!, context);
  return { window, devices, originalCapture, originalEnumerate, requests, browserCalls, rendered, location,
    activeToken: () => activeToken,
    async frame(key: string, dimensions = [600,800], token = activeToken) {
      return window.__vigilSnapchatNativeFrame(token, `${key}:${dimensions.join(":")}`);
    }, reinstall() { runInNewContext(bootstrap!, context); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const h = harness();
const listed = await h.devices.enumerateDevices();
assert.deepEqual(plain(listed.map(device => device.deviceId)), ["mic","front-ultra","back-wide","back-ultra"]);
assert.ok(!listed.some(device => device.deviceId === "webkit-front"), "Never label a default WebKit front camera as a selected rear lens");
let wrapped = h.devices.getUserMedia; h.reinstall(); assert.equal(h.devices.getUserMedia, wrapped);
let unintendedEnded = 0;
for (const id of ["front-ultra","back-wide","back-ultra","front-ultra","back-wide","front-ultra"]) {
  const request = { audio:false, video:{ deviceId:{exact:id}, width:{ideal:406},height:{ideal:720},aspectRatio:{exact:9/16} } };
  const copy = structuredClone(request);
  const pending = h.devices.getUserMedia(request);
  await tick();
  assert.equal(h.requests.at(-1)!.deviceId, id);
  await h.frame(id);
  const stream = await pending;
  assert.deepEqual(request, copy);
  const track = stream.getVideoTracks()[0] as NativeTrack;
  track.addEventListener("ended", () => { unintendedEnded += 1; });
  assert.deepEqual(plain(track.getSettings()), { width:600,height:800,aspectRatio:.75,frameRate:20,
    deviceId:id,facingMode:id.startsWith("front")?"user":"environment",resizeMode:"none" });
  await track.applyConstraints({width:{exact:406},height:{exact:720},zoom:5});
  assert.equal(track.getSettings().width,600,"Desktop constraints cannot crop a native camera buffer");
  await assert.rejects(track.applyConstraints({deviceId:{exact:"another-camera"}}),{name:"OverconstrainedError"});
}
assert.equal(h.browserCalls.length,0,"Video uses AVFoundation, with no WebKit camera or detached warmup consumer");
assert.equal(unintendedEnded,0,"Switching intentionally must not send a false capture-failure event to Snapchat");
const oldToken = h.activeToken();
const first = h.devices.getUserMedia({video:{deviceId:{exact:"back-wide"}}});
const firstRejected = assert.rejects(first,{name:"AbortError"});
await tick();
const firstToken = h.activeToken();
const latest = h.devices.getUserMedia({video:{deviceId:{exact:"front-ultra"}}});
await tick();
await h.frame("old",[600,800],oldToken);
await h.frame("superseded",[600,800],firstToken);
assert.ok(!h.rendered.includes("old") && !h.rendered.includes("superseded"),"Late camera frames never paint the new buffer");
await h.frame("latest");
const latestStream = await latest;
await firstRejected;
const currentToken = h.activeToken();
await h.window.__vigilSnapchatNativeEnd(firstToken);
assert.equal(h.activeToken(),currentToken,"A stale native end cannot stop the new camera");
latestStream.getVideoTracks()[0]!.stop();
await tick();
assert.equal(h.activeToken(),null,"Closing the camera releases AVFoundation");
const bad = harness();
const wrongFrame = bad.devices.getUserMedia({video:true});
const rejectedFrame = assert.rejects(wrongFrame,{name:"NotReadableError"});
await tick(); await bad.frame("landscape",[800,600]); await rejectedFrame;
assert.equal(bad.rendered.length,0,"Wrong-orientation frames must never become half-black/cropped previews");
const unavailable = harness();
await assert.rejects(unavailable.devices.getUserMedia({video:{deviceId:{exact:"missing-lens"}}}),{name:"OverconstrainedError"});
assert.equal(unavailable.browserCalls.length,0,"A missing selected camera must not silently turn into the front camera");
await assert.rejects(harness({denied:true}).devices.getUserMedia({video:true}),{name:"NotAllowedError"});
await assert.rejects(harness({audioDenied:true}).devices.getUserMedia({video:true,audio:true}),{name:"NotAllowedError"});
const audio = harness();
await audio.devices.getUserMedia({video:false,audio:{echoCancellation:true}});
assert.deepEqual(plain(audio.browserCalls),[{video:false,audio:{echoCancellation:true}}]);
const external = harness();
const externalCapture = external.devices.getUserMedia({video:true});
await tick(); await external.frame("external");
const externalStream = await externalCapture;
let externalEnded = 0;
externalStream.getVideoTracks()[0]!.addEventListener("ended",()=>{externalEnded+=1;});
external.window.__vigilSnapchatNativeEnd(external.activeToken());
assert.equal(externalStream.getVideoTracks()[0]!.stopped,true);
assert.equal(externalEnded,1,"Background/native shutdown must deliver a real capture-ended transition");
for (const options of [{native:false},{hostname:"accounts.snapchat.com"},{hostname:"www.snapchat.com.evil.test"},{pathname:"/spotlight"},{iframe:true}]) {
  const isolated = harness(options);
  assert.equal(isolated.devices.getUserMedia,isolated.originalCapture);
}
const desktop = harness({width:1100});
const desktopRequest = {video:{width:{ideal:406},height:{ideal:720}}};
await desktop.devices.getUserMedia(desktopRequest);
assert.equal(desktop.browserCalls[0],desktopRequest);
console.log("Native Snapchat camera: lens identity, full portrait frames, switch races, stale frames, cleanup, denial, microphone and scope passed.");
