import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(process.env.VIGIL_SNAPCHAT_ADAPTERS
  || join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const bootstrap = source.match(/private static let snapchatCallBootstrap = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(bootstrap, "The Snapchat call audio bootstrap must exist");

function harness({host="www.snapchat.com", path="/web/", protocol="https:", port="", frame=false,
  supported=true, denied=false, type="auto"}={}) {
  const events: Record<string, () => void> = {};
  const changes: string[] = [];
  const calls: unknown[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer=0;
  const trackEvents: Record<string, () => void> = {};
  const track = {readyState:"live",enabled:true,
    stop(){this.readyState="ended";},
    addEventListener(name: string, handler: () => void){trackEvents[name]=handler;}};
  const stream={getAudioTracks:()=>[track]};
  const permissionError=new DOMException("denied","NotAllowedError");
  const session={get type(){return type;},set type(value: string){type=value;changes.push(value);}};
  const devices={async getUserMedia(request: unknown){calls.push(request);if(denied)throw permissionError;return stream;}};
  const capture=devices.getUserMedia, stop=track.stop;
  const window: {top?: unknown; __vigilSnapchatCallsInstalled?: boolean; __vigilPublishSnapchatRenderState?: () => void}={};
  window.top=frame?{}:window;
  const document={visibilityState:"visible",addEventListener(name: string, handler: () => void){events[name]=handler;}};
  const context={window,document,location:{hostname:host,pathname:path,protocol,port},
    navigator:{mediaDevices:devices,audioSession:supported?session:undefined},
    addEventListener(name: string, handler: () => void){events[name]=handler;},
    setTimeout(handler: () => void){const id=++nextTimer;timers.set(id,handler);return id;},
    clearTimeout(id: number){timers.delete(id);}};
  runInNewContext(bootstrap!,context);
  return {window,document,devices,capture,track,stop,stream,session,calls,changes,events,trackEvents,timers,
    tick(){const work=[...timers.values()];timers.clear();work.forEach(f=>f());},
    reinstall(){runInNewContext(bootstrap!,context);},permissionError};
}
const h=harness();
assert.deepEqual(h.changes,[],"Opening chat cannot acquire a recording session");
const request={audio:{echoCancellation:true},video:false};
assert.equal(await h.devices.getUserMedia(request),h.stream);
assert.equal(h.calls[0],request,"Preserve microphone constraints, request and real stream identity");
assert.equal(h.session.type,"play-and-record","Configure WebKit's session after real microphone acquisition");
assert.equal(h.track.stop,h.stop,"Never replace track.stop or its caller-owned lifetime");
const installed=h.devices.getUserMedia;h.reinstall();assert.equal(h.devices.getUserMedia,installed);
h.track.enabled=false;h.tick();assert.equal(h.session.type,"play-and-record","Muting a live call must retain duplex output");
h.track.stop();h.tick();
assert.deepEqual(h.changes,["play-and-record","playback","auto"],"Last microphone stop clears capture gain before normal playback");
assert.equal(h.timers.size,0,"No polling remains after the microphone ends");
const ended=harness();await ended.devices.getUserMedia({audio:true});ended.track.readyState="ended";ended.trackEvents.ended();
assert.equal(ended.session.type,"auto");assert.equal(ended.timers.size,0);
const hidden=harness();await hidden.devices.getUserMedia({audio:true});hidden.document.visibilityState="hidden";hidden.events.visibilitychange();
assert.equal(hidden.session.type,"auto");assert.equal(hidden.track.readyState,"live");
hidden.document.visibilityState="visible";hidden.events.visibilitychange();assert.equal(hidden.session.type,"play-and-record");
hidden.events.pagehide();assert.equal(hidden.timers.size,0);assert.equal(hidden.session.type,"auto");
const choice=harness();await choice.devices.getUserMedia({audio:true});choice.session.type="ambient";choice.track.stop();choice.tick();
assert.equal(choice.session.type,"ambient","Preserve an intervening site/user session choice");
const prior=harness({type:"playback"});await prior.devices.getUserMedia({audio:true});prior.track.stop();prior.tick();
assert.equal(prior.session.type,"playback");
const video=harness();await video.devices.getUserMedia({video:true,audio:false});assert.deepEqual(video.changes,[]);
const denied=harness({denied:true});await assert.rejects(denied.devices.getUserMedia({audio:true}),e=>e===denied.permissionError);
assert.deepEqual(denied.changes,[]);assert.equal(denied.calls.length,1,"Do not retry permissions");
const diagnostic=harness();diagnostic.window.__vigilPublishSnapchatRenderState=()=>{throw new Error("Diagnostic failure");};
assert.equal(await diagnostic.devices.getUserMedia({audio:true}),diagnostic.stream,"Diagnostics cannot reject successful microphone capture");
diagnostic.track.stop();diagnostic.tick();assert.equal(diagnostic.session.type,"auto");
for(const options of [{host:"accounts.snapchat.com"},{host:"example.com"},{path:"/spotlight/"},
  {protocol:"http:"},{port:"444"},{frame:true},{supported:false}]) {
  const other=harness(options);assert.equal(other.devices.getUserMedia,other.capture,"Leave other documents and unsupported engines unchanged");
}
console.log("Snapchat call audio: capture lifecycle, stopped/ended/muted tracks, background/foreground, user choices, permission and origin boundaries passed.");
