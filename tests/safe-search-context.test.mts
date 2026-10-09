import assert from "node:assert/strict";
import { hasSafeSearchContributor, isSafeSearchLimitedNotice, safeSearchSubject, matchesSafeSearchSubject, sharedFileDestination, isExplicitLinkCollection } from "../src/safeSearchContext.js";

for (const text of ["Explicit results filtered with SafeSearch. Learn more", "Some results have been limited by SafeSearch", "Results have been removed by SafeSearch", "SafeSearch has filtered explicit results"]) {
  assert.equal(isSafeSearchLimitedNotice(text), true, text);
}
for (const text of ["SafeSearch on", "SafeSearch filtering is on", "SafeSearch blurring is on", "SafeSearch is locked", "SafeSearch filters explicit results", "Results limited by copyright", "Some results have been limited by SafeSearch" + " ".repeat(10) + "a".repeat(600)]) {
  assert.equal(isSafeSearchLimitedNotice(text), false, text);
}
for (const text of ["Jane Example photos", "Jane Example LINKS", "Jane Example videos", "Jane Example mature", "Jane Example uncensored", "Jane Example spicy", "Jane Example mega.nz", "Jane Example ａｌｂｕｍｓ", "Jane Example gofile", "Jane Example free downloads"]) {
  assert.equal(hasSafeSearchContributor(text), true, text);
  assert.equal(safeSearchSubject(text), "jane example", text);
}
for (const text of ["sex", "sexual", "nude", "nudity", "fetish", "leaks", "cream pie", "mature", "uncensored", "steamy", "spicy", "adult", "adult education", "nude art", "uncensored interview", "Jane Example interview photos", "museum art images", "medical anatomy videos", "software download links", "cooking videos", "spicy chicken videos", "historical photos"]) {
  assert.equal(hasSafeSearchContributor(text), true, "a verified popup can strengthen any existing ambiguous marker: " + text);
}
for (const text of ["Jane Example", "gardening", "Middlesex", "sextant", "nudging", "sexuality", "photosynthesis", "adulting", "spicylab", "leakingly"]) {
  assert.equal(hasSafeSearchContributor(text), false, text);
}
assert.equal(safeSearchSubject("site:justpaste.it Jane Example photos"), "jane example");
assert.equal(safeSearchSubject("links photos downloads"), "");
assert.equal(safeSearchSubject("nude art"), "", "ordinary context is not carried into future unflagged searches");
assert.equal(matchesSafeSearchSubject("Jane Example - Links | Scribd", "jane example"), true);
assert.equal(matchesSafeSearchSubject("Mary Example photos", "jane example"), false);
assert.equal(matchesSafeSearchSubject("Jane Examples links", "jane example"), false);
const cloud = ["https://mega.nz/folder/opaque#key", "https://gofile.io/d/opaque"];
assert.equal(isExplicitLinkCollection(cloud, false), false, "cloud hosts and density alone do not block");
assert.equal(isExplicitLinkCollection(cloud, true), true);
assert.equal(isExplicitLinkCollection([cloud[0], cloud[0]], true), false, "duplicate URLs are not a collection");
assert.equal(isExplicitLinkCollection([...cloud, "https://www.erome.com/a/opaque"], false), true);
assert.equal(isExplicitLinkCollection([...cloud, "https://erome.com.example.org/a/opaque"], false), false);
assert.equal(isExplicitLinkCollection(["https://erome.com/a/opaque"], false), false, "one unrelated citation is not a collection");
for (const url of ["https://mega.nz/", "https://gofile.io/", "https://mega.nz.example.org/folder/opaque", "javascript://mega.nz/folder/opaque", "https://news.example/?next=https://gofile.io/d/opaque"]) {
  assert.equal(sharedFileDestination(url), null, url);
}
console.log("SafeSearch notice, topic isolation, benign context and link-collection tests passed.");
