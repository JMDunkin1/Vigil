import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));
const source = await readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/ContentSafety.js"), "utf8");
const declarations = source.slice(source.indexOf("  const mediaElements = new Map();"), source.indexOf("  const sendNative ="));
const mediaMethods = source.slice(source.indexOf("  globalThis.__vigilResolveMedia ="), source.indexOf("  const extractText ="));
const inspection = source.slice(source.indexOf("  const inspectDocument ="), source.indexOf("    const extracted = extractText("));
assert.ok(declarations && mediaMethods && inspection);

class TestMedia {
  dataset: Record<string, string> = {};
  currentSrc = "https://example.test/media";
  complete = false;
  readyState = 0;
  listeners = new Map<string, Set<() => void>>();
  addEventListener(event: string, callback: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }
  removeEventListener(event: string, callback: () => void): void { this.listeners.get(event)?.delete(callback); }
  fire(event: string): void { for (const callback of [...this.listeners.get(event) || []]) callback(); }
}
class TestImage extends TestMedia {}
class TestVideo extends TestMedia {}
class TestWeakRef {
  target: object | undefined;
  constructor(target: object) { this.target = target; }
  deref(): object | undefined { return this.target; }
}
const image = new TestImage();
const video = new TestVideo();
let elements: TestMedia[] = [image, video];
const requests: { id: string; token: string }[] = [];
const context = runInNewContext(`${declarations}\n${mediaMethods}\n${inspection}\n};\n({ inspectDocument, mediaElements, resolve: globalThis.__vigilResolveMedia });`, {
  WeakRef: TestWeakRef,
  HTMLImageElement: TestImage,
  HTMLVideoElement: TestVideo,
  document: { querySelectorAll: () => elements },
  capture: () => "data:image/jpeg;base64,AA==",
  isWebKitBrowser: true,
  sendNative: (payload: { id: string; token: string }) => { requests.push(payload); return Promise.resolve(null); }
}) as {
  inspectDocument(): void;
  mediaElements: Map<string, TestWeakRef>;
  resolve(id: string, token: string, verdict: string): void;
};
for (let i = 0; i < 100; i++) context.inspectDocument();
assert.equal(image.listeners.get("load")?.size, 1, "repeated mutations must not accumulate image readiness callbacks");
assert.equal(video.listeners.get("loadeddata")?.size, 1, "repeated mutations must not duplicate video capture/classification");
assert.equal(requests.length, 0);
image.complete = true;
video.readyState = 2;
image.fire("load");
video.fire("loadeddata");
assert.equal(requests.length, 2);
assert.equal(image.listeners.get("error")?.size, 0);
assert.equal(video.listeners.get("error")?.size, 0);
for (const request of requests) context.resolve(request.id, request.token, "safe");
assert.equal(image.dataset.vigilMediaVerdict, "safe");
assert.equal(video.dataset.vigilMediaVerdict, "safe");

// Removing a node must not make a delayed verdict lose the protection of a
// detached node that the page still owns and can later reattach.
elements = [];
context.inspectDocument();
assert.equal(context.mediaElements.size, 2);
context.resolve(requests[0].id, requests[0].token, "sensitive");
assert.equal(image.dataset.vigilMediaVerdict, "sensitive");
context.resolve(requests[0].id, requests[0].token, "safe");
assert.equal(image.dataset.vigilMediaVerdict, "sensitive", "sensitive verdicts stay sticky");
for (const reference of context.mediaElements.values()) reference.target = undefined;
context.inspectDocument();
assert.equal(context.mediaElements.size, 0, "collected media must release its ID wrapper at the next inspection");

const failed = new TestImage();
elements = [failed];
context.inspectDocument();
failed.fire("error");
assert.equal(failed.listeners.get("load")?.size, 0);
context.inspectDocument();
assert.equal(failed.listeners.get("load")?.size, 1, "a failed load must permit one new readiness handler");
failed.complete = true;
failed.fire("load");
assert.equal(requests.length, 3);

