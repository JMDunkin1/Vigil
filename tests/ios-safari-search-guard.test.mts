import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const resources = join(root, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources");
const source = await readFile(join(resources, "search-guard.js"), "utf8");
assert.equal(source, await generatedIosSafariGuard(), "Safari must ship the current desktop guard");
const manifest = JSON.parse(await readFile(join(resources, "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[3].js, ["search-guard.js", "media-child-lock.js"]);
assert.equal(manifest.content_scripts[3].run_at, "document_start");
assert.equal(manifest.content_scripts[3].all_frames, true);

class SearchInput {
  tagName = "INPUT";
  value = "";
  getAttribute(name: string): string | null { return name === "type" ? "search" : null; }
  closest(): null { return null; }
}
const blockedURL = "safari-web-extension://vigil/blocked.html";
function page(url: string, runtimeAvailable = true) {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let interval = () => {};
  const location = { href: url, replace: (target: string) => redirects.push(target), assign: (target: string) => redirects.push(target) };
  runInNewContext(source, {
    URL, URLSearchParams, location, Element: SearchInput,
    browser: runtimeAvailable ? { runtime: { getURL: (path: string) => `safari-web-extension://vigil/${path}` } } : undefined,
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    setInterval: (callback: () => void) => { interval = callback; }
  });
  return { redirects, listeners, location, tick: () => interval() };
}
for (const url of [
  "https://example.org/search?q=porn",
  "https://example.org/search?q=%2570%256f%2572%256e",
  "https://www.reddit.com/search?q=sex",
  "https://www.pixiv.net/en/tags/nudity/artworks",
  "https://www.google.com/search?q=adult+content+on+artstation",
  "https://example.org/search?q=Jane+Example+leaks"
]) assert.deepEqual(page(url).redirects, [blockedURL], url);
for (const url of [
  "https://health.example/article/sex-education",
  "https://www.reddit.com/search?q=Middlesex",
  "https://example.org/search?q=iphone+leaks",
  "https://www.google.com/search?q=nude+art+figure+drawing&safe=active"
]) assert.deepEqual(page(url).redirects, [], url);
assert.equal(new URL(page("https://www.google.com/search?q=landscapes&safe=off").redirects[0]).searchParams.get("safe"), "active");
const dynamic = page("https://www.reddit.com/");
dynamic.location.href = "https://www.reddit.com/search?q=adult+content";
dynamic.tick();
assert.deepEqual(dynamic.redirects, [blockedURL], "same-document navigation is checked");
const inputPage = page("https://www.reddit.com/");
const input = new SearchInput();
input.value = "adult content";
let cancelled = false;
inputPage.listeners.get("input")!({ target: input, type: "input", cancelable: true, preventDefault: () => { cancelled = true; }, stopImmediatePropagation() {} });
assert.equal(cancelled, true);
assert.deepEqual(inputPage.redirects, [blockedURL], "search-box input is checked before submission");
console.log("iOS Safari desktop search parity, navigation, input, benign searches and bundled freshness passed.");

assert.deepEqual(page("https://example.org/search?q=porn", false).redirects, ["about:blank"], "missing extension APIs still leave the blocked page");
assert.deepEqual(manifest.web_accessible_resources, [{ resources: ["blocked.html", "blocked.css"], matches: ["http://*/*", "https://*/*"] }]);
