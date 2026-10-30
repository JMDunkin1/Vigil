import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(join(root, "ios/VigilSocial/VigilSocial/SocialNotifications.swift"), "utf8");
const script = source.match(/static let inboxScript = #"""([\s\S]*?)"""#/u)![1]!;

function monitor() {
  let now = 1_800_000_000_000;
  let body: unknown;
  let httpStatus = 200;
  let visibility = "visible";
  let redirect = false;
  let oversized = false;
  const calls: { url: string; options: RequestInit }[] = [];
  const context = vm.createContext({
    URL, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    Date: { now: () => now },
    location: { protocol: "https:", hostname: "www.instagram.com", origin: "https://www.instagram.com" },
    document: { get visibilityState() { return visibility; } },
    localStorage: { getItem: () => null }, generation: "first",
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      const response = new Response(oversized ? " ".repeat(2 * 1024 * 1024 + 1) : JSON.stringify(body), {
        status: httpStatus, headers: { "content-type": "application/json" }
      });
      Object.defineProperties(response, { url: { value: url }, redirected: { value: redirect } });
      return response;
    }
  });
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    item_id: id, user_id: 200, item_type: "text", text: "private text",
    timestamp: String(BigInt(now) * 1000n), ...extra
  });
  return {
    context, calls, item,
    advance() { now += 1000; },
    hidden(value: boolean) { visibility = value ? "hidden" : "visible"; },
    status(value: number) { httpStatus = value; },
    redirect(value: boolean) { redirect = value; },
    oversized(value: boolean) { oversized = value; },
    async poll(items: Record<string, unknown>[], thread: Record<string, unknown> = {}) {
      body = { status: "ok", inbox: { threads: [{
        thread_id: "thread-1", viewer_id: 100, muted: false, pending: false, archived: false, items, ...thread
      }] } };
      return JSON.parse(JSON.stringify(await vm.runInContext(`(async () => { ${script} })()`, context))) as {
        status: string; hasMessage: boolean
      };
    }
  };
}

test("seeds old inbox history, alerts on a new text, deduplicates without exporting private data", async () => {
  const fixture = monitor();
  assert.deepEqual(await fixture.poll([fixture.item("old")]), { status: "ready", hasMessage: false });
  fixture.advance();
  const incoming = fixture.item("new");
  assert.deepEqual(await fixture.poll([incoming]), { status: "ready", hasMessage: true });
  assert.deepEqual(await fixture.poll([incoming]), { status: "ready", hasMessage: false });
  assert.equal(fixture.calls[0]!.url,
    "https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20&thread_message_limit=10");
  assert.equal(fixture.calls[0]!.options.credentials, "same-origin");
  assert.equal(fixture.calls[0]!.options.redirect, "error");
  assert.equal(fixture.calls[0]!.options.body, undefined, "Inbox checks never send or mark messages read");
});

test("shared reels, media, links, reactions, and call history cannot become text alerts", async () => {
  const fixture = monitor();
  await fixture.poll([]); fixture.advance();
  for (const kind of ["reel_share", "media", "media_share", "raven_media", "xma_media_share", "link", "like", "video_call_event", "unknown"]) {
    assert.equal((await fixture.poll([fixture.item(kind, { item_type: kind })])).hasMessage, false, kind);
  }
  for (const key of ["reel_share", "media_share", "visual_media", "story_share", "video_call_event"]) {
    assert.equal((await fixture.poll([fixture.item(`mixed-${key}`, { [key]: {} })])).hasMessage, false, key);
  }
  assert.equal((await fixture.poll([fixture.item("reel-url", { text: "https://www.instagram.com/reel/Example/" })])).hasMessage, false);
  assert.equal((await fixture.poll([fixture.item("personal"), fixture.item("shared", { item_type: "reel_share" })])).hasMessage, true,
    "A separate text still alerts in a thread that contains shared reels");
});

test("outgoing, muted, pending, malformed and stale entries stay silent", async () => {
  const fixture = monitor();
  await fixture.poll([]); fixture.advance();
  for (const [name, extra] of Object.entries({
    own: { user_id: 100 }, sender: { user_id: null }, blank: { text: " " },
    timestamp: { timestamp: "bad" }, stale: { timestamp: "1799999900000000" },
    future: { timestamp: "1999999999999999999" }
  })) {
    assert.equal((await fixture.poll([fixture.item(name, extra)])).hasMessage, false, name);
  }
  assert.equal((await fixture.poll([fixture.item("muted")], { muted: true })).hasMessage, false);
  assert.equal((await fixture.poll([fixture.item("pending")], { pending: true })).hasMessage, false);
  assert.equal((await fixture.poll([fixture.item("no-viewer")], { viewer_id: null })).status, "unavailable");
});

test("account switches and foreground generations establish fresh baselines", async () => {
  const fixture = monitor();
  await fixture.poll([]); fixture.advance();
  fixture.context.generation = "resumed";
  assert.equal((await fixture.poll([fixture.item("during-pause")])).hasMessage, false);
  fixture.advance();
  assert.equal((await fixture.poll([fixture.item("after-resume")])).hasMessage, true);
  fixture.advance();
  assert.equal((await fixture.poll([fixture.item("other-account")], { viewer_id: 300 })).hasMessage, false);
});

test("hidden pages make no requests; failed, redirected and oversized responses reset the baseline", async () => {
  const fixture = monitor();
  fixture.hidden(true);
  assert.equal((await fixture.poll([])).status, "waiting");
  assert.equal(fixture.calls.length, 0);
  fixture.hidden(false);
  await fixture.poll([]); fixture.advance();
  fixture.status(403);
  assert.deepEqual(await fixture.poll([fixture.item("blocked")]), { status: "unavailable", hasMessage: false });
  fixture.status(200); fixture.advance();
  assert.equal((await fixture.poll([fixture.item("recovered")])).hasMessage, false);
  fixture.redirect(true);
  assert.equal((await fixture.poll([])).status, "unavailable");
  fixture.redirect(false); fixture.oversized(true);
  assert.equal((await fixture.poll([])).status, "unavailable");
});

test("native polling and delivery preserve policy, session isolation, and separate reminder consent", () => {
  assert.match(source, /policyAllows\(\), UIApplication\.shared\.applicationState == \.active/u);
  assert.match(source, /contentWorld: \.defaultClient/u);
  assert.match(source, /webView\.url == documentURL, instagramAccessAllowed\(webView\)/u);
  assert.match(source, /guard service != \.instagram, service != \.snapchat, enabled/u, "Generic page events cannot deliver contact-only service alerts");
  assert.match(source, /isAuthorized, remindersEnabled, !preferences\.savedScheduleUnreadable/u);
  const app = readFileSync(join(root, "ios/VigilSocial/VigilSocial/VigilSocialApp.swift"), "utf8");
  assert.match(app, /else \{ SocialNotifications\.shared\.invalidateWebAlerts\(\) \}/u);
  const store = readFileSync(join(root, "ios/VigilSocial/VigilSocial/SocialWebViewStore.swift"), "utf8");
  assert.match(store, /func suspendAllMedia\([^\n]*\) \{\s*managedWebViews\.forEach \{ SocialNotifications\.shared\.invalidateWebAlerts/u);
});
