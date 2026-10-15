import assert from "node:assert/strict";
import { domainToASCII } from "node:url";
import { matchSemanticExplicitUrl } from "../src/explicitUrlContext.js";
import { defaultState } from "../src/defaults.js";
import { shouldBlockUrl } from "../src/policy.js";

const profile = defaultState().profiles.find(profile => profile.id === "normal")!;
const blocked = [
  "https://xxx.example/", "https://xxx-videos.example/", "https://adultcomics.example/",
  "https://free-porn.example/", "https://p-o-r-n-tube.example/", "https://nsfw.reader.example/",
  "https://reader.example/hentai/chapter/1", "https://reader.example/en/genres/adult-webtoon",
  "https://reader.example/mature-manga/", "https://reader.example/genre/xxx",
  "https://reader.example/en/adult/comics", "https://reader.example/catalog/18pluscomics",
  "https://reader.example/category/%68%65%6e%74%61%69",
  "https://reader.example/category/%2570%256f%2572%256e",
  "https://reader.example////genre///xxx-videos/", "https://site.xxx/",
  `https://${domainToASCII("hеntai")}.example/`, // Cyrillic e in an IDN.
  "https://ｈｅｎｔａｉ.example/", "https://reader.example/en/genre/n%75de-photos",
  "https://reader.example/category/%70%6f%72%6e%zz", "https://porncomics.example/",
  "https://hentaimanga.example/", "https://reader.example/xxx/videos", "https://reader.example/nude/photos",
  "https://reader.example/lewd/comics", "https://adult.comics.reader.example/",
  "https://reader.example/genre/18+", "https://adultcomics-medical.example/",
  "https://reader.example/xxx_videos_updated_2026_archive", "https://reader.example/porn_videos_daily_updates_2026",
  "https://reader.example/adult_comics_catalog_updates_2026", "https://p0rn-mirror.example/",
  "https://reader.example/r34/comics", "https://reader.example/genre/r34",
  `https://${domainToASCII("HЕNTAI")}.example/`, "https://reader.example/uncensored-interview-nude-photos"
];
for (const url of blocked) {
  assert.ok(matchSemanticExplicitUrl(url), `semantic content in ${url}`);
  assert.equal(shouldBlockUrl(profile, url), true, `main policy must consume ${url}`);
}

const allowed = [
  "https://axxxb.example/", "https://spacex.example/", "https://middlesex.example/",
  "https://sussex.example/", "https://essex.example/", "https://analysis.example/",
  "https://news.example/articles/xxx-report", "https://news.example/history/super-bowl-xxx",
  "https://docs.example/chapter/XXX", "https://health.example/sex-education/videos",
  "https://reader.example/?token=abcXXXxyz&q=random+string", "https://reader.example/#abcXXX9837aEfj3293part",
  "https://docs.example/api/v1/resources/abcXXX9837aEfj3293part/file",
  "https://docs.example/a/b/c/d/abcXXX9837aEfj3293part", "https://docs.example/9cab4498-91a2-4742-9338-deefa81f713a",
  "https://example.test/document?id=abCxxx123456789abcdefghijklm",
  "https://abcxxx91234567890abcdefghijklmnop.example/",
  "https://xxx:password@ordinary.example/", "https://ordinary.example:443/",
  "file:///tmp/xxx-videos.txt", "data:text/plain,xxx-videos", "https://theblank.net.example.org/",
  "https://cars.example/cars/nissan/skyline-r34", "https://gtr-r34.example/",
  "https://adult.education.video.example/", "https://cars.example/cars/nissan/r34/photos",
  "https://www.nissan.example/r34/images", "https://nissan-r34-videos.example/",
  "https://ordinary.example/search/nude%20art%20figure%20drawing", "https://ordinary.example/search/nude%20makeup%20photos",
  "https://ordinary.example/search/uncensored%20interview%20videos"
];
export { blocked as semanticExplicitUrlBlocked, allowed as semanticExplicitUrlAllowed };
for (const url of allowed) assert.equal(matchSemanticExplicitUrl(url), null, `ordinary/opaque URL ${url}`);
for (const url of allowed.filter(url => /^https?:/u.test(url) && !url.includes("q=") && !url.includes("sex-education"))) {
  assert.equal(shouldBlockUrl(profile, url), false, `opaque X sequences remain allowed in main policy: ${url}`);
}
assert.equal(matchSemanticExplicitUrl("not a URL"), null);
assert.equal(matchSemanticExplicitUrl("https://reader.example/#xxx-videos"), null,
  "this new helper ignores fragments; existing semantic search-fragment checks remain in place");
assert.equal(matchSemanticExplicitUrl("https://docs.example/a/b/c/d/xxx-videos"), null,
  "this new helper scans early routes; existing explicit-media checks retain their scope");
assert.equal(shouldBlockUrl({ ...profile, blockedUrlPatterns: [] }, blocked[0]), false,
  "the helper belongs to profiles with explicit content protection");
assert.equal(shouldBlockUrl({ ...profile, blockedUrlPatterns: ["token=xxx"] }, "https://ordinary.example/?token=xxx"), true,
  "an explicit custom rule still inspects its selected query component");
console.log(`${blocked.length} semantic URL blocks and ${allowed.length} benign/opaque controls passed.`);