// Exercise the native-pressure retry protocol with deterministic timers. Retry
// exhaustion must leave text concealed and ordinary new mutations must recover.
const pageResolver = source.slice(source.indexOf("  const scheduleTextRetry ="), source.indexOf("  const inspectDocument ="));
const scheduler = source.slice(source.indexOf("  const scheduleInspection ="), source.indexOf("  new MutationObserver(scheduleInspection)"));
const timers = new Map<number, { callback: () => void; delay: number }>();
let timerID = 0;
const page = { dataset: { vigilPageVerdict: "unknown" } };
const retryContext = runInNewContext(`${declarations}\n${pageResolver}\n${scheduler}\nconst inspectDocument = () => { inspectionScheduled = false; beginTextRevision(); };\n({
  resolve: globalThis.__vigilResolvePageText,
  schedule: scheduleInspection,
  beginNativeBatch: () => scheduleTextRetry(String(textRevision)),
  revision: () => String(textRevision)
});`, {
  document: { documentElement: page },
  setTimeout: (callback: () => void, delay: number) => {
    const id = ++timerID;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout: (id: number) => { timers.delete(id); }
}) as {
  resolve(revision: string, verdict: string, retry?: boolean): void;
  schedule(isRetry?: unknown): void;
  beginNativeBatch(): void;
  revision(): string;
};
const runTimer = (delay: number) => {
  const entry = [...timers].find(([, timer]) => timer.delay === delay);
  assert.ok(entry, `expected a ${delay}ms timer`);
  timers.delete(entry[0]);
  entry[1].callback();
};
for (let attempt = 0; attempt < 3; attempt++) {
  retryContext.resolve(retryContext.revision(), "unknown", true);
  retryContext.resolve(retryContext.revision(), "unknown", true);
  assert.equal(timers.size, 1, "multiple rejected chunks must share one retry timer");
  assert.equal(page.dataset.vigilPageVerdict, "unknown");
  runTimer(2000);
  runTimer(120);
}
retryContext.resolve(retryContext.revision(), "unknown", true);
assert.equal(timers.size, 0, "native pressure must not cause unlimited retry polling");
assert.equal(page.dataset.vigilPageVerdict, "unknown");
retryContext.schedule([]); // MutationObserver's records argument resets the budget.
runTimer(120);
retryContext.resolve(retryContext.revision(), "unknown", false);
assert.equal(timers.size, 0, "malformed input must not trigger repeated classification");
retryContext.resolve(retryContext.revision(), "unknown", true);
assert.equal(timers.size, 1, "a genuine page mutation starts a fresh bounded retry budget");
retryContext.resolve(retryContext.revision(), "safe");
assert.equal(page.dataset.vigilPageVerdict, "safe");
assert.equal(timers.size, 0, "a valid result must cancel redundant pending retry work");
retryContext.resolve("old-revision", "unknown", true);
assert.equal(timers.size, 0, "obsolete native results must not schedule new work");

// A dropped prefix or failed provisional navigation may produce no native
// result at all. The same finite budget must recover that static page.
retryContext.schedule([]);
runTimer(120);
for (let attempt = 0; attempt < 3; attempt++) {
  retryContext.beginNativeBatch();
  assert.equal(timers.size, 1);
  runTimer(2000);
  runTimer(120);
}
retryContext.beginNativeBatch();
assert.equal(timers.size, 0);
assert.equal(page.dataset.vigilPageVerdict, "unknown");
retryContext.resolve(retryContext.revision(), "safe");
assert.equal(page.dataset.vigilPageVerdict, "safe", "the final native attempt can still reveal a completed valid page");
retryContext.schedule([]);
runTimer(120);
retryContext.beginNativeBatch();
retryContext.resolve(retryContext.revision(), "unknown", false);
assert.equal(timers.size, 0, "an explicit permanent rejection cancels the missing-response timer");
assert.match(source, /if \(isWebKitBrowser\) \{[\s\S]*?scheduleTextRetry\(revision\);\s*chunks\.forEach/u);

// An old native pressure result can arrive during the 120ms mutation debounce.
// Starting the replacement revision must retire that old timer so the new
// batch cannot lose its missing-response watchdog.
retryContext.schedule([]);
retryContext.resolve(retryContext.revision(), "unknown", true);
assert.equal(timers.size, 1, "obsolete native pressure must not schedule work while a replacement scan is pending");
retryContext.resolve(retryContext.revision(), "safe");
assert.equal(page.dataset.vigilPageVerdict, "unknown", "old safe verdicts cannot reveal freshly mutated uninspected content during debounce");
retryContext.resolve(retryContext.revision(), "sensitive");
assert.equal(page.dataset.vigilPageVerdict, "unknown", "obsolete sensitive verdicts also belong to the previous document revision");
runTimer(120);
assert.equal(timers.size, 0, "new revision must cancel an obsolete retry timer");
retryContext.beginNativeBatch();
assert.equal(timers.size, 1);
const revisionBeforeRetry = retryContext.revision();
runTimer(2000);
runTimer(120);
assert.notEqual(retryContext.revision(), revisionBeforeRetry, "latest dropped batch must still retry");
