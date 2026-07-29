import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { contentFilterRuleEntries } from "../src/contentFilters.js";
import { SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { compactExtensionRuleSignature, evaluateExtensionCheck, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { activePolicy } from "../src/policy.js";
import { must, now, recordValue, stringValue, TEST_DAYS } from "./test-helpers.mjs";

const [backgroundSource, contentSource, googleSafeSearchSource, staticRulesText, extensionManifestText, blockedPageSource, blockedPageScriptSource, optionsPageSource] = await Promise.all([
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/rules.json", import.meta.url), "utf8"),
  readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../extension/blocked.html", import.meta.url), "utf8"),
  readFile(new URL("../extension/blocked.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/options.html", import.meta.url), "utf8")
]);
const staticRules = JSON.parse(staticRulesText) as Array<Record<string, unknown>>;
const extensionManifest = JSON.parse(extensionManifestText) as Record<string, unknown>;
assert.equal(extensionManifest.minimum_chrome_version, "120", "30-second rule-sync alarms require Chrome 120 or newer");
assert.match(backgroundSource, /offlineCheckResult/);
assert.match(backgroundSource, /VIGIL_REQUEST_TIMEOUT_MS/);
assert.match(backgroundSource, /inFlightChecks/);
assert.match(backgroundSource, /duplicateCheckKey/);
assert.match(backgroundSource, /chrome\.alarms/);
assert.match(backgroundSource, /normalizedRuleUntil/);
assert.match(backgroundSource, /PERSISTENT_RULE_UNTIL/);
assert.match(backgroundSource, /vigilPulseFlags/);
const backgroundSiteRuleLimit = 300;
const backgroundContentRuleLimit = 200;
assert.match(backgroundSource, /const SITE_BLOCK_RULE_LIMIT = 300;/u);
assert.match(backgroundSource, /const CONTENT_BLOCK_RULE_LIMIT = 200;/u);
assert.equal(staticRules.length, 4);
assert.match(staticRulesText, /"safe"\s*,\s*"value": "active"/u);
assert.match(staticRulesText, /"adlt"\s*,\s*"value": "strict"/u);
assert.match(staticRulesText, /"kp"\s*,\s*"value": "1"/u);
assert.match(JSON.stringify(extensionManifest.declarative_net_request), /vigil_always_on_search_protection/u);
assert.doesNotMatch(staticRulesText, /127\.0\.0\.1|localhost|8787/u, "static rules must not assume Vigil's configured port");
assert.deepEqual(
  staticRules.slice(0, 3).map((rule) => rule.priority),
  [1, 1, 1],
  "SafeSearch transforms must stay below all active top-level enforcement rules"
);
assert.equal(staticRules[3]?.priority, 1_000, "the explicit-search block must outrank SafeSearch transforms");
const googleSafeSearchCondition = recordValue(staticRules[0]?.condition, "Google SafeSearch DNR condition");
assert.equal(googleSafeSearchCondition.urlFilter, undefined, "Google SafeSearch must use an endpoint-exact regex filter");
assert.equal(googleSafeSearchCondition.isUrlFilterCaseSensitive, true);
assert.deepEqual(googleSafeSearchCondition.requestMethods, ["get"], "Google SafeSearch DNR must not rewrite non-GET requests");
const googleSafeSearchRegex = new RegExp(String(googleSafeSearchCondition.regexFilter || ""));
assert.equal(googleSafeSearchRegex.test("https://google.com/search?q=reference"), true);
assert.equal(googleSafeSearchRegex.test("https://www.google.com/search?q=reference"), true);
assert.equal(googleSafeSearchRegex.test("https://images.google.com/search?q=reference"), true);
assert.equal(googleSafeSearchRegex.test("https://docs.google.com/search?q=reference"), false);
assert.equal(googleSafeSearchRegex.test("https://www.google.com/search/results?q=reference"), false);
const explicitSearchCondition = staticRules[3]?.condition as { regexFilter?: unknown } | undefined;
const explicitSearchRegex = new RegExp(String(explicitSearchCondition?.regexFilter || ""), "i");
assert.equal(explicitSearchRegex.test("https://www.google.com/search?q=ordinary+reference"), false);
assert.equal(explicitSearchRegex.test("https://www.google.com/search?q=explicit+porn+query"), true);
assert.equal(explicitSearchRegex.test("https://www.bing.com/search?q=18%2B"), true);
const explicitSearchAction = recordValue(staticRules[3]?.action, "explicit-search DNR action");
const explicitSearchRedirect = recordValue(explicitSearchAction.redirect, "explicit-search DNR redirect");
assert.equal(explicitSearchRedirect.extensionPath, "/blocked.html");
assert.match(blockedPageSource, /data-vigil-block-page="1"/u);
assert.match(blockedPageSource, /--primary: #b77952/u);
assert.match(blockedPageSource, /<p class="eyebrow">Vigil<\/p>/u);
assert.match(blockedPageSource, /id="leaveBlockedPage" href="about:blank">Go back/u);
assert.match(blockedPageSource, /<script src="blocked\.js"><\/script>/u);
assert.match(blockedPageScriptSource, /location\.replace\("about:blank"\)/u);
assert.doesNotMatch(blockedPageSource, /history\.(?:back|go)/u);
assert.doesNotMatch(blockedPageScriptSource, /history\.(?:back|go)/u);
assert.doesNotMatch(blockedPageScriptSource, /\nexport \{\};?\s*$/u, "the blocked-page script must be emitted as a classic extension script");
assert.match(optionsPageSource, /--primary: #b77952/u, "the companion options page must use Vigil's current copper accent");
assert.match(optionsPageSource, /color-scheme: dark/u, "the companion options page must use the current charcoal surface");
assert.doesNotMatch(optionsPageSource, /#126a6f|#f6f1e8|#fffcf4/u, "the companion options page must not return to the retired teal theme");
const webAccessibleResources = extensionManifest.web_accessible_resources as Array<{ resources?: unknown }> | undefined;
assert.equal(webAccessibleResources?.some((entry) => Array.isArray(entry.resources) && entry.resources.includes("blocked.html")), true);
const contentScripts = extensionManifest.content_scripts as Array<{ js?: unknown }> | undefined;
assert.equal(contentScripts?.some((entry) => Array.isArray(entry.js) && entry.js[0] === "google-safe-search.js"), true);
assert.doesNotMatch(backgroundSource, /\nexport \{\};?\s*$/u, "the Chrome service worker must be emitted as a classic script");
assert.doesNotMatch(contentSource, /\nexport \{\};?\s*$/u, "Chrome content scripts cannot contain ESM export syntax");
assert.doesNotMatch(googleSafeSearchSource, /\nexport \{\};?\s*$/u, "the SafeSearch guard must be emitted as a classic content script");
assert.doesNotMatch(googleSafeSearchSource, /safeSearchEnabled|chrome\.storage/u, "Google SafeSearch enforcement must not have a setting or stored off path");
assert.match(googleSafeSearchSource, /searchParams\.set\("safe", "active"\)/u);
assert.doesNotMatch(backgroundSource, /result\.signature\s*=\s*snapshot\.dynamicRuleSignature/);
assert.doesNotMatch(contentSource, /activateOfflineGuard/);
assert.doesNotMatch(contentSource, /data-vigil-page-guard-state/);
assert.match(contentSource, /root\?\.style\.setProperty\("visibility", "hidden", "important"\)/u);
assert.match(contentSource, /visibility: visible !important/u);
assert.match(
  contentSource,
  /const generation = \+\+pulseGeneration[\s\S]*?if \(generation !== pulseGeneration\)\s*return;[\s\S]*?handlePulseResult\(result\)/u,
  "stale pulse responses must not release a newer navigation guard"
);
assert.match(contentSource, /background: #b77952/u, "the injected pause overlay must use Vigil's current copper action");
assert.doesNotMatch(contentSource, /#18345b|#142238|#d1a94d/u, "the injected pause overlay must not return to the retired navy-and-gold theme");
assert.match(compactExtensionRuleSignature("large canonical rule payload"), /^sha256:[a-f0-9]{64}$/u);
assert.equal(
  compactExtensionRuleSignature(compactExtensionRuleSignature("large canonical rule payload")),
  compactExtensionRuleSignature("large canonical rule payload"),
  "persisted rule digests must remain stable when normalized again"
);
assert.ok(
  contentSource.indexOf("focusedSocialCleanupEnabled === true") < contentSource.indexOf("result.offline === true"),
  "cached cleanup flags must be applied before an offline pulse releases the page guard"
);

{
  const start = contentSource.indexOf("function handlePulseResult(");
  const end = contentSource.indexOf("\nfunction patchHistory(", start);
  assert.ok(start >= 0 && end > start, "the pulse-result handler must remain available for behavior tests");
  const effects: string[] = [];
  const context = createContext({
    activePauseOverlay: null,
    cleanupBrowserNoise() { effects.push("noise-on"); },
    teardownYoutubeAutofillFriction() { effects.push("noise-off"); },
    applyFocusedSocialCleanup() { effects.push("cleanup-on"); },
    teardownFocusedSocialCleanup() { effects.push("cleanup-off"); },
    releasePageGuard() { effects.push("release"); },
    replaceLocation() { effects.push("redirect"); },
    showPauseOverlay() { effects.push("pause"); return true; }
  });
  runInContext(contentSource.slice(start, end), context);
  Object.assign(context, {
    staleResult: {
      stale: true,
      browserNoiseBlockingEnabled: true,
      focusedSocialCleanupEnabled: true,
      blocked: true,
      redirectUrl: "http://127.0.0.1:8787/blocked"
    },
    skippedResult: {
      skipped: true,
      browserNoiseBlockingEnabled: false,
      focusedSocialCleanupEnabled: false
    }
  });
  runInContext("handlePulseResult(staleResult); handlePulseResult(skippedResult);", context);
  assert.deepEqual(
    effects,
    ["release", "release"],
    "stale and skipped current-pulse outcomes must release the page guard without applying stale policy side effects"
  );
}

{
  const start = contentSource.indexOf("async function continueFromOverlay(");
  const end = contentSource.indexOf("\nasync function skipFromOverlay(", start);
  assert.ok(start >= 0 && end > start, "the pause continue handler must remain available for behavior tests");
  const removals: boolean[] = [];
  const resets: string[] = [];
  const context = createContext({
    activePauseOverlay: { requestId: "old-request" },
    decision: { requestId: "old-request" },
    button: { disabled: false },
    sendPauseAction: async () => ({ ok: true }),
    setOverlayStatus() {},
    removePauseOverlay(resumeMedia: boolean) { removals.push(resumeMedia); },
    resetAndPulse(reason: string) { resets.push(reason); },
    errorMessage(error: unknown) { return String(error); }
  });
  runInContext(contentSource.slice(start, end), context);
  const oldContinue = runInContext(
    'continueFromOverlay(decision, "write the report", "Focused", button)',
    context
  ) as Promise<void>;
  runInContext('activePauseOverlay = { requestId: "new-request" }', context);
  await oldContinue;
  assert.deepEqual(removals, [],
    "an old continue response must not dismiss a newer pause overlay");
  assert.deepEqual(resets, [],
    "an old continue response must not reset and pulse beneath a newer pause overlay");

  runInContext('activePauseOverlay = { requestId: "old-request" }; button.disabled = false', context);
  await runInContext(
    'continueFromOverlay(decision, "write the report", "Focused", button)',
    context
  );
  assert.deepEqual(removals, [true], "the matching continue response should dismiss its own pause overlay");
  assert.deepEqual(resets, ["activated"], "the matching continue response should refresh the active tab");
}

{
  type TestEvent = {
    target: unknown;
    submitter?: {
      name: string;
      value: string;
      formAction: string;
      formMethod: string;
      hasAttribute(name: string): boolean;
    } | null;
    preventDefault(): void;
    stopImmediatePropagation(): void;
  };
  type SafeSearchListener = (event: TestEvent) => void;
  class TestElement {
    anchor: { href: string } | null = null;

    closest(selector: string): { href: string } | null {
      assert.equal(selector, "a[href]");
      return this.anchor;
    }
  }
  class TestForm {
    action = "https://www.google.com/search";
    method = "get";
    fields: Array<[string, string]> = [];
  }
  class TestFormData {
    readonly fields: Array<[string, string]>;

    constructor(form: TestForm, submitter?: { name: string; value: string } | null) {
      this.fields = [...form.fields];
      if (submitter?.name) this.fields.push([submitter.name, submitter.value]);
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
      return this.fields[Symbol.iterator]();
    }
  }

  const listeners = new Map<string, SafeSearchListener>();
  const replacements: string[] = [];
  const assignments: string[] = [];
  const location = {
    href: "https://www.google.com/search?q=ordinary&safe=off",
    replace(value: string) { replacements.push(value); },
    assign(value: string) { assignments.push(value); }
  };
  const context = createContext({
    URL,
    Element: TestElement,
    FormData: TestFormData,
    HTMLFormElement: TestForm,
    chrome: {
      runtime: {
        getURL(path: string) { return `chrome-extension://vigil/${path}`; }
      }
    },
    location,
    addEventListener(name: string, listener: SafeSearchListener) { listeners.set(name, listener); }
  });
  runInContext(googleSafeSearchSource.replace(/\nexport \{\};?\s*$/u, ""), context);

  const currentRedirect = new URL(must(replacements[0], "current-navigation SafeSearch redirect"));
  assert.equal(currentRedirect.searchParams.get("q"), "ordinary");
  assert.equal(currentRedirect.searchParams.get("safe"), "active");
  assert.equal(
    runInContext("googleSafeSearchRedirect('https://www.google.com/search?q=ready&safe=active')", context),
    null,
    "an already-safe Google navigation must not loop"
  );
  assert.equal(
    runInContext("googleSafeSearchRedirect('https://example.com/search?q=ordinary&safe=off')", context),
    null,
    "the guard must not rewrite non-Google destinations"
  );
  assert.equal(
    runInContext("googleSafeSearchRedirect('https://docs.google.com/search?q=ordinary&safe=off')", context),
    null,
    "the guard must not treat another Google product's search route as Google Search"
  );
  assert.equal(
    runInContext("googleSafeSearchRedirect('https://www.google.com/maps?q=ordinary&safe=off')", context),
    null,
    "the guard must not rewrite non-search Google routes"
  );
  assert.equal(
    runInContext("googleSafeSearchRedirect('https://www.google.com/search/results?q=ordinary&safe=off')", context),
    null,
    "the guard must match the Google Search path exactly"
  );
  assert.equal(
    runInContext("explicitSearchBlockRedirect('https://www.google.com/search?q=p%6Frn')", context),
    "chrome-extension://vigil/blocked.html",
    "the always-on guard must block explicit terms containing encoded characters"
  );
  location.href = "https://www.google.com/search?q=p%6Frn&safe=active";
  runInContext("enforceGoogleSafeSearchForCurrentNavigation()", context);
  assert.equal(
    replacements.at(-1),
    "chrome-extension://vigil/blocked.html",
    "an encoded explicit current navigation must reach the bundled block page even when SafeSearch is already active"
  );
  location.href = "https://www.google.com/search?q=ordinary&safe=active";
  assert.equal(
    runInContext("explicitSearchBlockRedirect('https://www.bing.com/search?QUERY=18%252B')", context),
    "chrome-extension://vigil/blocked.html",
    "the always-on guard must decode search names case-insensitively and nested encoded values"
  );
  assert.equal(
    runInContext("explicitSearchBlockRedirect('https://google.com.example/search?q=p%6Frn')", context),
    null,
    "lookalike domains must not be treated as protected search providers"
  );

  const linkTarget = new TestElement();
  linkTarget.anchor = { href: "https://images.google.com/search?q=reference&safe=off" };
  let linkPrevented = false;
  let linkPropagationStopped = false;
  must(listeners.get("click"), "SafeSearch click listener")({
    target: linkTarget,
    preventDefault() { linkPrevented = true; },
    stopImmediatePropagation() { linkPropagationStopped = true; }
  });
  assert.equal(linkPrevented, true);
  assert.equal(linkPropagationStopped, true);
  const linkRedirect = new URL(must(assignments.at(-1), "link SafeSearch redirect"));
  assert.equal(linkRedirect.searchParams.get("safe"), "active");

  linkTarget.anchor = { href: "https://duckduckgo.com/?q=encoded+p%6Frn" };
  must(listeners.get("click"), "explicit-search click listener")({
    target: linkTarget,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  assert.equal(assignments.at(-1), "chrome-extension://vigil/blocked.html");

  const form = new TestForm();
  form.action = "https://example.com/submit";
  form.fields = [["q", "form reference"], ["safe", "off"]];
  const submitter = {
    name: "source",
    value: "search-button",
    formAction: "https://www.google.com/search",
    formMethod: "get",
    hasAttribute(name: string) { return name === "formaction" || name === "formmethod"; }
  };
  let formPrevented = false;
  let formPropagationStopped = false;
  must(listeners.get("submit"), "SafeSearch submit listener")({
    target: form,
    submitter,
    preventDefault() { formPrevented = true; },
    stopImmediatePropagation() { formPropagationStopped = true; }
  });
  assert.equal(formPrevented, true);
  assert.equal(formPropagationStopped, true);
  const formRedirect = new URL(must(assignments.at(-1), "form SafeSearch redirect"));
  assert.equal(formRedirect.searchParams.get("q"), "form reference");
  assert.equal(formRedirect.searchParams.get("safe"), "active");
  assert.equal(formRedirect.searchParams.get("source"), "search-button", "named submitter fields must survive the redirect");

  form.fields = [["q", "p%6Frn"]];
  must(listeners.get("submit"), "explicit-search submit listener")({
    target: form,
    submitter,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  assert.equal(assignments.at(-1), "chrome-extension://vigil/blocked.html");
  form.fields = [["q", "form reference"], ["safe", "off"]];

  const assignmentCountBeforePost = assignments.length;
  form.action = "https://www.google.com/search";
  form.method = "post";
  const plainSubmitter = {
    name: "source",
    value: "plain-button",
    formAction: "https://www.google.com/maps",
    formMethod: "get",
    hasAttribute() { return false; }
  };
  let postPrevented = false;
  let postPropagationStopped = false;
  must(listeners.get("submit"), "SafeSearch submit listener")({
    target: form,
    submitter: plainSubmitter,
    preventDefault() { postPrevented = true; },
    stopImmediatePropagation() { postPropagationStopped = true; }
  });
  assert.equal(postPrevented, false, "a plain submitter must not override its parent form's POST method");
  assert.equal(postPropagationStopped, false);
  assert.equal(assignments.length, assignmentCountBeforePost, "POST search forms must not be replaced with GET navigations");

  form.method = "get";
  let plainGetPrevented = false;
  let plainGetPropagationStopped = false;
  must(listeners.get("submit"), "SafeSearch submit listener")({
    target: form,
    submitter: plainSubmitter,
    preventDefault() { plainGetPrevented = true; },
    stopImmediatePropagation() { plainGetPropagationStopped = true; }
  });
  assert.equal(plainGetPrevented, true, "a plain submitter must use its parent Google Search form's action");
  assert.equal(plainGetPropagationStopped, true);
  assert.equal(assignments.length, assignmentCountBeforePost + 1);
  const plainGetRedirect = new URL(must(assignments.at(-1), "plain-submitter Google Search redirect"));
  assert.equal(plainGetRedirect.pathname, "/search");
  assert.equal(plainGetRedirect.searchParams.get("source"), "plain-button");

  const assignmentCountBeforePostOverride = assignments.length;
  const postSubmitter = {
    name: "source",
    value: "search-button",
    formAction: "https://www.google.com/search",
    formMethod: "post",
    hasAttribute(name: string) { return name === "formmethod"; }
  };
  let postOverridePrevented = false;
  let postOverridePropagationStopped = false;
  must(listeners.get("submit"), "SafeSearch submit listener")({
    target: form,
    submitter: postSubmitter,
    preventDefault() { postOverridePrevented = true; },
    stopImmediatePropagation() { postOverridePropagationStopped = true; }
  });
  assert.equal(postOverridePrevented, false);
  assert.equal(postOverridePropagationStopped, false);
  assert.equal(assignments.length, assignmentCountBeforePostOverride, "a submitter POST override must not be replaced with a GET navigation");
}

{
  const state = defaultState();
  const usage = {};
  const normalYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(normalYoutube.browserNoiseBlockingEnabled, true);
  assert.equal(normalYoutube.focusedSocialCleanupEnabled, false);
  assert.equal(extensionRuleSnapshot(state, now).focusedSocialCleanupEnabled, false);

  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.focusedSocial.youtube.home = false;
  state.deviceControls.ios.focusedSocial.instagram.explore = false;
  state.deviceControls.ios.focusedSocial.snapchat.stories = false;
  const iosFocusedSocial = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(iosFocusedSocial.focusedSocialCleanupEnabled, false);
  const iosCleanup = recordValue(iosFocusedSocial.focusedSocialCleanupSettings, "iOS cleanup settings");
  assert.equal(recordValue(iosCleanup.youtube, "YouTube cleanup settings").home, false);
  assert.equal(recordValue(iosCleanup.instagram, "Instagram cleanup settings").explore, false);
  assert.equal(recordValue(iosCleanup.snapchat, "Snapchat cleanup settings").stories, true);
  const snapshotCleanup = recordValue(extensionRuleSnapshot(state, now).focusedSocialCleanupSettings, "snapshot cleanup settings");
  assert.equal(recordValue(snapshotCleanup.youtube, "snapshot YouTube cleanup settings").home, false);
  assert.equal(recordValue(snapshotCleanup.snapchat, "snapshot Snapchat cleanup settings").stories, true);
  state.deviceControls.ios.focusedSocial.enabled = false;
  const iosFocusedSocialOff = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(iosFocusedSocialOff.focusedSocialCleanupEnabled, false);

  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const activeYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(activeYoutube.focusedSocialCleanupEnabled, true);
  assert.equal(recordValue(recordValue(activeYoutube.focusedSocialCleanupSettings, "active cleanup settings").youtube, "active YouTube cleanup settings").home, false);
  assert.equal(extensionRuleSnapshot(state, now).focusedSocialCleanupEnabled, true);
  const blocked = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/all", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  const blockedRedirect = new URL(stringValue(blocked.redirectUrl, "blocked redirect URL"));
  assert.equal(blockedRedirect.pathname, "/blocked");
  assert.equal(blockedRedirect.searchParams.get("site"), "Reddit Popular");
  assert.equal(blockedRedirect.searchParams.get("policyId"), "strict");
  const normalReddit = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/learnprogramming/comments/demo", event: "navigation" }, now);
  assert.equal(normalReddit.blocked, false);
  assert.equal(normalReddit.paused, false);

  const allowed = evaluateExtensionCheck(state, usage, { url: "https://docs.google.com/document/u/0/", event: "navigation" }, now);
  assert.equal(allowed.blocked, false);

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(new Set(rules.contentRules.map((rule) => rule.urlFilter)).size, rules.contentRules.length);
  assert.equal(rules.dynamicRuleCount, rules.rules.length + rules.contentRules.length + rules.allowlistRules.length);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.redirectUrl.includes("/blocked")), false);
  assert.equal(rules.rules.some((rule) => rule.domain === "youtu.be"), false);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||reddit.com/r/all"), true);
}

{
  const state = defaultState();
  const usage = {};
  state.limitRules = [{
    id: "open-extension",
    name: "Extension Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 30,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const result = evaluateExtensionCheck(state, usage, { url: "https://reddit.com/", event: "navigation" }, now);
  assert.equal(result.blocked, true);
  assert.equal(state.limitBlocks.length, 1);
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.reason === "limit"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-rules",
    title: "Content rules",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/shorts"), true);
  const shortsRedirect = new URL(must(rules.contentRules.find((rule) => rule.urlFilter === "||youtube.com/shorts"), "YouTube Shorts dynamic rule").redirectUrl);
  assert.equal(shortsRedirect.pathname, "/blocked");
  assert.equal(shortsRedirect.searchParams.get("site"), "YouTube Shorts");
  assert.equal(shortsRedirect.searchParams.get("back"), "https://www.youtube.com/");
  assert.equal(decodeURIComponent(shortsRedirect.toString()).includes("youtube.com/shorts"), false);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/explore"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/feed/explore"), true);
  assert.equal(contentFilterRuleEntries(state, activePolicy(state, now)).some((rule) => rule.id === "reddit-popular"), true);
  state.settings.contentFilterEnabled = false;
  const disabledContentRules = extensionRuleSnapshot(state, now).contentRules;
  assert.equal(disabledContentRules.some((rule) => rule.id === "reddit-popular"), true);
  assert.equal(disabledContentRules.some((rule) => rule.kind === "url-pattern"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-fallbacks",
    title: "Content fallbacks",
    mode: "focus",
    profileId: "custom-allowlist",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      id: "custom-allowlist",
      name: "Content allowlist",
      mode: "allowlist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: ["youtube.com", "instagram.com"]
    }
  };
  const rules = extensionRuleSnapshot(state, now);
  const allowlistRule = must(rules.allowlistRules[0], "browser allowlist rule");
  assert.equal(allowlistRule.excludedDomains?.includes("::1"), true);
  assert.equal(allowlistRule.until, state.activeSession.endsAt);
  assert.equal(rules.dynamicRuleCount, rules.rules.length + rules.contentRules.length + rules.allowlistRules.length + 1);
  const allowedShortsRedirect = new URL(must(rules.contentRules.find((rule) => rule.urlFilter === "||youtube.com/shorts"), "allowed YouTube Shorts rule").redirectUrl);
  assert.equal(allowedShortsRedirect.pathname, "/blocked");
  assert.equal(allowedShortsRedirect.searchParams.get("site"), "YouTube Shorts");
  assert.equal(allowedShortsRedirect.searchParams.get("back"), "https://www.youtube.com/");
  assert.equal(decodeURIComponent(allowedShortsRedirect.toString()).includes("youtube.com/shorts"), false);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), false);
}

{
  const state = defaultState();
  const baseline = must(
    state.profiles.find((profile) => profile.id === state.settings.baselineProfileId),
    "browser baseline profile"
  );
  baseline.mode = "allowlist";
  baseline.blockedSites = ["baseline-only.test", "shared-policy.test"];
  baseline.blockedUrlPatterns = ["baseline-path.test/private", "shared-policy.test/private"];
  baseline.allowedSites = ["baseline-allowed.test"];

  const idleRules = extensionRuleSnapshot(state, now);
  assert.equal(idleRules.rules.some((rule) => rule.domain === "baseline-only.test"), true);
  assert.equal(idleRules.contentRules.some((rule) => rule.urlFilter === "||baseline-path.test/private"), true);
  assert.equal(
    idleRules.allowlistRules.some((rule) => rule.excludedDomains?.includes("baseline-allowed.test")),
    true,
    "an idle baseline allowlist must be installed proactively"
  );

  state.activeSession = {
    id: "active-browser-projection",
    title: "Active browser projection",
    mode: "focus",
    profileId: "active-browser-projection",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      id: "active-browser-projection",
      name: "Active browser projection",
      mode: "blocklist",
      blockedApps: [],
      blockedSites: ["active-only.test", "shared-policy.test"],
      blockedUrlPatterns: ["active-path.test/private", "shared-policy.test/private"],
      allowedApps: [],
      allowedSites: []
    }
  };

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "baseline-only.test"), true, "active sessions must retain baseline site denies");
  assert.equal(rules.rules.some((rule) => rule.domain === "active-only.test"), true);
  const sharedSite = must(rules.rules.find((rule) => rule.domain === "shared-policy.test"), "shared site rule");
  assert.equal(sharedSite.reason, "session", "active site rules must take precedence over matching baseline rules");
  assert.equal(sharedSite.until, state.activeSession.endsAt);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||baseline-path.test/private"), true, "active sessions must retain baseline URL-pattern denies");
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||active-path.test/private"), true);
  const sharedPattern = must(
    rules.contentRules.find((rule) => rule.urlFilter === "||shared-policy.test/private"),
    "shared URL-pattern rule"
  );
  assert.equal(sharedPattern.until, state.activeSession.endsAt, "active URL-pattern rules must take precedence over matching baseline rules");
  const baselineAllowlist = must(
    rules.allowlistRules.find((rule) => rule.excludedDomains?.includes("baseline-allowed.test")),
    "baseline browser allowlist rule"
  );
  assert.equal(baselineAllowlist.until, "", "the permanent baseline allowlist must remain permanent during an active session");
}

{
  const state = defaultState();
  state.settings.baselineProfileId = SOFT_BLOCK_PROFILE_ID;
  state.activeSession = {
    id: "active-with-soft-baseline",
    title: "Active with Soft Lock baseline",
    mode: "focus",
    profileId: "active-with-soft-baseline",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      id: "active-with-soft-baseline",
      name: "Active without Soft Lock filters",
      mode: "blocklist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    }
  };

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/shorts"), true, "permanent content filters must remain active");
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), false, "baseline-only Soft Lock content filters must not leak into another active profile");
}

{
  const state = defaultState();
  state.activeSession = null;
  state.appLocks = [{
    id: "extension-lock",
    name: "Extension Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const rules = extensionRuleSnapshot(state, now);
  const reddit = must(rules.rules.find((rule) => rule.domain === "reddit.com"), "reddit extension rule");
  assert.equal(reddit.reason, "app-lock");
  assert.equal(new URL(reddit.redirectUrl).searchParams.get("lockId"), "extension-lock");
}

{
  const state = defaultState();
  state.integrity.stateSeal.tamperDetectedAt = now.toISOString();
  state.integrity.stateSeal.tamperDetail = "test integrity lockdown";
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.until === "until the tamper alarm is cleared"), true);
  assert.equal(rules.contentRules.some((rule) => rule.until === "until the tamper alarm is cleared"), true);
  assert.equal(
    rules.contentRules
      .filter((rule) => rule.until === "until the tamper alarm is cleared")
      .every((rule) => new URL(rule.redirectUrl).searchParams.get("policyId") === "integrity:tamper-lockdown"),
    true,
    "integrity content-rule receipts must identify the exact policy that generated them"
  );
  assert.equal(
    rules.contentRules.every((rule) => ["", "until the tamper alarm is cleared"].includes(rule.until)),
    true,
    "integrity rules and permanent baseline rules must retain their respective lifetimes"
  );
}

{
  function deferredValue<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  async function waitForCondition(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the extension VM condition.");
  }

  const storage: Record<string, unknown> = {};
  const storageWrites: Array<Record<string, unknown>> = [];
  const dynamicRuleUpdates: Array<Record<string, unknown>> = [];
  let installedDynamicRules: Array<Record<string, unknown>> = [];
  const alarmCreates: Array<{ name: string; options: Record<string, unknown> }> = [];
  const alarmClears: string[] = [];
  const installedAlarms = new Map<string, { name: string; periodInMinutes?: number; scheduledTime: number }>();
  let ruleFetchFailure = "";
  let dynamicRuleUpdateFailure = false;
  let dynamicRuleReadFailure = false;
  let runtimeLastError: { message: string } | null = null;
  let currentTabUrl = "https://example.com/";
  let checkFetchOverride: (() => Promise<Response> | Response) | null = null;
  const queuedRuleFetches: Array<Promise<Response>> = [];
  let ruleFetchCount = 0;
  let delayNextBadgeText = false;
  let delayedBadgeTextCallback: (() => void) | null = null;
  let delayNextTabMessage = false;
  let delayedTabMessageCallback: ((response: unknown) => void) | null = null;
  let delayNextDynamicRuleUpdate = false;
  let delayedDynamicRuleUpdateCallback: (() => void) | null = null;
  const tabUpdates: Array<{ tabId: number; change: unknown }> = [];
  const tabMessages: Array<{ tabId: number; message: unknown; options: unknown }> = [];
  const event = () => ({ addListener() {} });
  const context = createContext({
    AbortController,
    Headers,
    Response,
    URL,
    clearTimeout,
    console,
    fetch: async (url: string) => {
      if (String(url).includes("/api/extension/check") && checkFetchOverride) {
        return await checkFetchOverride();
      }
      if (String(url).includes("/api/extension/rules?")) {
        ruleFetchCount += 1;
        const queued = queuedRuleFetches.shift();
        if (queued) return await queued;
        if (ruleFetchFailure) throw new Error(ruleFetchFailure);
        return new Response(JSON.stringify({
          rules: [],
          contentRules: [],
          allowlistRules: [],
          dynamicRuleCount: 0,
          dynamicRuleSignature: JSON.stringify({ site: [], content: [], allowlist: [], localServerAllow: false })
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
    setTimeout,
    chrome: {
      action: {
        setBadgeBackgroundColor(_options: unknown, callback: () => void) { callback(); },
        setBadgeText(_options: unknown, callback: () => void) {
          if (delayNextBadgeText) {
            delayNextBadgeText = false;
            delayedBadgeTextCallback = callback;
            return;
          }
          callback();
        }
      },
      alarms: {
        create(name: string, options: Record<string, unknown>) {
          alarmCreates.push({ name, options });
          installedAlarms.set(name, {
            name,
            ...(Number.isFinite(Number(options.periodInMinutes)) ? { periodInMinutes: Number(options.periodInMinutes) } : {}),
            scheduledTime: Number(options.when || Date.now() + Number(options.periodInMinutes || 0) * 60_000)
          });
        },
        clear(name: string, callback: () => void) {
          alarmClears.push(name);
          installedAlarms.delete(name);
          callback();
        },
        get(name: string, callback: (alarm?: { name: string; periodInMinutes?: number; scheduledTime: number }) => void) {
          callback(installedAlarms.get(name));
        },
        onAlarm: event()
      },
      declarativeNetRequest: {
        updateDynamicRules(options: Record<string, unknown>, callback: () => void) {
          dynamicRuleUpdates.push(options);
          if (dynamicRuleUpdateFailure) {
            runtimeLastError = { message: "simulated dynamic-rule update failure" };
            callback();
            runtimeLastError = null;
            return;
          }
          const removeRuleIds = Array.isArray(options.removeRuleIds) ? options.removeRuleIds.map(Number) : [];
          installedDynamicRules = installedDynamicRules.filter((rule) => !removeRuleIds.includes(Number(rule.id)));
          if (Array.isArray(options.addRules)) installedDynamicRules.push(...options.addRules as Array<Record<string, unknown>>);
          if (delayNextDynamicRuleUpdate) {
            delayNextDynamicRuleUpdate = false;
            delayedDynamicRuleUpdateCallback = callback;
            return;
          }
          callback();
        },
        getDynamicRules(callback: (rules: Array<Record<string, unknown>>) => void) {
          if (dynamicRuleReadFailure) {
            runtimeLastError = { message: "simulated dynamic-rule read failure" };
            callback([]);
            runtimeLastError = null;
            return;
          }
          callback(installedDynamicRules);
        }
      },
      runtime: {
        getManifest() { return { version: "0.3.2" }; },
        get lastError() { return runtimeLastError; },
        onInstalled: event(),
        onMessage: event(),
        onStartup: event()
      },
      storage: {
        local: {
          get(defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) {
            callback({ ...defaults, ...storage });
          },
          set(value: Record<string, unknown>, callback: () => void) {
            storageWrites.push(value);
            Object.assign(storage, value);
            callback();
          }
        },
        onChanged: event()
      },
      tabs: {
        get(_tabId: number, callback: (tab: { url: string }) => void) { callback({ url: currentTabUrl }); },
        onActivated: event(),
        onRemoved: event(),
        onUpdated: event(),
        remove(_tabId: number, callback: () => void) { callback(); },
        sendMessage(
          tabId: number,
          message: unknown,
          options: unknown,
          callback: (response: unknown) => void
        ) {
          tabMessages.push({ tabId, message, options });
          if (delayNextTabMessage) {
            delayNextTabMessage = false;
            delayedTabMessageCallback = callback;
            return;
          }
          callback({ ok: true });
        },
        update(tabId: number, change: unknown, callback: () => void) {
          tabUpdates.push({ tabId, change });
          callback();
        }
      },
      webNavigation: {
        onCommitted: event(),
        onHistoryStateUpdated: event()
      }
    }
  });
  runInContext(backgroundSource.replace(/\nexport \{\};?\s*$/u, ""), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  dynamicRuleUpdates.length = 0;

  const relayedDirectDecision = Promise.resolve({
    ok: true,
    blocked: true,
    redirectUrl: "http://127.0.0.1:8787/blocked"
  });
  Object.assign(context, { relayedDirectDecision });
  const relayedDeferredDecision = await runInContext(
    `latestTabChecks.set(77, {
       generation: 2,
       url: "https://example.com/",
       request: relayedDirectDecision
     });
     supersedingCheckResult(77, 1, { deferTabAction: true })`,
    context
  ) as Record<string, unknown>;
  assert.equal(relayedDeferredDecision.blocked, true);
  assert.equal(
    relayedDeferredDecision.skipped,
    undefined,
    "a stale deferred content check must relay the newer direct decision instead of signaling allow"
  );

  runInContext(`
    tabDocumentIds.set(78, "current-document");
    tabMemory.set(78, "https://example.com/current");
    tabRequestGenerations.set(78, 4);
  `, context);
  const rejectedOldDocument = await runInContext(
    `checkUrl(
       78,
       "https://example.com/",
       "heartbeat",
       5,
       "",
       { deferTabAction: true, documentId: "old-document" }
     )`,
    context
  ) as Record<string, unknown>;
  assert.equal(rejectedOldDocument.stale, true);
  assert.equal(runInContext("tabRequestGenerations.get(78)", context), 4,
    "an old document pulse must be rejected before it increments the current tab generation");
  assert.equal(runInContext("tabMemory.get(78)", context), "https://example.com/current",
    "an old document pulse must not rewrite previous-URL memory");

  const blockedUrl = "https://example.com/blocked-during-badge";
  currentTabUrl = blockedUrl;
  checkFetchOverride = () => new Response(JSON.stringify({
    ok: true,
    blocked: true,
    redirectUrl: "http://127.0.0.1:8787/blocked"
  }), { status: 200 });
  delayNextBadgeText = true;
  const tabUpdateCountBeforeStaleBadge = tabUpdates.length;
  const delayedBlockedCheck = runInContext(
    `checkUrl(79, ${JSON.stringify(blockedUrl)}, "navigation", 0, "", {})`,
    context
  ) as Promise<Record<string, unknown>>;
  await waitForCondition(() => delayedBadgeTextCallback !== null);
  currentTabUrl = "https://example.com/newer";
  runInContext("tabRequestGenerations.set(79, (tabRequestGenerations.get(79) || 0) + 1)", context);
  const finishDelayedBadge = must(
    delayedBadgeTextCallback as (() => void) | null,
    "delayed badge callback"
  );
  delayedBadgeTextCallback = null;
  finishDelayedBadge();
  const staleBlockedResult = await delayedBlockedCheck;
  assert.equal(staleBlockedResult.skipped, true);
  assert.equal(tabUpdates.length, tabUpdateCountBeforeStaleBadge,
    "a check that becomes stale during badge rendering must not redirect the newer navigation");
  checkFetchOverride = null;
  currentTabUrl = "https://example.com/";

  const pauseUrl = "https://example.com/pause-during-overlay";
  currentTabUrl = pauseUrl;
  runInContext('tabDocumentIds.set(81, "pause-document")', context);
  checkFetchOverride = () => new Response(JSON.stringify({
    ok: true,
    paused: true,
    requestId: "pause-request",
    redirectUrl: "http://127.0.0.1:8787/blocked"
  }), { status: 200 });
  delayNextTabMessage = true;
  const tabUpdateCountBeforeStalePause = tabUpdates.length;
  const tabMessageCountBeforeStalePause = tabMessages.length;
  const delayedPauseCheck = runInContext(
    `checkUrl(
       81,
       ${JSON.stringify(pauseUrl)},
       "navigation",
       0,
       "",
       { documentId: "pause-document" }
     )`,
    context
  ) as Promise<Record<string, unknown>>;
  await waitForCondition(() => delayedTabMessageCallback !== null);
  const pauseMessage = must(tabMessages[tabMessageCountBeforeStalePause], "targeted pause message");
  assert.equal(recordValue(pauseMessage.message, "pause message").expectedUrl, pauseUrl,
    "the pause content message must carry the URL it was checked for");
  assert.equal(recordValue(pauseMessage.options, "pause message options").documentId, "pause-document",
    "the pause content message must target the exact checked Chrome document");
  currentTabUrl = "https://example.com/newer-pause";
  runInContext(`
    tabDocumentIds.set(81, "new-pause-document");
    tabRequestGenerations.set(81, (tabRequestGenerations.get(81) || 0) + 1);
  `, context);
  const finishDelayedPauseMessage = must(
    delayedTabMessageCallback as ((response: unknown) => void) | null,
    "delayed pause message callback"
  );
  delayedTabMessageCallback = null;
  finishDelayedPauseMessage({ ok: true });
  const stalePauseResult = await delayedPauseCheck;
  assert.equal(stalePauseResult.skipped, true);
  assert.equal(tabUpdates.length, tabUpdateCountBeforeStalePause,
    "an overlay response for an old document must not redirect the newer navigation");
  checkFetchOverride = null;
  currentTabUrl = "https://example.com/";

  const delayedCheckJson = deferredValue<Record<string, unknown>>();
  let delayedCheckJsonStarted = false;
  const stalePolicyUrl = "https://example.com/stale-policy";
  currentTabUrl = stalePolicyUrl;
  runInContext('tabDocumentIds.set(80, "policy-document")', context);
  checkFetchOverride = () => ({
    ok: true,
    status: 200,
    json() {
      delayedCheckJsonStarted = true;
      return delayedCheckJson.promise;
    }
  } as Response);
  const writesBeforeStalePolicy = storageWrites.length;
  const ruleUpdatesBeforeStalePolicy = dynamicRuleUpdates.length;
  const stalePolicyCheck = runInContext(
    `checkUrl(
       80,
       ${JSON.stringify(stalePolicyUrl)},
       "heartbeat",
       5,
       "",
       { deferTabAction: true, documentId: "policy-document" }
     )`,
    context
  ) as Promise<Record<string, unknown>>;
  await waitForCondition(() => delayedCheckJsonStarted);
  currentTabUrl = "https://example.com/current-policy";
  runInContext(`
    tabDocumentIds.set(80, "new-policy-document");
    tabRequestGenerations.set(80, (tabRequestGenerations.get(80) || 0) + 1);
  `, context);
  delayedCheckJson.resolve({
    ok: true,
    browserNoiseBlockingEnabled: true,
    focusedSocialCleanupEnabled: true
  });
  const stalePolicyResult = await stalePolicyCheck;
  assert.equal(stalePolicyResult.stale, true);
  assert.equal(
    storageWrites.slice(writesBeforeStalePolicy).some((write) => (
      Object.hasOwn(write, "vigilPulseFlags") || Object.hasOwn(write, "browserNoiseBlockingEnabled")
    )),
    false,
    "a response that becomes stale while parsing must not persist pulse flags or noise state"
  );
  assert.equal(dynamicRuleUpdates.length, ruleUpdatesBeforeStalePolicy,
    "a response that becomes stale while parsing must not mutate noise DNR rules");
  checkFetchOverride = null;
  currentTabUrl = "https://example.com/";

  const initialRuleSyncAlarmCreates = alarmCreates.filter((alarm) => alarm.name === "vigil-rule-sync").length;
  assert.equal(initialRuleSyncAlarmCreates, 1, "a missing periodic rule-sync alarm must be installed on worker start");
  await runInContext("ensureRuleSyncAlarm()", context);
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-sync").length, initialRuleSyncAlarmCreates,
    "an already-correct periodic alarm must survive a worker restart without being recreated");
  installedAlarms.set("vigil-rule-sync", { name: "vigil-rule-sync", periodInMinutes: 1, scheduledTime: Date.now() + 60_000 });
  await runInContext("ensureRuleSyncAlarm()", context);
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-sync").length, initialRuleSyncAlarmCreates + 1,
    "a misconfigured periodic rule-sync alarm must be repaired");
  installedAlarms.delete("vigil-rule-sync");
  await runInContext("ensureRuleSyncAlarm()", context);
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-sync").length, initialRuleSyncAlarmCreates + 2,
    "a missing periodic rule-sync alarm must be restored");

  const runtimeNow = new Date();
  const runtimeState = defaultState();
  runtimeState.activeSession = {
    id: "runtime-signature",
    title: "Runtime signature",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: runtimeNow.toISOString(),
    endsAt: new Date(runtimeNow.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const serverSnapshot = extensionRuleSnapshot(runtimeState, runtimeNow);
  Object.assign(context, {
    serverRules: serverSnapshot.rules,
    serverContentRules: serverSnapshot.contentRules,
    serverAllowlistRules: serverSnapshot.allowlistRules
  });
  const installedServerSnapshot = await runInContext(
    "syncSiteBlocking(serverRules, serverContentRules, serverAllowlistRules)",
    context
  ) as { count: number; signature: string };
  assert.equal(installedServerSnapshot.count, serverSnapshot.dynamicRuleCount);
  assert.equal(installedServerSnapshot.signature, serverSnapshot.dynamicRuleSignature);

  const capacityNow = new Date();
  const capacityState = defaultState();
  capacityState.settings.adultBlocklistEnabled = false;
  const capacityBaseline = must(
    capacityState.profiles.find((profile) => profile.id === capacityState.settings.baselineProfileId),
    "capacity-test baseline profile"
  );
  capacityBaseline.blockedSites = Array.from(
    { length: backgroundSiteRuleLimit + 20 },
    (_, index) => `aaa-baseline-site-${String(index).padStart(3, "0")}.test`
  );
  capacityBaseline.blockedUrlPatterns = Array.from(
    { length: backgroundContentRuleLimit + 20 },
    (_, index) => `aaa-baseline-content-${String(index).padStart(3, "0")}.test/private`
  );
  capacityState.activeSession = {
    id: "capacity-priority",
    title: "Capacity priority",
    mode: "focus",
    profileId: "capacity-priority",
    lockLevel: "deep",
    startedAt: capacityNow.toISOString(),
    endsAt: new Date(capacityNow.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      id: "capacity-priority",
      name: "Capacity priority",
      mode: "blocklist",
      blockedApps: [],
      blockedSites: ["zzz-active-site.test"],
      blockedUrlPatterns: ["zzz-active-content.test/private"],
      allowedApps: [],
      allowedSites: []
    }
  };
  const capacitySnapshot = extensionRuleSnapshot(capacityState, capacityNow);
  assert.equal(capacitySnapshot.rules.length, backgroundSiteRuleLimit);
  assert.equal(capacitySnapshot.contentRules.length, backgroundContentRuleLimit);
  assert.equal(capacitySnapshot.rules.at(-1)?.domain, "zzz-active-site.test",
    "an active site rule must survive baseline overflow even when it sorts last");
  assert.equal(capacitySnapshot.contentRules.at(-1)?.urlFilter, "||zzz-active-content.test/private",
    "an active URL-pattern rule must survive baseline overflow even when it sorts last");
  Object.assign(context, {
    capacityRules: capacitySnapshot.rules,
    capacityContentRules: capacitySnapshot.contentRules,
    capacityAllowlistRules: capacitySnapshot.allowlistRules
  });
  const installedCapacitySnapshot = await runInContext(
    "syncSiteBlocking(capacityRules, capacityContentRules, capacityAllowlistRules)",
    context
  ) as { ok: boolean; count: number; signature: string };
  assert.equal(installedCapacitySnapshot.ok, true);
  assert.equal(installedCapacitySnapshot.count, capacitySnapshot.dynamicRuleCount,
    "the server count must describe the installable capacity-limited subset");
  assert.equal(installedCapacitySnapshot.signature, capacitySnapshot.dynamicRuleSignature,
    "the server signature must describe the installable capacity-limited subset");

  const persistentUntil = "until the tamper alarm is cleared";
  Object.assign(context, {
    testRules: [{ domain: "example.com", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    testContentRules: [
      { urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil },
      { urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }
    ],
    testAllowlistRules: [{
      excludedDomains: ["localhost", "::1", "127.0.0.1"],
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2099-01-01T00:00:00.000Z"
    }]
  });
  const result = await runInContext("syncSiteBlocking(testRules, testContentRules, testAllowlistRules)", context) as {
    ok: boolean;
    count: number;
    signature: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.deepEqual(JSON.parse(result.signature), {
    site: [{ domain: "example.com", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    content: [{ urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    allowlist: [{
      excludedDomains: ["::1", "127.0.0.1", "localhost"],
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2099-01-01T00:00:00.000Z"
    }],
    localServerAllow: true
  });
  const latestUpdate = must(dynamicRuleUpdates.at(-1), "dynamic rule update") as { addRules?: Array<Record<string, unknown>> };
  assert.equal(latestUpdate.addRules?.length, 7);
  const siteTopLevelRule = must(latestUpdate.addRules?.find((rule) => rule.id === 10000), "installed top-level site rule");
  const siteEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 13000), "installed embedded site rule");
  assert.deepEqual(Array.from(recordValue(siteTopLevelRule.condition, "top-level site DNR condition").resourceTypes as unknown[]), ["main_frame"]);
  assert.equal(recordValue(siteEmbeddedRule.action, "embedded site DNR action").type, "block");
  assert.ok((recordValue(siteEmbeddedRule.condition, "embedded site DNR condition").resourceTypes as unknown[]).includes("media"));
  assert.ok((recordValue(siteEmbeddedRule.condition, "embedded site DNR condition").resourceTypes as unknown[]).includes("sub_frame"));
  const contentEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 14000), "installed embedded content rule");
  assert.deepEqual(Array.from(recordValue(contentEmbeddedRule.condition, "embedded content DNR condition").resourceTypes as unknown[]), ["sub_frame"]);
  const allowlistRule = must(latestUpdate.addRules?.find((rule) => rule.id === 12000), "installed allowlist rule");
  const condition = recordValue(allowlistRule.condition, "allowlist DNR condition");
  assert.equal(Array.isArray(condition.excludedRequestDomains) && condition.excludedRequestDomains.includes("::1"), true);
  const allowlistEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 15000), "installed embedded allowlist rule");
  const embeddedAllowlistCondition = recordValue(allowlistEmbeddedRule.condition, "embedded allowlist DNR condition");
  assert.deepEqual(Array.from(embeddedAllowlistCondition.resourceTypes as unknown[]), ["sub_frame"]);
  assert.equal(Array.isArray(embeddedAllowlistCondition.excludedRequestDomains) && embeddedAllowlistCondition.excludedRequestDomains.includes("example.com"), false);
  const storageWriteCount = storageWrites.length;
  const dynamicRuleUpdateCount = dynamicRuleUpdates.length;
  const expiryAlarmCreateCount = alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length;
  const expiryAlarmClearCount = alarmClears.filter((name) => name === "vigil-rule-expiry").length;
  const repeatedResult = await runInContext("syncSiteBlocking(testRules, testContentRules, testAllowlistRules)", context) as {
    ok: boolean;
    count: number;
    signature: string;
  };
  assert.equal(repeatedResult.ok, true);
  assert.equal(repeatedResult.signature, result.signature);
  assert.equal(dynamicRuleUpdates.length, dynamicRuleUpdateCount, "unchanged rules must not reinstall Chrome DNR entries");
  assert.equal(storageWrites.length, storageWriteCount, "unchanged rules must not rewrite Chrome storage snapshots");
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length, expiryAlarmCreateCount,
    "unchanged rules must not recreate the same Chrome expiry alarm");
  assert.equal(alarmClears.filter((name) => name === "vigil-rule-expiry").length, expiryAlarmClearCount,
    "unchanged rules must not clear the same Chrome expiry alarm");

  runInContext(`
    siteRulesSignature = "";
    siteRuleCount = 0;
    noiseRulesEnabled = null;
    scheduledRuleExpirySourceAt = undefined;
    coldStartDynamicRulesPromise = null;
  `, context);
  const coldStartStorageWrites = storageWrites.length;
  const coldStartDynamicRuleUpdates = dynamicRuleUpdates.length;
  await Promise.all([
    runInContext("pruneStoredSiteBlocking()", context),
    runInContext("loadNoisePreference()", context)
  ]);
  assert.equal(storageWrites.length, coldStartStorageWrites,
    "verified persistent DNR and storage snapshots must not be rewritten on an MV3 worker cold start");
  assert.equal(dynamicRuleUpdates.length, coldStartDynamicRuleUpdates,
    "verified persistent DNR rules must not be reinstalled on an MV3 worker cold start");
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length, expiryAlarmCreateCount + 1,
    "a fresh service-worker instance must recreate the required expiry alarm even when DNR rules are already current");
  assert.equal(alarmClears.filter((name) => name === "vigil-rule-expiry").length, expiryAlarmClearCount + 1,
    "a fresh service-worker instance must reconcile any persisted expiry alarm before recreating it");

  installedDynamicRules = installedDynamicRules.filter((rule) => Number(rule.id) !== 10000);
  runInContext("siteRulesSignature = ''; coldStartDynamicRulesPromise = null", context);
  const updatesBeforeMissingDnrRule = dynamicRuleUpdates.length;
  await runInContext("pruneStoredSiteBlocking()", context);
  assert.equal(dynamicRuleUpdates.length, updatesBeforeMissingDnrRule + 1,
    "cold-start hydration must repair persistent DNR rules when verification finds one missing");

  await runInContext("syncNoiseBlocking(true)", context);
  runInContext("noiseRulesEnabled = null; coldStartDynamicRulesPromise = null", context);
  const writesBeforeNoiseHydration = storageWrites.length;
  const updatesBeforeNoiseHydration = dynamicRuleUpdates.length;
  await runInContext("loadNoisePreference()", context);
  assert.equal(storageWrites.length, writesBeforeNoiseHydration,
    "verified persistent noise-rule preference must not rewrite Chrome storage on cold start");
  assert.equal(dynamicRuleUpdates.length, updatesBeforeNoiseHydration,
    "verified persistent noise DNR rules must not be reinstalled on cold start");
  installedDynamicRules = installedDynamicRules.filter((rule) => Number(rule.id) !== 9100);
  runInContext("noiseRulesEnabled = null; coldStartDynamicRulesPromise = null", context);
  await runInContext("loadNoisePreference()", context);
  assert.equal(dynamicRuleUpdates.length, updatesBeforeNoiseHydration + 1,
    "cold-start noise hydration must repair a missing managed DNR rule instead of trusting storage alone");

  Object.assign(context, {
    changedExpiryAllowlistRules: [{
      excludedDomains: ["localhost", "::1", "127.0.0.1"],
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2098-01-01T00:00:00.000Z"
    }]
  });
  await runInContext("syncSiteBlocking(testRules, testContentRules, changedExpiryAllowlistRules)", context);
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length, expiryAlarmCreateCount + 2,
    "a changed earliest rule expiry must replace the Chrome expiry alarm");
  assert.equal(alarmClears.filter((name) => name === "vigil-rule-expiry").length, expiryAlarmClearCount + 2);

  Object.assign(context, {
    expiredRules: [{
      domain: "expired.example",
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2000-01-01T00:00:00.000Z"
    }]
  });
  const createsBeforeExpiredRules = alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length;
  await runInContext("syncSiteBlocking(expiredRules, [], [])", context);
  assert.equal(alarmClears.filter((name) => name === "vigil-rule-expiry").length, expiryAlarmClearCount + 3,
    "when the final expiring rule disappears, its persisted Chrome alarm must be cleared");
  assert.equal(alarmCreates.filter((alarm) => alarm.name === "vigil-rule-expiry").length, createsBeforeExpiredRules,
    "expired rules must not schedule a replacement alarm");
  await runInContext("syncSiteBlocking(expiredRules, [], [])", context);
  assert.equal(alarmClears.filter((name) => name === "vigil-rule-expiry").length, expiryAlarmClearCount + 3,
    "an unchanged empty expiry set must not repeatedly clear Chrome alarms");

  const writesBeforeRuleFetchFailure = storageWrites.length;
  ruleFetchFailure = "local server unavailable";
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 1,
    "the first rule-fetch failure must persist stale fallback telemetry");
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 1,
    "an identical repeated rule-fetch failure must not rewrite its timestamp every poll");
  ruleFetchFailure = "local server timed out";
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 2,
    "a changed rule-fetch error must refresh persisted failure telemetry");
  runInContext("siteRuleCount += 1", context);
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 3,
    "a changed fallback rule count must refresh persisted failure telemetry");
  runInContext("siteRuleCount = 0", context);
  ruleFetchFailure = "";
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 4,
    "the first successful fetch after an outage must clear stale failure telemetry once");
  await runInContext("syncSiteBlockingFromServer()", context);
  assert.equal(storageWrites.length, writesBeforeRuleFetchFailure + 4,
    "steady successful rule fetches must not rewrite recovery telemetry");

  dynamicRuleUpdateFailure = true;
  runInContext("siteRulesSignature = 'force-dynamic-rule-retry'", context);
  await runInContext("syncSiteBlockingFromServer()", context);
  const failedDynamicRuleStatus = recordValue(storage.siteBlockRules, "failed dynamic-rule status");
  assert.equal(failedDynamicRuleStatus.error, "Dynamic rule update failed",
    "a successful server fetch must not clear a failed local DNR reconciliation");
  assert.equal(Boolean(failedDynamicRuleStatus.staleAt), true);
  dynamicRuleUpdateFailure = false;
  await runInContext("syncSiteBlockingFromServer()", context);
  const recoveredDynamicRuleStatus = recordValue(storage.siteBlockRules, "recovered dynamic-rule status");
  assert.equal(recoveredDynamicRuleStatus.error, undefined);
  assert.equal(recoveredDynamicRuleStatus.staleAt, undefined);

  const oldRuleFetch = deferredValue<Response>();
  const latestRuleFetch = deferredValue<Response>();
  const persistentRuleUntil = "until the tamper alarm is cleared";
  const oldServerRule = {
    domain: "old-snapshot.example",
    redirectUrl: "http://127.0.0.1:8787/blocked",
    until: persistentRuleUntil
  };
  const latestServerRule = {
    domain: "latest-snapshot.example",
    redirectUrl: "http://127.0.0.1:8787/blocked",
    until: persistentRuleUntil
  };
  const serverRuleResponse = (rule: typeof oldServerRule) => new Response(JSON.stringify({
    rules: [rule],
    contentRules: [],
    allowlistRules: [],
    dynamicRuleCount: 1,
    dynamicRuleSignature: JSON.stringify({
      site: [rule],
      content: [],
      allowlist: [],
      localServerAllow: false
    })
  }), { status: 200 });
  queuedRuleFetches.push(oldRuleFetch.promise, latestRuleFetch.promise);
  const ruleFetchesBeforeLatestWins = ruleFetchCount;
  const ruleWritesBeforeLatestWins = storageWrites.length;
  const dynamicUpdatesBeforeLatestWins = dynamicRuleUpdates.length;
  const firstRuleSync = runInContext("syncSiteBlockingFromServer()", context) as Promise<void>;
  await waitForCondition(() => ruleFetchCount === ruleFetchesBeforeLatestWins + 1);
  const secondRuleSync = runInContext("syncSiteBlockingFromServer()", context) as Promise<void>;
  assert.equal(ruleFetchCount, ruleFetchesBeforeLatestWins + 1,
    "overlapping rule-sync requests must share the active fetch");
  oldRuleFetch.resolve(serverRuleResponse(oldServerRule));
  await waitForCondition(() => ruleFetchCount === ruleFetchesBeforeLatestWins + 2);
  latestRuleFetch.resolve(serverRuleResponse(latestServerRule));
  await Promise.all([firstRuleSync, secondRuleSync]);
  const latestWinsSnapshots = storageWrites.slice(ruleWritesBeforeLatestWins)
    .filter((write) => Object.hasOwn(write, "siteBlockRuleSnapshot"));
  assert.equal(latestWinsSnapshots.length, 1,
    "a superseded rule response must not persist its snapshot");
  assert.match(JSON.stringify(latestWinsSnapshots[0]), /latest-snapshot\.example/u);
  assert.doesNotMatch(JSON.stringify(latestWinsSnapshots[0]), /old-snapshot\.example/u);
  const latestWinsUpdates = dynamicRuleUpdates.slice(dynamicUpdatesBeforeLatestWins);
  assert.equal(latestWinsUpdates.length, 1,
    "only the latest overlapping server snapshot should reconcile managed DNR rules");
  assert.match(JSON.stringify(latestWinsUpdates[0]), /latest-snapshot\.example/u);
  assert.doesNotMatch(JSON.stringify(latestWinsUpdates[0]), /old-snapshot\.example/u);

  const protectedBeforeStaleApply = {
    domain: "protected-before-stale-apply.example",
    redirectUrl: "http://127.0.0.1:8787/blocked",
    until: persistentRuleUntil
  };
  Object.assign(context, { protectedBeforeStaleApply });
  await runInContext("syncSiteBlocking([protectedBeforeStaleApply], [], [])", context);
  const protectedSnapshot = JSON.stringify(storage.siteBlockRuleSnapshot);
  assert.match(JSON.stringify(installedDynamicRules), /protected-before-stale-apply\.example/u);

  dynamicRuleReadFailure = true;
  const updatesBeforeUnverifiableReplacement = dynamicRuleUpdates.length;
  const unverifiableReplacement = await runInContext(
    "syncSiteBlocking([], [], [])",
    context
  ) as Record<string, unknown>;
  dynamicRuleReadFailure = false;
  assert.equal(unverifiableReplacement.ok, false);
  assert.match(String(unverifiableReplacement.error || ""), /could not be verified/u);
  assert.equal(dynamicRuleUpdates.length, updatesBeforeUnverifiableReplacement,
    "an unverified current DNR state must be left untouched instead of accepting an un-restorable replacement");
  assert.match(JSON.stringify(installedDynamicRules), /protected-before-stale-apply\.example/u);
  assert.equal(JSON.stringify(storage.siteBlockRuleSnapshot), protectedSnapshot);

  dynamicRuleUpdateFailure = true;
  const failedReplacement = await runInContext(
    "syncSiteBlocking([], [], [])",
    context
  ) as Record<string, unknown>;
  dynamicRuleUpdateFailure = false;
  assert.equal(failedReplacement.ok, false);
  assert.equal(failedReplacement.error, "Dynamic rule update failed");
  assert.match(JSON.stringify(installedDynamicRules), /protected-before-stale-apply\.example/u);
  assert.equal(
    JSON.stringify(storage.siteBlockRuleSnapshot),
    protectedSnapshot,
    "a failed DNR replacement must not leave storage pointing at rules Chrome never installed"
  );

  const emptyRuleResponse = new Response(JSON.stringify({
    rules: [],
    contentRules: [],
    allowlistRules: [],
    dynamicRuleCount: 0,
    dynamicRuleSignature: JSON.stringify({
      site: [],
      content: [],
      allowlist: [],
      localServerAllow: false
    })
  }), { status: 200 });
  const restoredLatestRule = {
    domain: "restored-latest.example",
    redirectUrl: "http://127.0.0.1:8787/blocked",
    until: persistentRuleUntil
  };
  const pendingLatestApplyFetch = deferredValue<Response>();
  const emptyRuleFetchPromise = Promise.resolve(emptyRuleResponse);
  queuedRuleFetches.push(emptyRuleFetchPromise, pendingLatestApplyFetch.promise);
  delayNextDynamicRuleUpdate = true;
  const ruleFetchesBeforeStaleApply = ruleFetchCount;
  const staleApplySync = runInContext("syncSiteBlockingFromServer()", context) as Promise<void>;
  await waitForCondition(() => delayedDynamicRuleUpdateCallback !== null);
  assert.doesNotMatch(
    JSON.stringify(installedDynamicRules),
    /protected-before-stale-apply\.example/u,
    "the delayed stale application fixture must reach Chrome after removing the prior protected rules"
  );

  const latestApplySync = runInContext("syncSiteBlockingFromServer()", context) as Promise<void>;
  const finishStaleDynamicRuleUpdate = must(
    delayedDynamicRuleUpdateCallback as (() => void) | null,
    "delayed stale dynamic-rule update"
  );
  delayedDynamicRuleUpdateCallback = null;
  finishStaleDynamicRuleUpdate();
  await waitForCondition(() => ruleFetchCount === ruleFetchesBeforeStaleApply + 2);
  assert.match(
    JSON.stringify(installedDynamicRules),
    /protected-before-stale-apply\.example/u,
    "a superseded in-flight application must restore the previously installed managed rules before waiting on the newer fetch"
  );
  assert.equal(
    JSON.stringify(storage.siteBlockRuleSnapshot),
    protectedSnapshot,
    "a superseded in-flight application must restore the previous persisted snapshot"
  );

  pendingLatestApplyFetch.resolve(serverRuleResponse(restoredLatestRule));
  await Promise.all([staleApplySync, latestApplySync]);
  assert.match(JSON.stringify(installedDynamicRules), /restored-latest\.example/u);
  assert.doesNotMatch(JSON.stringify(installedDynamicRules), /protected-before-stale-apply\.example/u);

  assert.equal(runInContext("normalizedRuleUntil(PERSISTENT_RULE_UNTIL)", context), persistentUntil);
  assert.equal(runInContext("duplicateCheckKey(1, 'https://example.com/', 'heartbeat', 5, {})", context), null);
  assert.equal(runInContext("duplicateCheckKey(1, 'https://example.com/', 'navigation', 1, {})", context), null);
  assert.notEqual(runInContext("duplicateCheckKey(1, 'https://example.com/', 'navigation', 0, {})", context), null);

  await runInContext("rememberPulseFlags({ focusedSocialCleanupEnabled: true, focusedSocialCleanupSettings: { enabled: true } })", context);
  runInContext("cachedPulseFlags = {}", context);
  await runInContext("loadPulseFlags()", context);
  const offline = runInContext("offlineCheckResult()", context) as Record<string, unknown>;
  assert.equal(offline.offline, true);
  assert.equal(offline.focusedSocialCleanupEnabled, true);
  assert.equal(alarmCreates.some((alarm) => alarm.name === "vigil-rule-expiry"), true);
}
