import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultState } from "../src/defaults.js";
import { browserPermanentBlockedDomains, browserPermanentDomainRules } from "../src/browserStaticProtection.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";
import { matchSemanticExplicitUrl } from "../src/explicitUrlContext.js";
import { now, usageFixture } from "./test-helpers.mjs";

const chromeSource = await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8");
const safariSource = await generatedIosSafariGuard();
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
for (const name of ["youtube-parity.js", "youtube-player-response.js", "media-child-lock.js", "reddit-child-lock.js", "youtube-bridge.js"]) {
  assert.equal(await readFile(new URL(`../extension/${name}`, import.meta.url), "utf8"),
    await readFile(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources", name), "utf8"),
    `${name}: Chrome must package the exact Safari guard`);
}
const responseScripts = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes("youtube-player-response.js"));
assert.equal(responseScripts.world, "MAIN");
assert.equal(responseScripts.run_at, "document_start");
assert.equal(responseScripts.all_frames, true);
const bridgeScripts = manifest.content_scripts.filter((entry: { js: string[] }) => entry.js.includes("youtube-bridge.js"));
assert.equal(bridgeScripts.length, 1, "the shared click handler must not run twice");
assert.deepEqual(bridgeScripts[0].matches, ["http://*/*", "https://*/*"]);
assert.equal(bridgeScripts[0].all_frames, true, "playback messaging must remain available in embedded players");
assert.equal(bridgeScripts[0].run_at, "document_start");
for (const world of ["ISOLATED", "MAIN"]) {
  const names = [...new Set<string>(manifest.content_scripts
    .filter((entry: { world?: string }) => (entry.world || "ISOLATED") === world)
    .flatMap((entry: { js: string[] }) => entry.js))];
  const sources = await Promise.all(names.map(name => readFile(new URL(`../extension/${name}`, import.meta.url), "utf8")));
  new Script(sources.join("\n"), { filename: `chrome-${world.toLowerCase()}-guards.js` });
}
const searchScripts = manifest.content_scripts.filter((entry: { js: string[] }) => entry.js.includes("google-safe-search.js"));
assert.equal(searchScripts.length, 1);
assert.equal(searchScripts[0].all_frames, true, "embedded searches require the same guard as the top-level page");
assert.equal(searchScripts[0].run_at, "document_start");
const searchRules = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8"));
for (const rule of searchRules) {
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"],
    `SafeSearch and every explicit-query partition must cover embedded searches before document scripts run: rule ${rule.id}`);
}
assert.equal(manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes("content.js")).all_frames, undefined,
  "activity accounting and whole-page pause overlays stay in the top frame");
const resource = manifest.declarative_net_request.rule_resources.find((entry: { id: string }) => entry.id === "vigil_permanent_domains");
assert.equal(resource.enabled, true);
const rules = JSON.parse(await readFile(new URL(`../extension/${resource.path}`, import.meta.url), "utf8"));
assert.deepEqual(rules, browserPermanentDomainRules(), "packaged permanent rules must come from the current policy");
assert.equal(rules[0].action.redirect?.extensionPath, "/blocked.html");
assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
assert.equal(rules[1].action.type, "block");
for (const type of ["sub_frame", "media", "xmlhttprequest", "websocket"] as const) assert.ok(rules[1].condition.resourceTypes?.includes(type));
assert.deepEqual(rules[0].condition.requestDomains, browserPermanentBlockedDomains());

class SearchInput {
  tagName = "INPUT";
  value = "";
  getAttribute(name: string): string | null { return name === "type" ? "search" : null; }
  closest(): null { return null; }
}

function page(source: string, url: string) {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let interval = () => {};
  const location = { href: url, replace: (target: string) => redirects.push(target), assign: (target: string) => redirects.push(target) };
  const runtime = { getURL: (path: string) => `extension-test://${path}` };
  runInNewContext(source, {
    URL, URLSearchParams, location, Element: SearchInput, chrome: { runtime }, browser: { runtime },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    setInterval: (callback: () => void) => { interval = callback; }
  });
  return { redirects, location, listeners, tick: () => interval() };
}

const blocked = [
  "honeytoon", "hooneytoons", "adult manhwa", "toongod", "adult manhua", "mature webtoons", "uncensored webtoon",
  "r_34", "p.o.r.n", "ｒ３４", "r\u200b34", "spicy clips", "cream pie videos", "adult vids", "naked girls"
];
const ordinary = ["manhwa", "manhua", "manga", "Middlesex gardening", "nudging", "SKU-R34567", "uncensored interview", "adult education video", "banana cream pie video", "X-Men film"];
const state = defaultState();
for (const source of [chromeSource, safariSource]) {
  for (const domain of browserPermanentBlockedDomains()) {
    for (const url of [`https://${domain}/`, `http://reader.${domain}/chapter`, `https://${domain}./`]) {
      assert.deepEqual(page(source, url).redirects, ["extension-test://blocked.html"], `offline permanent ban: ${url}`);
      assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event: "navigation" }, now).blocked, true, `native policy: ${url}`);
    }
    const lookalike = `https://${domain}.example.org/`;
    assert.deepEqual(page(source, lookalike).redirects, matchSemanticExplicitUrl(lookalike) ? ["extension-test://blocked.html"] : [],
      `domain boundaries remain distinct from meaningful explicit hostname words: ${domain}`);
  }
  for (const [queries, expected] of [[blocked, true], [ordinary, false]] as const) {
    for (const query of queries) {
      for (const url of [
        `https://catalog.example/search?q=${encodeURIComponent(query)}`,
        `https://catalog.example/#/search/${encodeURIComponent(query)}`,
        `https://catalog.example/?q=${encodeURIComponent(encodeURIComponent(query))}`
      ]) {
        assert.equal(page(source, url).redirects.includes("extension-test://blocked.html"), expected, url);
        assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event: "navigation" }, now).blocked, expected, `native search: ${url}`);
      }
      const dynamic = page(source, "https://catalog.example/");
      dynamic.location.href = `https://catalog.example/search?q=${encodeURIComponent(query)}`;
      dynamic.tick();
      assert.equal(dynamic.redirects.includes("extension-test://blocked.html"), expected, `SPA search: ${query}`);
      const search = page(source, "https://catalog.example/");
      const input = new SearchInput(); input.value = query;
      let cancelled = false;
      search.listeners.get("keydown")!({ target: input, type: "keydown", key: "Enter", cancelable: true,
        preventDefault() { cancelled = true; }, stopImmediatePropagation() {} });
      assert.equal(cancelled, expected, `search submission: ${query}`);
      assert.equal(search.redirects.includes("extension-test://blocked.html"), expected, `input search: ${query}`);
    }
  }
}
console.log(`Chrome/Safari/native parity passed: ${browserPermanentBlockedDomains().length} permanent domains, keyword searches, encoded and SPA navigation, input and ordinary controls.`);
