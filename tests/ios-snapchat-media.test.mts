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
function harness({ hostname = "www.snapchat.com", pathname = "/web/", protocol = "https:", port = "", iframe = false, denied = false, camera = true, mobile = true } = {}) {
  const calls: Request[] = [];
  const permissionError = new DOMException("Camera denied", "NotAllowedError");
  const cameras = Object.freeze([
    Object.freeze({kind:"videoinput",deviceId:"real-front",label:"Front Ultra Wide"}),
    Object.freeze({kind:"videoinput",deviceId:"real-back",label:"Back Wide"})
  ]);
  const streams: Array<{ request: Request; stopped: boolean; stop: () => void; getVideoTracks: () => never[] }> = [];
  const devices = {
    async enumerateDevices() { return cameras; },
    getSupportedConstraints() { return {resizeMode:true}; },
    async getUserMedia(request: Request) {
      calls.push(request);
      if (denied) throw permissionError;
      const stream = { request, stopped:false, stop() { this.stopped=true; },getVideoTracks:()=>[] };
      streams.push(stream); return stream;
    }
  };
  const originalCapture=devices.getUserMedia,originalEnumeration=devices.enumerateDevices;
  const window: { top?: unknown; __vigilSnapchatCameraInstalled?: boolean; webkit: unknown } = {
    webkit:{messageHandlers:{vigilSnapchatCamera:{postMessage(){throw new Error("Native capture must not run");}}}}
  };
  window.top = iframe ? {} : window;
  const context = { window, navigator:{mediaDevices:devices}, location:{hostname,pathname,protocol,port},
    performance:{now:()=>0},matchMedia:()=>({matches:mobile}),getComputedStyle:()=>({visibility:'visible'}),document:{
      querySelector(selector:string){return selector==='.BN1L1'&&camera?{getClientRects:()=>[{}]}:null;},
      addEventListener(){},
      createElement(){throw new Error("Never create a detached capture consumer or canvas stream");}} };
  runInNewContext(bootstrap!, context);
  return {devices,cameras,calls,streams,permissionError,window,originalCapture,originalEnumeration,
    reinstall(){runInNewContext(bootstrap!,context);} };
}
const h = harness();
const installedCapture=h.devices.getUserMedia;
h.reinstall();
assert.equal(h.window.__vigilSnapchatCameraInstalled,true);
assert.equal(h.devices.getUserMedia,installedCapture,"Install the adapter once");
assert.equal(h.devices.enumerateDevices,h.originalEnumeration);
assert.equal(await h.devices.enumerateDevices(),h.cameras,"Keep WebKit's actual device IDs, labels, and list identity");
for (const id of ["real-front","real-back","real-front"]) {
  const request = {audio:{echoCancellation:true},video:{deviceId:{exact:id},width:{ideal:406},height:{ideal:720},aspectRatio:{exact:9/16}}};
  const copy = structuredClone(request);
  const stream = await h.devices.getUserMedia(request);
  const sent=h.calls.at(-1)!;
  assert.equal(sent.audio,request.audio);
  assert.equal((sent.video as {deviceId:unknown}).deviceId,request.video.deviceId);
  for(const key of ['width','height','aspectRatio','zoom'])assert.equal(key in (sent.video as object),false);
  assert.equal((sent.video as {resizeMode:unknown}).resizeMode,'none');
  assert.equal(stream,h.streams.at(-1),"Return the real stream, without replacing track methods or settings");
  assert.deepEqual(request,copy,"Leave Snapchat's request object untouched");
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
await assert.rejects(denied.devices.getUserMedia({audio:false,video:{width:{ideal:406},height:{ideal:720}}}),
  reason=>reason===denied.permissionError);
assert.equal(denied.calls.length,2,"A denied portrait request cannot retry camera authorization");
const advanced={audio:false,video:{width:{ideal:406},height:{ideal:720},
  advanced:[{width:{exact:406},aspectRatio:{exact:9/16},zoom:{exact:4},torch:true}]}};
const advancedCopy=structuredClone(advanced);
await h.devices.getUserMedia(advanced);
assert.equal(JSON.stringify((h.calls.at(-1)!.video as {advanced:unknown}).advanced),JSON.stringify([{torch:true}]));
assert.deepEqual(advanced,advancedCopy,"Nested sizing and zoom constraints cannot mutate Snapchat's request");
for (const options of [
  {hostname:"accounts.snapchat.com",pathname:"/v2/login"},
  {hostname:"www.snapchat.com.evil.example"},{pathname:"/spotlight"},{protocol:"http:"},{port:"444"},{iframe:true}
]) {
  const other=harness(options);
  assert.equal(other.window.__vigilSnapchatCameraInstalled,undefined);
}
for(const options of [{camera:false},{mobile:false}]) {
  const other=harness(options),request={audio:true,video:{width:{ideal:406},height:{ideal:720}}};
  await other.devices.getUserMedia(request);
  assert.equal(other.calls[0],request,"Calls and desktop capture retain their original requests");
}
console.log("Snapchat portrait acquisition: uncropped request, real streams/devices, audio, preflight overlap, denials and scope passed.");

// Exercise only the verified hidden-mirror call shape. Pixel/encoded-photo
// behavior is checked separately by the real WKWebView regression.
function drawingHarness() {
  const body = {};
  class Canvas {
    width=90; height=160; parentElement: unknown=body;
    style={position:"absolute",opacity:"0",pointerEvents:"none"};
  }
  class Stream {
    deviceId="actual-camera";
    getVideoTracks() { return [{getSettings:()=>({deviceId:this.deviceId})}]; }
  }
  class Video {
    parentElement: unknown=body; style={position:"absolute",opacity:"0",pointerEvents:"none"};
    srcObject=new Stream(); videoWidth=160;videoHeight=90;readyState=2;
  }
  class Context {
    canvas=new Canvas();globalAlpha=1;globalCompositeOperation="source-over";
    transform={a:-1,b:0,c:0,d:1,e:0,f:0}; draws:unknown[][]=[];clears:number[][]=[];
    getTransform() { return this.transform; }
    setTransform(a:number,b:number,c:number,d:number,e:number,f:number) { this.transform={a,b,c,d,e,f}; }
    clearRect(...args:number[]) { this.clears.push(args); }
    drawImage(source:unknown,...args:number[]) { this.draws.push([source,...args]); }
  }
  const window:{top?:unknown}={};window.top=window;
  const location={hostname:"www.snapchat.com",pathname:"/web/",protocol:"https:",port:""};
  let mobile=true;
  const context={window,location,document:{body,addEventListener(){}},matchMedia:()=>({matches:mobile}),
    CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,HTMLVideoElement:Video,MediaStream:Stream};
  runInNewContext(bootstrap!,context);
  const ctx=new Context(),video=new Video();
  return {ctx,video,location,body,desktop(){mobile=false;},
    draw(...args:number[]){ctx.drawImage(video,...args);}};
}
const mirror=drawingHarness();
mirror.draw(-90,0);
assert.deepEqual(mirror.ctx.draws[0]?.slice(1),[-160,0,160,90]);
assert.deepEqual([mirror.ctx.canvas.width,mirror.ctx.canvas.height],[160,90]);
assert.deepEqual(mirror.ctx.clears[0],[-160,0,160,90]);
for(const [width,height] of [[90,160],[120,120],[160,90]]) {
  mirror.video.videoWidth=width!;mirror.video.videoHeight=height!;
  mirror.draw(-mirror.ctx.canvas.width,0);
  assert.deepEqual([mirror.ctx.canvas.width,mirror.ctx.canvas.height],[width,height]);
  assert.deepEqual(mirror.ctx.draws.at(-1)?.slice(1),[-width!,0,width,height]);
}
const pending=drawingHarness();pending.video.readyState=1;pending.video.videoWidth=0;
pending.draw(-90,0);
assert.equal(pending.ctx.draws.length,0,"Wait for decoded pixels instead of throwing in Snapchat's mirror timer");
assert.deepEqual([pending.ctx.canvas.width,pending.ctx.canvas.height],[90,160]);
const excluded:Array<(h:ReturnType<typeof drawingHarness>)=>void>=[
  h=>{h.video.parentElement={};},h=>{h.ctx.canvas.parentElement={};},
  h=>{h.video.style.opacity="1";},h=>{h.ctx.canvas.style.pointerEvents="auto";},
  h=>{h.video.srcObject.deviceId="";},h=>{h.ctx.transform.a=1;},
  h=>{h.ctx.globalAlpha=0.5;},h=>{h.ctx.globalCompositeOperation="destination-in";},
  h=>{h.location.pathname="/spotlight/";},h=>{h.location.protocol="http:";},h=>h.desktop()
];
for(const exclude of excluded) {
  const other=drawingHarness();exclude(other);other.draw(-90,0);
  assert.deepEqual(other.ctx.draws[0]?.slice(1),[-90,0],"Unrelated/remote/visible/masked/off-route draws must retain original behavior");
  assert.deepEqual([other.ctx.canvas.width,other.ctx.canvas.height],[90,160]);
}
const ordinary=drawingHarness();ordinary.draw(0,0,30,40);
assert.deepEqual(ordinary.ctx.draws[0]?.slice(1),[0,0,30,40]);
console.log("Snapchat mirror: decoded dimensions, landscape/portrait/square switches, first-frame wait, ordinary draws, remote/masked media and route boundaries passed.");
