import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "../..");
const compiled = await readFile(join(runtimeRoot, "src/youtubeCommentAvatars.js"), "utf8");
const guard = `(() => {\n${compiled.replace(/^export /gmu, "")}\ninstallYouTubeCommentAvatarMask();\n})();`;

function documentFixture(host: string, ready = true) {
  const styles: Array<{ id: string; textContent: string; isConnected: boolean }> = [];
  let observer: (() => void) | undefined;
  const root = { append(style: typeof styles[number]) { style.isConnected = true; if (!styles.includes(style)) styles.push(style); } };
  const document = {
    head: ready ? root : null, documentElement: ready ? root : null,
    createElement: () => ({ id: "", textContent: "", isConnected: false }),
    getElementById: (id: string) => styles.find(style => style.isConnected && style.id === id)
  };
  const context = { location: { hostname: host }, document,
    MutationObserver: class {
      constructor(callback: () => void) { observer = callback; }
      observe(target: unknown, options: unknown) {
        assert.equal(target, document);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { childList: true, subtree: true });
      }
    } };
  runInNewContext(guard, context);
  return { styles, document, root, context, mutate: () => observer?.() };
}

for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com"]) {
  const f = documentFixture(host, false);
  assert.equal(f.styles.length, 0);
  f.document.documentElement = f.root;
  f.mutate();
  assert.equal(f.styles.length, 1, "install as soon as the parser creates html, before DOMContentLoaded");
  f.styles[0].isConnected = false;
  f.document.head = f.root;
  f.mutate();
  assert.equal(f.styles[0].isConnected, true, "head replacement and SPA removal must restore the guard");
  runInNewContext(guard, f.context);
  assert.equal(f.styles.length, 1, "repeated injection cannot duplicate the stylesheet");
}
const excludedHosts = ["example.com", "notyoutube.com", "youtube.com.example.com", "youtube-nocookie.com",
  "accounts.google.com", "accounts.youtube.com", "consent.youtube.com"];
for (const host of excludedHosts) {
  assert.equal(documentFixture(host).styles.length, 0, "unrelated sites must not be masked");
  const context = { location: { hostname: host } };
  Object.defineProperty(context, "document", { get() { throw new Error(`DOM access on excluded host ${host}`); } });
  runInNewContext(guard, context);
}

for (const path of [
  "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-parity.js",
  "ios/VigilBrowser/VigilSafariExtension/Resources/ContentSafety.js"
]) {
  const source = await readFile(join(root, path), "utf8");
  const embedded = source.match(/\/\/ BEGIN GENERATED YOUTUBE COMMENT AVATARS\n([\s\S]*?)\n\/\/ END GENERATED YOUTUBE COMMENT AVATARS/u)?.[1];
  assert.equal(embedded, guard, `${path} must contain the current shared guard`);
  assert.ok(source.startsWith("// BEGIN GENERATED YOUTUBE COMMENT AVATARS"), "install before existing code can return on a Shorts route");
  if (path.endsWith("youtube-parity.js")) {
    for (const host of excludedHosts) {
      const window = {};
      Object.assign(window, { top: window });
      const context = { location: { hostname: host }, window };
      Object.defineProperty(context, "document", { get() { throw new Error(`Parity DOM access on excluded host ${host}`); } });
      runInNewContext(source, context);
    }
  }
}
const desktop = await readFile(join(runtimeRoot, "extension/content.js"), "utf8");
assert.ok(desktop.includes(compiled.replace(/^export /gmu, "")), "classic desktop content script must bundle the same guard");
assert.doesNotMatch(desktop, /^(?:import|export)\s/mu);
assert.ok(desktop.indexOf("installYouTubeCommentAvatarMask();") < desktop.indexOf("sendPulse(\"navigation\""), "no server response is needed before masking");
const mac = await readFile(join(root, "macos/Vigil Safari/Vigil Safari Extension/Resources/youtube-parity.js"), "utf8");
assert.equal(mac, await readFile(join(root, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-parity.js"), "utf8"));

// Real CSS/layout/pixel checks use WebKit on macOS. The fixture owns its custom
// URL scheme and serves only benign inline SVGs; it never launches Chrome.
if (process.platform === "darwin" && process.env.VIGIL_NATIVE_WEBKIT_FIXTURE === "1") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-avatar-fixture-"));
  try {
    const execute = promisify(execFile);
    const binary = join(directory, "avatar-fixture");
    const script = join(directory, "guard.js");
    await writeFile(script, guard);
    await execute("/usr/bin/swiftc", ["-module-cache-path", join(directory, "module-cache"),
      join(root, "tests/fixtures/youtube-comment-avatars.swift"), "-o", binary], { timeout: 60_000 });
    const args = [script, join(root, "tests/fixtures/youtube-comment-avatars.html")];
    if (process.env.VIGIL_AVATAR_SCREENSHOT_DIR) args.push(process.env.VIGIL_AVATAR_SCREENSHOT_DIR);
    const result = await execute(binary, args, { timeout: 35_000 });
    assert.equal(JSON.parse(result.stdout).passed, true);
    console.log(result.stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
} else console.log("Portable lifecycle/bundle checks passed. Set VIGIL_NATIVE_WEBKIT_FIXTURE=1 on macOS for the bounded local WebKit layout/pixel fixture.");
console.log("Shared YouTube comment-avatar guard regression checks passed.");
