import assert from "node:assert/strict";
import { containsContextualExplicitMedia, containsExplicitSearchAliases, containsExplicitSearchKeyword } from "../src/explicitMediaContext.js";
import { matchSemanticExplicitUrl } from "../src/explicitUrlContext.js";

const ordinary = [
  "Sporn dog harness", "Caporn family history", "webcam480 driver", "actioncam4k", "SKU-RULE34567",
  "AbcHentai90XZ", "dbNSFWfile88123", "account_onlyfanshash_04", "Project118plus build",
  "Nissan R34 photos", "R34 Skyline tuning", "GT-R R34 videos", "Rule 34 algorithm",
  "Chapter XXX images", "XXX chromosome research", "Super Bowl XXX videos", "XXX Vin Diesel movie", "XXX Return of Xander Cage",
  "sex education", "sexual health", "nude lipstick photos", "nude art figure drawing", "naked mole rat photos",
  "Sex Pistols gallery", "adult education video", "mature skin photos", "uncensored interview videos",
  "nude watercolor palette photos", "nude art sculpture photos", "mature trees photos", "erotic imagery art history",
  "nude art drawing videos", "nudity anatomy video", "nude art videos",
  "pornographic content moderation research", "pornography blocker", "pornography addiction recovery",
  "pornography law history", "NSFW classifier", "NSFW API reference", "18+ voting eligibility",
  "18+ travel insurance", "18+5", "top 18 manga for beginners", "read 18 comics this year", "chapter 18 manga", "manhwa", "manhua", "manga", "webtoon", "mawha"
];
for (const phrase of ordinary) {
  assert.equal(containsExplicitSearchKeyword(phrase), false, `bounded keyword: ${phrase}`);
  assert.equal(containsExplicitSearchAliases(phrase), false, `bounded alias: ${phrase}`);
  assert.equal(containsContextualExplicitMedia(phrase), false, `local media evidence: ${phrase}`);
}
const explicit = [
  "porn", "p.o.r.n videos", "ｐｏｒｎ", "PОRN videos", "HЕNTAI manga", "ОNLYFANS", "pornvideos", "hentai manga", "nsfw photos", "cam4", "onlyfans",
  "honeytoon", "toongod", "pornographic content moderation porn videos", "pornography law hentai comics",
  "Nissan R34 porn videos", "Chapter XXX nsfw photos", "XXX Vin Diesel porn videos", "NSFW classifier hentai", "nude lipstick porn photos"
];
for (const phrase of explicit) assert.equal(containsExplicitSearchKeyword(phrase), true, `independent explicit evidence: ${phrase}`);
for (const phrase of ["nude photos medical", "naked photos research", "xxx videos education", "erotic videos research", "nude medical photos", "nude videos lipstick", "naked photos eye", "NАKED GIRLS"]) {
  assert.equal(containsContextualExplicitMedia(phrase), true, `a general qualifier cannot excuse clear explicit media: ${phrase}`);
}
assert.equal(containsContextualExplicitMedia("nude art videos naked girls photos"), true, "an art phrase does not consume a separate explicit request");
for (const route of [
  "/sex-pistols-gallery", "/naked-mole-rat-photos", "/chapter/XXX/images", "/book/XXX-videos",
  "/health/pornographic-content-moderation-research", "/tools/pornography-blocker", "/nsfw-api-reference",
  "/pornography/law/history", "/nsfw/api/reference", "/nude/art/sculpture/photos"
]) assert.equal(matchSemanticExplicitUrl("https://ordinary.example" + route), null, `ordinary route: ${route}`);
for (const route of [
  "/porn/videos", "/naked-girls-photos", "/adult-comics-medical", "/nude-medical-photos",
  "/uncensored-interview-nude-photos", "/chapter/XXX-porn-videos", "/pornography-blocker-hentai", "/nude-videos-lipstick", "/naked-photos-eye", "/onlyfans-leaks", "/products/sex-dolls", "/category/色情视频", "/pornography/law/naked/photos", "/nsfw/api/reference/hentai", "/порно/videos", "/category/порнография", "/pornography/law/18%2B/videos"
]) assert.ok(matchSemanticExplicitUrl("https://ordinary.example" + route), `an unrelated ordinary word cannot excuse ${route}`);
assert.ok(matchSemanticExplicitUrl("https://adult.comics.research.example/"), "an unrelated DNS label cannot excuse an explicit namespace");
for (const url of ["https://rule34567.example/", "https://ordinary.example/rule34567", "https://ordinary.example/catalog/18comics"]) {
  assert.equal(matchSemanticExplicitUrl(url), null, "another numbered rule is not Rule 34: " + url);
}
console.log(`${ordinary.length} ordinary word/phrase controls and ${explicit.length} explicit controls passed, with route and mixture checks.`);
