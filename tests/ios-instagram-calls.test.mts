import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const adapters = readFileSync(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const services = readFileSync(join(root, "ios/VigilSocial/VigilSocial/SocialService.swift"), "utf8");
const compatibility = adapters.match(/private static let instagramCallingCompatibility = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(compatibility);

function harness({ hostname = "www.instagram.com", pathname = "/direct/t/friend/", protocol = "https:", port = "", iframe = false } = {}) {
  const calls: unknown[][] = [];
  const child = {};
  const window: { top?: unknown; open: (url: unknown, ...args: unknown[]) => unknown } = {
    open(...args: unknown[]) { calls.push(args); return child; }
  };
  window.top = iframe ? {} : window;
  const nativeOpen = window.open;
  const context = { window, location: { hostname, pathname, protocol, port } };
  runInNewContext(compatibility!, context);
  return { window, calls, child, nativeOpen, reinstall() { runInNewContext(compatibility!, context); } };
}
const h = harness();
const installed = h.window.open;
h.reinstall();
assert.equal(h.window.open, installed);
assert.equal(h.window.open("www.instagram.com", "", "width=960,height=540"), h.child,
  "Meta must receive a real child window, retaining opener and asynchronous initialization");
assert.deepEqual(h.calls[0], ["about:blank", "", "width=960,height=540"]);
for (const url of ["/call/?has_video=true", "/call/?has_video=false", "https://example.com", undefined]) {
  h.window.open(url);
  assert.equal(h.calls.at(-1)?.[0], url, "Do not generate, rewrite or send call/signalling parameters");
}
const feed = harness({ pathname: "/" });
feed.window.open("www.instagram.com");
assert.equal(feed.calls[0][0], "www.instagram.com");
for (const options of [{ hostname: "evil.instagram.com" }, { hostname: "example.com" },
  { protocol: "http:" }, { port: "444" }, { iframe: true }]) {
  const other = harness(options);
  assert.equal(other.window.open, other.nativeOpen, "Keep unrelated/authentication frames untouched");
}

// Execute the production Swift admission policy, with no app/simulator/UI.
const policy = services.match(/enum InstagramCallPolicy \{[\s\S]*?\n\}(?=\n\nenum SnapchatWebCompatibility)/u)?.[0];
assert.ok(policy);
const microphoneBootstrap = adapters.match(/private static let snapchatCallBootstrap = #"""([\s\S]*?)"""#/u)?.[0];
const instagramAudioProperty = adapters.match(/static var instagramCallAudioBootstrap: String \{[\s\S]*?\n    \}/u)?.[0];
assert.ok(microphoneBootstrap && instagramAudioProperty);
const directory = await mkdtemp(join(tmpdir(), "vigil-instagram-call-policy-"));
try {
  const file = join(directory, "main.swift");
  await writeFile(file, `import Foundation\n${policy}\n
enum CallScripts { ${microphoneBootstrap}\n${instagramAudioProperty}\n }
print("CALL_AUDIO:" + Data(CallScripts.instagramCallAudioBootstrap.utf8).base64EncodedString())
let chat = URL(string: "https://www.instagram.com/direct/t/123/")!
let call = URL(string: "https://www.instagram.com/call/?has_video=false&call_id=fixture")!
precondition(InstagramCallPolicy.isCallURL(call))
precondition(InstagramCallPolicy.allowsPopupStart(call, from: chat))
precondition(InstagramCallPolicy.allowsPopupStart(URL(string: "about:blank")!, from: chat))
for value in ["http://www.instagram.com/call/", "https://evil.instagram.com/call/",
 "https://www.instagram.com.evil.com/call/", "https://www.instagram.com:444/call/",
 "https://user:pass@www.instagram.com/call/", "https://www.instagram.com/call/other",
 "https://www.instagram.com/%63all/", "https://www.instagram.com/explore/",
 "https://www.instagram.com/direct/t/123/"] {
 precondition(!InstagramCallPolicy.isCallURL(URL(string: value)!))
 precondition(!InstagramCallPolicy.allowsPopupStart(URL(string: value)!, from: chat))
}
for value in ["https://example.com/direct/t/123/", "https://www.instagram.com/accounts/login/",
 "https://www.instagram.com/explore/", "https://www.instagram.com/direct/%74/123/",
 "http://www.instagram.com/direct/t/123/"] {
 precondition(!InstagramCallPolicy.allowsPopupStart(call, from: URL(string: value)))
}
precondition(!InstagramCallPolicy.allowsPopupStart(call, from: nil))
precondition(!InstagramCallPolicy.allowsPopupStart(URL(string:"https://instagram.com/call/")!, from: chat))
print("Instagram native call policy passed")
`);
  const result = await promisify(execFile)("xcrun", ["swift", file], { timeout: 60_000 });
  assert.match(result.stdout, /native call policy passed/u);
  const encoded = result.stdout.match(/CALL_AUDIO:([^\n]+)/u)?.[1];
  assert.ok(encoded);
  const audioScript = Buffer.from(encoded, "base64").toString("utf8");
  for (const pathname of ["/call/", "/direct/inbox/", "/accounts/login/", "/call/other"]) {
    let sessionType = "auto";
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const track = { readyState: "live", addEventListener() {}, stop() { this.readyState = "ended"; } };
    const stream = { getAudioTracks: () => [track] };
    const devices = { async getUserMedia() { return stream; } };
    const capture = devices.getUserMedia;
    const window: { top?: unknown } = {};
    window.top = window;
    runInNewContext(audioScript, {
      window, location: { protocol: "https:", hostname: "www.instagram.com", pathname, port: "" },
      navigator: { mediaDevices: devices, audioSession: {
        get type() { return sessionType; }, set type(value: string) { sessionType = value; }
      } },
      document: { visibilityState: "visible", addEventListener() {} }, addEventListener() {},
      setTimeout(handler: () => void) { const id = ++nextTimer; timers.set(id, handler); return id; },
      clearTimeout(id: number) { timers.delete(id); }
    });
    if (pathname !== "/call/") {
      assert.equal(devices.getUserMedia, capture, "Instagram microphone compatibility is confined to the call document");
      continue;
    }
    assert.equal(await (devices.getUserMedia as (request: unknown) => Promise<unknown>)({ audio: true }), stream);
    assert.equal(sessionType, "play-and-record");
    track.stop();
    [...timers.values()].forEach(handler => handler());
    assert.equal(sessionType, "auto");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("Instagram calls: real popup identity, Safari placeholder, audio/video parameters, idempotence and native origin/route admission passed.");
