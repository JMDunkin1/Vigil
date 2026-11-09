import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { containsContextualExplicitMedia, containsMultilingualExplicitText, normalizeExplicitVocabulary } from "../src/explicitMediaContext.js";

// The common ASCII path must not pay for per-letter Unicode decomposition.
// Unicode normalization, combining accents and mixed-script signals still apply.
for (const [input, expected] of [
  ["Astronomy tutorial 12", "Astronomy tutorial 12"],
  ["ＮＡＫＥＤ ＧＩＲＬＳ", "naked GIRLS"],
  ["po\u0301rn videos", "porn videos"],
  ["pоrn videos", "porn videos"],
  ["na\u200bked girls", "naked girls"],
  ["naked\ufe0f girls", "naked girls"],
  ["ポルノ動画", "ポルノ動画"],
  ["포르노를", "포르노를"]
]) assert.equal(normalizeExplicitVocabulary(input), expected, input);
for (const label of ["ＮＡＫＥＤ ＧＩＲＬＳ", "po\u0301rn videos", "pоrn videos", "na\u200bked girls"]) {
  assert.equal(containsContextualExplicitMedia(label), true, label);
}
for (const label of ["ポルノ動画", "포르노를", "إِبَاحِيّ", "pornografía"]) {
  assert.equal(containsMultilingualExplicitText(label), true, label);
}

// Count work rather than asserting machine-dependent timing. This executes the
// compiled shared helper that the browser assets also embed during the build.
const source = (await readFile(new URL("../src/explicitMediaContext.js", import.meta.url), "utf8"))
  .replace(/^export /gmu, "")
  .replace("function normalizeAutomaticExplicitText(value) {", "function normalizeAutomaticExplicitText(value) { metrics.automatic++;");
const metrics = { automatic: 0, decompositions: 0 };
const classify = runInNewContext(`
  const originalNormalize = String.prototype.normalize;
  String.prototype.normalize = function(form) {
    if (form === 'NFD') metrics.decompositions++;
    return originalNormalize.call(this, form);
  };
  ${source}
  containsContextualExplicitMedia;
`, { metrics }) as (value: string) => boolean;
assert.equal(classify("Astronomy tutorial Channel 12 episode 21"), false);
assert.equal(metrics.automatic, 1, "one decision normalizes the ordinary text once");
assert.equal(metrics.decompositions, 0, "ASCII needs no per-letter diacritic folding");
assert.equal(classify("po\u0301rn videos"), true);
assert.ok(metrics.decompositions > 0, "accented input retains Unicode decomposition");
console.log("Explicit media normalization work and Unicode enforcement checks passed.");
