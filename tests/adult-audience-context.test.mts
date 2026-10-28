import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { containsContextualExplicitMedia } from "../src/explicitMediaContext.js";

const allowed = [
  "I’m Merrily Mellick. I work with adults and young adults navigating change, loss, or a decision point.",
  "Coaching for adults and young adults.",
  "Support for young adults and older adults.",
  "Adult and adult services.",
  "ADULTS AND YOUNG ADULTS",
  "Ａｄｕｌｔｓ and young adults",
  "Adult education for adults",
  "Merrily Mellick"
];
const blocked = [
  "adult videos", "videos for adults", "adult photos", "spicy adult",
  "adult uncensored", "adult nude photos", "pornography",
  "Coaching for adults and young adults. NSFW compilation",
  "adults and young adults nude videos"
];

for (const [expected, phrases] of [[false, allowed], [true, blocked]] as const) {
  for (const phrase of phrases) assert.equal(containsContextualExplicitMedia(phrase), expected, phrase);
}

const source = await readFile(new URL("../extension/media-child-lock.js", import.meta.url), "utf8");
const start = source.indexOf("// BEGIN GENERATED CONTEXTUAL PLATFORMS");
const end = source.indexOf("  const isX =");
assert.ok(start >= 0 && end > start);
for (const hostname of ["perfbrand.com", "coaching.example", "reddit.com"]) {
  const predicate = runInNewContext(`${source.slice(start, end)}; explicitTitle`, {
    location: { hostname }
  }) as (value: string) => boolean;
  for (const [expected, phrases] of [[false, allowed], [true, blocked]] as const) {
    for (const phrase of phrases) assert.equal(predicate(phrase), expected, `${hostname}: ${phrase}`);
  }
}
console.log("Adult-audience context regression checks passed.");
