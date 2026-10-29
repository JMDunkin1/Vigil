import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { defaultState } from "../src/defaults.js";
import { shouldBlockSite, shouldBlockUrl } from "../src/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { browserPermanentBlockedDomains } from "../src/browserStaticProtection.js";
import { iosPolicyTargets } from "../src/iosProfiles.js";
import { generatedNativeExplicitMedia } from "../scripts/generate-native-explicit-media.mjs";
import { now, usageFixture } from "./test-helpers.mjs";

const chartDomains = ["toonily.me", "omegascans.org", "manhwabuddy.com", "mangadna.com", "manghaha.com", "toonily.com", "mangaforfree.com", "manhwaclub.net"];
const reportedDomains = ["qtoon.com", "qtoon.net", "qtoon.org", "qtoon.ai", "comicle.com",
  "comicle-manga-manhwa-comics.soft112.com", "line-webtoon.soft112.com", "manta-unlimited-trending-webtoons.soft112.com"];
const state = defaultState();
state.settings.adultBlocklistEnabled = false;
state.deviceControls.ios.enabled = true;
const browser = createContext({
  URL, URLSearchParams, location: { href: "https://example.org/", replace() {} },
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } }, addEventListener() {}
});
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), browser);
const guard = (url: string) => Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, browser));
const search = (query: string) => `https://catalog.example/search?q=${encodeURIComponent(query)}`;
const blockedQueries = [
  ...chartDomains.map(domain => `${domain.split(".")[0]} alternatives`),
  "qtoon", "Q Toon alternatives", "q—toon mirrors", "ＱＴＯＯＮ", "q\u200btoon", "comicle alternatives",
  "mangabuddy alternatives", "mangameow", "mangaball", "kuramanga", "comizy", "nyrascans", "mangavyvy", "hiperdex",
  "tappytoon", "toomics", "lezhin", "lezhinus", "lezhinx", "daycomics", "toptoon", "coolmic", "mangaplaza", "ebookrenta", "webcomicsapp", "lalatoon",
  "Omega Scans alternatives", "omega—scans mirrors", "Manga DNA competitors", "manga for free alternatives",
  "manhwa buddy", "manhwa club", "ｔｏｏｎｉｌｙ alternatives", "toon\u200bily", "pornhwa",
  "smut manga", "comics smut", "mature doujinshi", "erotica webtoons", "explicit manga", "manga r-19", "19+ webtoon"
];
const allowedQueries = ["corn smut fungus", "manga drawing tutorials", "comic book history", "uncensored interview", "mature gardening", "manga chapter 19", "nottoonily", "omegascanscope", "mangadnasequence",
  "notqtoon", "qtoonscope", "comiclearning", "manta ray", "toptoonscope", "comic drawing software"];
const blockedUrls = [
  ...blockedQueries.flatMap(query => [search(query), search(encodeURIComponent(query))]),
  ...[...chartDomains, ...reportedDomains].flatMap(domain => [
    `https://${domain}/`, `http://reader.${domain}/ordinary-title`
  ]),
  ...[...chartDomains, "qtoon.com", "qtoon.net", "qtoon.org", "qtoon.ai", "comicle.com"].map(domain =>
    `https://www.semrush.com/website/${domain}/competitors/`),
  "https://reader.toonily.example/", "https://example.org/manga-dna/alternatives",
  "https://comicle-manga-manhwa-comics.soft112.com/comicle-manga-manhwa-comics-alternatives.html",
  "https://qtoon-manga-manhua-comics.soft112.com/", "https://example.org/q-toon/alternatives",
  "https://example.org/reviews/qtoon.ai/", "https://example.org/comicle-manga-alternatives/"
];
const allowedUrls = [
  ...allowedQueries.map(search),
  "https://example.org/?nonce=toonily&return=https%3A%2F%2Fmangadna.com",
  "https://example.org/account?token=omegascans",
  "https://example.org/assets/logo.png#toonily",
  "https://example.org/?nonce=qtoon&return=https%3A%2F%2Fqtoon.org",
  "https://example.org/account?token=comicle", "https://example.org/assets/logo.png#qtoon",
  "https://example.org/reference/comiclearning", "https://text-editor.soft112.com/"
];
for (const domain of [...chartDomains, ...reportedDomains]) {
  assert.ok(browserPermanentBlockedDomains().includes(domain), `offline static deny: ${domain}`);
  for (const profile of state.profiles) assert.ok(shouldBlockSite(profile, `reader.${domain}`), `${profile.id}: ${domain}`);
  const targets = iosPolicyTargets(state, now);
  const delivered = [...targets.deniedUrls, ...targets.supplementalDeniedUrls];
  for (const scheme of ["http", "https"]) assert.ok(delivered.includes(`${scheme}://${domain}/`), `supervised deny: ${scheme} ${domain}`);
}
for (const [urls, expected] of [[blockedUrls, true], [allowedUrls, false]] as const) {
  for (const url of urls) {
    const normal = state.profiles.find(profile => profile.id === "normal")!;
    assert.equal(shouldBlockUrl(normal, url) || shouldBlockSite(normal, new URL(url).hostname), expected, `policy: ${url}`);
    assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event: "navigation" }, now).blocked, expected, `extension: ${url}`);
    assert.equal(guard(url), expected, `bundled guard without SafeSearch evidence: ${url}`);
  }
}
if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-comic-discovery-"));
  try {
    const cases = [...blockedQueries.map(query => [query, true] as const), ...allowedQueries.map(query => [query, false] as const)];
    const checks = cases.map(([query, expected]) => {
      const encoded = Buffer.from(query).toString("base64");
      return `precondition(BroadenedExplicitMedia.containsSearch(String(data: Data(base64Encoded: "${encoded}")!, encoding: .utf8)!) == ${expected}, "${encoded}")`;
    });
    const path = join(directory, "main.swift");
    await writeFile(path, `import Foundation\n${generatedNativeExplicitMedia()}\n${checks.join("\n")}\n`);
    const executable = join(directory, "native-comics");
    execFileSync("/usr/bin/xcrun", ["swiftc", path, "-o", executable], { timeout: 120_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log("Comic discovery blocks pass across native, browser, server and supervised policy without SafeSearch evidence.");
