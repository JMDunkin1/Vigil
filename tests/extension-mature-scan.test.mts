import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
function functionSource(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
class Element {
  constructor(readonly parentElement: Element | null = null) {}
}
const scanned: Element[] = [];
const context = createContext({
  HTMLElement: Element,
  scanMatureContent(_platform: string, scope: Element) { scanned.push(scope); }
});
runInContext(functionSource("scanMatureContentMutations", "scanMatureContent"), context);
const root = new Element();
const children = Array.from({ length: 10 }, () => new Element(root));
context.records = [
  { target: root, addedNodes: children },
  ...children.map((target) => ({ target, addedNodes: [new Element(target)] }))
];
runInContext('scanMatureContentMutations("reddit", records)', context);
assert.deepEqual(scanned, [root], "a parent scan must cover nested mutation records exactly once");
scanned.length = 0;
const disjoint = Array.from({ length: 100 }, () => new Element());
context.records = disjoint.map((target) => ({ target, addedNodes: [] }));
runInContext('scanMatureContentMutations("reddit", records)', context);
assert.deepEqual(scanned, disjoint, "large batches must scan all changed roots without falling back to the entire feed");

const markers = Array.from({ length: 950 }, (_, index) => ({ textContent: `marker-${index}` }));
const marked: unknown[] = [];
const blocked: unknown[] = [];
const fullScan = createContext({
  document: {},
  matureContentScanInProgress: false,
  matureQuerySelectorAll(_scope: unknown, selector: string) {
    if (selector === "shreddit-post[nsfw]") return markers;
    if (selector.startsWith(".thing .nsfw-stamp")) return markers;
    if (selector.startsWith("a[href]")) return markers;
    return [];
  },
  normalizeMatureText: (text: string) => text,
  matureMarkerText: () => true,
  matureControlIsReveal: () => true,
  markMatureContent: (marker: unknown) => marked.push(marker),
  blockMatureControl: (control: unknown) => blocked.push(control)
});
runInContext(functionSource("scanMatureContent", "normalizeMatureText"), fullScan);
runInContext('scanMatureContent("reddit")', fullScan);
assert.equal(marked.length, 1_900, "structured and text markers beyond the old 400/800 limits must remain protected");
assert.equal(blocked.length, 950, "reveal controls late in a long feed must not escape enforcement");
assert.equal(fullScan.matureContentScanInProgress, false);
console.log("Extension mature-content scan tests passed");
