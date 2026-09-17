import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(join(root, "ios/VigilSocial/VigilSocial/SocialWebViewStore.swift"), "utf8");
const script = source.match(/static let youtubeOrientationScript = """([\s\S]*?)"""/u)?.[1];
assert.ok(script);
const video = { paused: false, ended: false, readyState: 4, webkitDisplayingFullscreen: false };
const location = { pathname: "/", search: "" };
const document = { fullscreenElement: null as object | null, webkitFullscreenElement: null,
  querySelector: () => video, addEventListener() {} };
const messages: boolean[] = [];
let update = () => {};
runInNewContext(script, { document, location, URLSearchParams,
  window: { addEventListener() {}, webkit: { messageHandlers: { vigil: {
    postMessage: (message: { allowed: boolean }) => messages.push(message.allowed)
  } } } }, setInterval: (callback: () => void) => { update = callback; } });
function expectRotation(allowed: boolean) { update(); assert.equal(messages.at(-1), allowed); }
expectRotation(false); // Home-feed autoplay.
location.pathname = "/watch"; location.search = "?v=ordinary-video";
expectRotation(true);
video.paused = true; expectRotation(false);
video.webkitDisplayingFullscreen = true; expectRotation(true); // Paused native fullscreen.
video.webkitDisplayingFullscreen = false; expectRotation(false);
document.fullscreenElement = {}; expectRotation(true); // HTML fullscreen.
video.ended = true; expectRotation(false);
video.ended = false; video.paused = false;
location.pathname = "/"; location.search = ""; expectRotation(false); // SPA return home.
location.pathname = "/shorts/id"; expectRotation(false);
console.log("YouTube orientation: playback, pause, fullscreen, end and browsing passed.");
