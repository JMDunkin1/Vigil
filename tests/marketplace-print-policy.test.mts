import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { defaultState } from "../src/defaults.js";
import { shouldBlockUrl } from "../src/policy.js";
import { matchSemanticExplicitUrl } from "../src/explicitUrlContext.js";
import { REVIEWED_EXPLICIT_PRINT_PRODUCT_IDS, isReviewedExplicitPrintProductUrl } from "../src/explicitMediaContext.js";
import { printBlockedTitles, printAllowedTitles } from "./fixtures/explicit-print-media.mjs";

const profile = defaultState().profiles.find(profile => profile.id === "normal")!;
const browser = createContext({ URL, URLSearchParams,
  location: { href: "https://www.etsy.com/", replace() {} }, addEventListener() {},
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } }
});
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), browser);
for (const [titles, blocked] of [[printBlockedTitles, true], [printAllowedTitles, false]] as const) {
  for (const title of titles) {
    for (const url of [
      `https://www.amazon.com/s?k=${encodeURIComponent(title)}`,
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}`,
      `https://www.etsy.com/search?q=${encodeURIComponent(title)}`
    ]) {
      assert.equal(shouldBlockUrl(profile, url), blocked, `server: ${url}`);
      assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, browser)), blocked, `browser: ${url}`);
    }
  }
}
for (const path of [
  "listing/4359845987/pink-thong-lingerie-photo-print-mature",
  "listing/4582264921/lingerie-model-woman-8x10-photo",
  "itm/235381234567/posing-in-blue-lingerie-8x10-photo-print",
  "Sexy-Big-Butt-Poster-Gifts-Canvas/dp/B09MHWPNHY",
  "product/prints/mature", "product/lingerie/prints", "item/boudoir-portrait",
  "product/provocative-wall-art", "product/18%2B-stickers"
]) {
  const url = `https://www.etsy.com/${path}`;
  assert.ok(matchSemanticExplicitUrl(url), url);
  assert.equal(shouldBlockUrl(profile, url), true, url);
  assert.ok(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, browser), url);
}
for (const path of [
  "listing/4339243262/custom-photo-poster-family-wedding-art",
  "listing/4389788901/henry-danger-movie-poster", "product/mature-trees-watercolor-print",
  "product/lingerie-sewing-pattern-print", "product/floral-print-bikini"
]) assert.equal(shouldBlockUrl(profile, `https://www.etsy.com/${path}`), false, path);
for (const url of [
  "https://www.etsy.com/listing/123/landscape?tracking=lingerie-print",
  "https://www.ebay.com/itm/123#opaque-mature-poster-identifier"
]) assert.equal(shouldBlockUrl(profile, url), false, "unrelated metadata is not a product label");
for (const id of REVIEWED_EXPLICIT_PRINT_PRODUCT_IDS) {
  for (const route of [`listing/${id}/neutral-title`, `r/similar/${id}/`, `%6cisting/${id}/neutral`]) {
    const url = `https://www.etsy.com/${route}`;
    assert.equal(isReviewedExplicitPrintProductUrl(url), true, url);
    assert.equal(shouldBlockUrl(profile, url), true, url);
    assert.ok(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, browser), url);
  }
}
for (const url of [
  "https://www.etsy.com/listing/999999999/neutral-title",
  "https://www.etsy.com/listing/45960794110/neutral-title",
  "https://www.etsy.com.example.org/listing/4596079411/neutral-title",
  "https://www.ebay.com/itm/4596079411",
  "https://www.etsy.com/?tracking=4596079411",
  "https://www.etsy.com/listing/4563889586/intense-intimate-moment-between-men"
]) {
  assert.equal(isReviewedExplicitPrintProductUrl(url), false, url);
  assert.equal(shouldBlockUrl(profile, url), false, url);
}
console.log("Audited marketplace print titles, searches, product slugs and ordinary controls passed.");
