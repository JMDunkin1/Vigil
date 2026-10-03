import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "../..");
const source = await readFile(process.env.VIGIL_VISUAL_SOURCE || join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const allowanceSource = await readFile(process.env.VIGIL_ALLOWANCE_SOURCE || join(root, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-limits.js"), "utf8");
const slice = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const signal = slice("      const signalVisualMutation =", "      const shadowDOM =");
const wrappers = slice("      const wrapMethod =", "      const patchAdoptedStyleSheets =");

class Declaration {
  private values = new Map<string, string>();
  nativeCalls = 0;
  get cssText() { return [...this.values].map(([key, value]) => `${key}:${value}`).join(";"); }
  setProperty(key: string, value: string, priority = "") {
    this.nativeCalls += 1;
    if (value === "") this.values.delete(key);
    else if (priority === "" || priority === "important") this.values.set(key, `${value}${priority ? " !important" : ""}`);
  }
  removeProperty(key: string) { this.nativeCalls += 1; const old = this.values.get(key) || ""; this.values.delete(key); return old; }
  get backgroundImage() { return this.values.get("background-image") || ""; }
  set backgroundImage(value: string) { this.values.set("background-image", value); }
  get content() { return this.values.get("content") || ""; }
  set content(value: string) { this.values.set("content", value); }
}
class Element { style = new Declaration(); }
class ShadowRoot { constructor(public host: Element) {} }
class Sheet {
  insertRule(_rule: string) { return 0; }
  replace(_rule: string) { return Promise.resolve(this); }
}
const document = {};
const trigger = new Element();
const siblingComments = new Element();
const closed = new ShadowRoot(trigger);
const siblingClosed = new ShadowRoot(siblingComments);
const protectedRoots = new Set([document, closed, siblingClosed]);
const markers: object[] = [], repairs: object[] = [], notifications: (object | null)[] = [];
const context = {
  Element, CSSStyleDeclaration: Declaration, CSSStyleSheet: Sheet,
  document, protectedRoots, safetySheetRoots: new WeakMap(),
  isShadowRoot: (value: unknown) => value instanceof ShadowRoot,
  markVisualPending: (value: object) => markers.push(value),
  ensureSafetyStyle: (value: object) => repairs.push(value),
  visualMutationSubscribers: new Set([(value: object | null) => notifications.push(value)])
};
runInNewContext(`${signal}\n${wrappers}`, context);
const reset = () => { markers.length = 0; repairs.length = 0; notifications.length = 0; };
const assertGlobal = (message: string) => {
  assert.deepEqual(markers, [...protectedRoots], message);
  assert.deepEqual(repairs, [...protectedRoots]);
  assert.deepEqual(notifications, [null], "actual inline changes retain the existing global inspection path");
};

trigger.style.setProperty("--flip", "1");
// A custom-property assignment also changes the style attribute, so a rule
// such as .trigger[style*="--flip: 1"] ~ .target::before can expose sibling media.
assertGlobal("a real custom-property change must synchronously gate sibling comments and every closed root");
reset();
for (let tick = 0; tick < 120; tick += 1) {
  trigger.style.setProperty("--flip", "1");
  assert.equal(trigger.style.removeProperty("content"), "");
}
assert.equal(trigger.style.nativeCalls, 241, "no-op filtering must still call the native CSS methods");
assert.deepEqual(markers, [], "unchanged timer/style reconciliation must not re-gate inspected content");
assert.deepEqual(notifications, []);
trigger.style.setProperty("--flip", "1", "invalid-priority");
assert.deepEqual(markers, [], "a rejected native CSS assignment makes no visual change");
trigger.style.setProperty("--flip", "1", "important");
assertGlobal("changing priority must still trigger global protection");
reset();
assert.equal(trigger.style.removeProperty("--flip"), "1 !important", "preserve native removeProperty results");
assertGlobal("removing a real custom property can change sibling visuals and must remain global");
reset();
trigger.style.backgroundImage = "url(benign.svg)";
assertGlobal("new inline media must be gated synchronously in every protected root");
reset();
trigger.style.backgroundImage = "url(benign.svg)";
assert.deepEqual(markers, [], "reassigning the same image must not invalidate inspected media");
trigger.style.content = "url(benign-content.svg)";
assertGlobal("changed generated content must retain global protection");
reset();
trigger.style.content = "url(benign-content.svg)";
assert.deepEqual(markers, [], "repeated generated-content assignments are no-ops");
new Sheet().insertRule(".trigger[style] ~ .target::before { content: url(benign.svg) }");
assertGlobal("stylesheet edits must retain global protection");
reset();
await new Sheet().replace(".target { background: url(benign.svg) }");
await Promise.resolve();
assert.deepEqual(markers, [...protectedRoots, ...protectedRoots], "asynchronous stylesheet edits must gate before and after completion");
assert.deepEqual(notifications, [null, null]);
console.log("iOS visual mutation regressions passed: native no-op calls, real changes, sibling selectors, closed roots and stylesheet gates.");

// Optional bounded real-WebKit check. The owned local fixture never launches
// a browser or reaches a remote site; native text replies cover benign text only.
if (process.platform === "darwin" && process.env.VIGIL_NATIVE_WEBKIT_FIXTURE === "1") {
  const factory = source.match(/private static let rootRegistryFactory = #"""\n([\s\S]*?)\n    """#/u)?.[1];
  assert.ok(factory);
  const block = slice("    static func contentFilterBootstrap(for", "    static func earlyMediaGate(");
  const literals = [...block.matchAll(/#"""\n([\s\S]*?)\n[ ]*"""#/gu)].map(value => value[1]);
  assert.equal(literals.length, 3);
  const common = slice("    private static func common(", "    private static func serviceScript(")
    .match(/return #"""\n([\s\S]*?)\n        """#/u)?.[1];
  assert.ok(common);
  const positioning = allowanceSource.slice(allowanceSource.indexOf("  function positionAllowance()"), allowanceSource.indexOf("  for (const event of ['fullscreenchange'"));
  assert.ok(positioning.includes("function positionAllowance()"));
  const allowanceCSS = allowanceSource.slice(allowanceSource.indexOf("  function mount()"))
    .match(/style\.textContent = `([^`]+)`/u)?.[1];
  assert.ok(allowanceCSS);
  const fixtureHTML = (await readFile(join(root, "tests/fixtures/ios-visual-mutation-scope.html"), "utf8"))
    .replace("/* PRODUCTION_ALLOWANCE_POSITION */", positioning)
    .replace("PRODUCTION_ALLOWANCE_CSS", JSON.stringify(allowanceCSS));
  const directory = await mkdtemp(join(tmpdir(), "vigil-visual-scope-"));
  try {
    const execute = promisify(execFile);
    const start = join(directory, "start.js"), end = join(directory, "end.js"), binary = join(directory, "fixture");
    const html = join(directory, "fixture.html");
    await writeFile(html, fixtureHTML);
    await writeFile(end, common.replaceAll("ROOT_REGISTRY_FACTORY", factory).replaceAll("AUDIO_PREFERENCE", "true"));
    await execute("/usr/bin/swiftc", ["-module-cache-path", join(directory, "cache"),
      join(root, "tests/fixtures/ios-visual-mutation-scope.swift"), "-o", binary], { timeout: 60_000 });
    for (const policy of ["conceal", "reveal-unclassified"]) {
      const bootstrap = literals[2]
        .replaceAll("DOCUMENT_UNCLASSIFIED_MEDIA_CSS", policy === "conceal" ? literals[0] : "")
        .replaceAll("SHADOW_UNCLASSIFIED_MEDIA_CSS", policy === "conceal" ? literals[1] : "")
        .replaceAll("UNCLASSIFIED_MEDIA_POLICY", policy).replaceAll("ROOT_REGISTRY_FACTORY", factory);
      await writeFile(start, bootstrap);
      const result = await execute(binary, [start, end, html], { timeout: 20_000 });
      const report = JSON.parse(result.stdout);
      assert.equal(report.globalInvalidations, 0);
      assert.equal(report.bottomWrites, 2, "only changed viewport bounds should update the owned strip");
      for (const key of ["homeScrollStable", "watchLoadRetained", "scrollStable", "anchorStable", "commentNodesRetained", "closedAllowanceRetained", "safetyStyleRetained", "viewportPositionChanged", "crossSelectorGated", "repliesLoaded"]) assert.equal(report[key], true, key);
      console.log(`${policy}: ${result.stdout.trim()}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
