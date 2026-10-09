import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const safariResources = join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources");
const html = await readFile(join(runtimeRoot, "extension/search-break.html"), "utf8");
const source = await readFile(join(runtimeRoot, "extension/search-break-page.js"), "utf8");
assert.equal(await readFile(join(safariResources, "search-break.html"), "utf8"), html, "Safari ships the same minimal search-break page");
assert.equal(await readFile(join(safariResources, "search-break-page.js"), "utf8"), source, "Safari ships the same search-break expiry behavior");
assert.match(html, /<h1>Blocked<\/h1>/u);
assert.deepEqual([...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gu)].map(match => match[1]), ["Back"], "Back is the sole block-page action, including after expiry");
const countdownTag = html.match(/<p\b[^>]*id="searchBreakCountdown"[^>]*>/u)?.[0] || "";
assert.match(countdownTag, /\bhidden\b/u, "the countdown remains diagnostic metadata");
const countdown = { textContent: "", hidden: true };
let blocked = true;
let interval = () => {};
let stopped = false;
runInNewContext(source, {
  chrome: { runtime: { async sendMessage() { return { ok: true, blocked, remainingMs: blocked ? 150_000 : 0 }; } } },
  document: { getElementById(id: string) { return id === "searchBreakCountdown" ? countdown : null; } },
  setInterval(callback: () => void) { interval = callback; return 1; },
  clearInterval(id: number) { assert.equal(id, 1); stopped = true; }
});
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(countdown.hidden, true);
assert.equal(stopped, false, "an active break continues polling");
blocked = false;
interval();
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(countdown.hidden, true, "expiry preserves the minimal visible page");
assert.equal(stopped, true, "verified expiry stops polling without adding an action");
console.log("Search-break pages preserve the minimal Blocked/Back contract through expiry and Safari parity.");
