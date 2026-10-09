import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { containsMultilingualExplicitText } from "../src/explicitMediaContext.js";
import { defaultState } from "../src/defaults.js";
import { baselinePolicy, matchBlockedUrlPattern } from "../src/policy.js";

const blocked = [
  "فيديو إباحي وجنسي للممثلة Jane Example",
  "إباحية", "اباحي", "والإباحية", "إِبَاحِيّ", "إبـاحي", "إبا\u200bحي",
  "فيديو جنسي", "فيديوهات جنسية", "أفلام جنسية", "الفيديو الجنسي",
  "最新色情视频", "色情視頻合集", "色情電影", "ポルノ動画", "ﾎﾟﾙﾉ",
  "포르노를", "음란물", "порно", "порнофильмы", "порнография",
  "pornographie", "pornographiques", "pornografía", "pornograficas", "pornográfico",
  "pornografia", "pornografie", "pornografischen"
];
const allowed = [
  "Jane Example", "أبيلا دينجر", "Jane Example أخبار الممثلة", "فيديو تعليمي",
  "الصحة الجنسية", "sexual health", "性教育", "成人教育", "調色情報",
  "ポルトガル", "영화 교육", "Иван Порнов", "порнозавр", "biography"
];
const profile = baselinePolicy(defaultState())!.profile;
for (const [expected, labels] of [[true, blocked], [false, allowed]] as const) {
  for (const label of labels) {
    assert.equal(containsMultilingualExplicitText(label), expected, label);
    const url = `https://www.google.com/search?q=${encodeURIComponent(label)}&safe=active`;
    assert.equal(Boolean(matchBlockedUrlPattern(profile, url)), expected, url);
  }
}
assert.ok(matchBlockedUrlPattern(profile, `https://example.org/watch/${encodeURIComponent("إِبَاحِيّ")}`));
assert.equal(matchBlockedUrlPattern(profile, "https://script.google.com/macros/s/opaque-id/exec"), null);

const desktop = await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8");
class ElementStub {
  tagName = "H3";
  textContent = "";
  anchor: ElementStub | null = null;
  href = "https://script.google.com/macros/s/opaque-id/exec";
  getAttribute(): null { return null; }
  closest(selector: string): ElementStub | null { return selector === "a[href]" ? this.anchor : null; }
}
function page(title: string) {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const mutations: Array<(records: unknown[]) => void> = [];
  const document = { title, documentElement: {}, querySelectorAll: () => [], querySelector: () => null };
  runInNewContext(desktop, {
    URL, URLSearchParams, document, Element: ElementStub,
    location: { href: "https://www.google.com/search?q=Jane+Example&safe=active", hostname: "www.google.com", replace: (url: string) => redirects.push(url), assign: (url: string) => redirects.push(url) },
    chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } },
    MutationObserver: class {
      constructor(callback: (records: unknown[]) => void) { mutations.push(callback); }
      observe() {}
    },
    addEventListener: (event: string, callback: (event: unknown) => void) => listeners.set(event, callback),
    setInterval() {},
    setTimeout(callback: () => void) { callback(); return 1; },
    clearTimeout() {}
  });
  return { redirects, listeners, document, mutate: () => mutations.forEach(callback => callback([])) };
}
const nameSearch = page("Jane Example - Google Search");
assert.deepEqual(nameSearch.redirects, [], "name-only search stays available");
for (const label of [blocked[0], "Spicy clips", "Cream pie videos", "Nude videos", "Uncensored nude"]) {
  const search = page("Jane Example - Google Search");
  const anchor = new ElementStub(); anchor.tagName = "A"; anchor.textContent = label;
  const heading = new ElementStub(); heading.anchor = anchor;
  let cancelled = false;
  search.listeners.get("click")!({
    type: "click", target: heading, composedPath: () => [heading, anchor],
    preventDefault: () => { cancelled = true; }, stopImmediatePropagation() {}
  });
  assert.equal(cancelled, true, `an opaque destination is blocked by its result label before navigation: ${label}`);
  assert.deepEqual(search.redirects, ["chrome-extension://vigil/blocked.html"]);
}
for (const label of ["Spicy chicken clips", "Banana cream pie video", "Nude art drawing videos", "Mature films"]) {
  assert.deepEqual(page(label).redirects, [], label);
}
assert.deepEqual(page(blocked[0]).redirects, ["chrome-extension://vigil/blocked.html"], "direct page title is inspected");
assert.deepEqual(page("Nude videos").redirects, ["chrome-extension://vigil/blocked.html"], "contextual page title is inspected");
const dynamic = page("Ordinary page");
dynamic.document.title = "最新色情视频";
dynamic.mutate();
assert.deepEqual(dynamic.redirects, ["chrome-extension://vigil/blocked.html"], "a dynamically changed title is inspected");

const media = await readFile(new URL("../extension/media-child-lock.js", import.meta.url), "utf8");
const predicate = `${media.slice(0, media.indexOf("  const isX ="))}\nreturn explicitTitle; })();`;
const explicitTitle = runInNewContext(predicate, { location: { protocol: "https:", hostname: "www.google.com" } }) as (value: string) => boolean;
for (const label of blocked) assert.equal(explicitTitle(label), true, label);
for (const label of allowed) assert.equal(explicitTitle(label), false, label);
console.log("Multilingual queries, screenshot labels, direct/dynamic titles, opaque Apps Script links and ordinary names passed.");
