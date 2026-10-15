import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";

const sources = [await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), await generatedIosSafariGuard()];
class Anchor {
  readonly tagName = "A";
  readonly textContent = "Ordinary reference";
  constructor(readonly href: string) {}
  getAttribute(): null { return null; }
  closest(selector: string): Anchor | null { return selector === "a[href]" ? this : null; }
}
function page(source: string, url: string, invalid = false) {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let tick = () => {};
  const location = { href: url, replace: (value: string) => redirects.push(value), assign: (value: string) => redirects.push(value) };
  runInNewContext(source, { URL, URLSearchParams, location, Element: Anchor, HTMLAnchorElement: Anchor,
    document: { title: "Ordinary catalog", readyState: "loading", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    chrome: { runtime: { getURL: () => invalid ? "" : "extension-test://blocked.html" } },
    browser: { runtime: { getURL: () => invalid ? "" : "extension-test://blocked.html" } },
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    setInterval: (callback: () => void) => { tick = callback; }
  });
  return { redirects, listeners, location, tick: () => tick() };
}
const denied = [
  "https://new-porn-mirror.example/", "https://hentai-reader.example/", "https://porn.catalog.example/",
  "https://catalog.example/porn/latest", "https://catalog.example/manga/hentai/", "https://catalog.example/adult/manhwa/",
  "https://catalog.example/%70%6f%72%6e/chapter/1", "https://catalog.example/%2570%256f%2572%256e/chapter/1",
  "https://catalog.example/category/mature-comics/", "https://catalog.example/xxx-videos/"
];
const ordinary = [
  "https://middlesex.example/", "https://analysis.example/", "https://sussex.example/", "https://theblank.net.example.org/",
  "https://catalog.example/watch/aqrXXX418bjk1178Vr567N46abc", "https://catalog.example/id/f41aXXX183bb8b6213382900acf",
  "https://catalog.example/chapter/XXX", "https://catalog.example/one/two/three/four/xxx",
  "https://catalog.example/?token=xxx&signature=porn&redirect=https%3A%2F%2Fporn.example%2F",
  "https://catalog.example/#opaque-porn-xxx-data", "https://health.example/sex-education", "https://catalog.example/adult-education-video",
  "https://catalog.example/uncensored-interview", "https://catalog.example/nude-lipstick-colors"
];
for (const source of sources) {
  assert.deepEqual(page(source, denied[0], true).redirects, ["about:blank"], "invalid runtime URL keeps direct semantic navigation closed");
  for (const url of denied) {
    assert.deepEqual(page(source, url).redirects, ["extension-test://blocked.html"], `direct route: ${url}`);
    const spa = page(source, "https://catalog.example/");
    spa.location.href = url; spa.tick();
    assert.ok(spa.redirects.length > 0 && spa.redirects.every(target => target === "extension-test://blocked.html"), `same-document route: ${url}`);
    for (const type of ["click", "auxclick", "contextmenu"]) {
      const link = page(source, "https://catalog.example/");
      let cancelled = false;
      link.listeners.get(type)!({ type, target: new Anchor(url), cancelable: true,
        preventDefault() { cancelled = true; }, stopImmediatePropagation() {} });
      assert.equal(cancelled, true, `${type}: ${url}`);
      assert.deepEqual(link.redirects, ["extension-test://blocked.html"]);
    }
  }
  for (const url of ordinary) {
    assert.deepEqual(page(source, url).redirects, [], `ordinary direct URL: ${url}`);
    const spa = page(source, "https://catalog.example/");
    spa.location.href = url; spa.tick();
    assert.deepEqual(spa.redirects, [], `ordinary same-document URL: ${url}`);
  }
}
console.log("Chrome/Safari semantic hostname and early-route enforcement passed; opaque IDs, deep paths, queries, fragments and ordinary names remain usable.");
