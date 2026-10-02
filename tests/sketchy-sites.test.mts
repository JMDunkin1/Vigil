import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { completeSketchySiteLookup, lookupDomainRegistration, matchSketchySite, observeSafariContentBlockerError, registeredDomain, registrationDateFromRdap } from "../src/sketchySites.js";
import { safariContentBlockerEvidenceMatches } from "../src/macos.js";
import { Monitor, browserActivityPolicyFingerprint } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import { publicState } from "../src/server/statePayload.js";
import { policyForSample } from "../src/monitor/policy.js";
import { evaluateExtensionCheck, extensionRuleSnapshot, safeBackUrl } from "../src/extensionPolicy.js";
import { updateSettings } from "../src/server/settingsRoutes.js";
import { isProtectedSetting, verifyStateTextSeal } from "../src/seal.js";
import { loadState, saveState, STATE_PATH, STATE_SEAL_PATH, STATE_SEAL_KEY_PATH } from "../src/store.js";
import { readFile } from "node:fs/promises";

const now = new Date("2026-10-01T22:00:00Z");
const domain = "vigil-risk-fixture.com";
const url = `https://jk45.${domain}/offer?private-query=never-send`;
const state = defaultState();
assert.equal(state.settings.sketchySiteMaxAgeDays, 14);
assert.equal(registeredDomain(url), domain);
assert.equal(registeredDomain("https://a.brand-new.co.uk/path"), "brand-new.co.uk");
assert.equal(registeredDomain("https://a.brand.ck/"), "a.brand.ck", "wildcard public suffixes are honored");
assert.equal(registeredDomain("https://x.www.ck/"), "www.ck", "public suffix exceptions are honored");
assert.equal(registeredDomain("https://new.github.io/"), "github.io", "private hosting does not create a registry registration");
for (const invalid of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "https://co.uk/", "https://a.invalid/", "https://under_score.com/"]) assert.equal(registeredDomain(invalid), "");

assert.equal(matchSketchySite(state, url, now), null, "youth alone never creates a restriction");
assert.equal(safariContentBlockerEvidenceMatches({ contentBlockerError: true, url }, url), true);
assert.equal(safariContentBlockerEvidenceMatches({ contentBlockerError: false, url }, url), false);
assert.equal(safariContentBlockerEvidenceMatches({ contentBlockerError: true, url: "https://other.com/" }, url), false, "a tab change cannot attribute the error to another site");
assert.equal(safariContentBlockerEvidenceMatches({ contentBlockerError: true, url: "file:///tmp/a" }, "file:///tmp/a"), false);

const beforeObservation = browserActivityPolicyFingerprint(state, {}, now);
observeSafariContentBlockerError(state, url, now);
assert.notEqual(browserActivityPolicyFingerprint(state, {}, now), beforeObservation, "new evidence changes the foreground policy generation");
assert.equal(publicState(state, null).sketchySites.length, 1, "the dashboard receives the real evidence count");
assert.match(matchSketchySite(state, url, now)!.label, /checking/u);
observeSafariContentBlockerError(state, `https://other.${domain}/`, now);
assert.equal(state.sketchySites.length, 1, "registration lookups are shared across subdomains");
const registration = (ageDays: number) => ({ registeredAt: new Date(now.getTime() - ageDays * 86_400_000).toISOString(), checkedAt: now.toISOString(), lookupStatus: "verified" as const, lookupError: "" });
completeSketchySiteLookup(state, domain, registration(13.999));
assert.ok(matchSketchySite(state, `http://another.${domain}/`, now));
assert.equal(matchSketchySite(state, `https://${domain}.example.org/`, now), null);
assert.equal(policyForSample(state, {}, { app: "Safari", url, hostname: `jk45.${domain}` }, now)?.browserControl?.area, "sketchy-site");
const monitor = new Monitor({ state, usage: {}, externalEffectsEnabled: false, browserActivityNow: () => now.getTime() });
const decision = monitor.browserBlockDecision({ app: "Safari", url, hostname: `jk45.${domain}` });
assert.ok(decision, "Vigil enforces the remembered rule with Safari's content blockers bypassed");
assert.equal(new URL(monitor.blockedPageTarget(decision.front, decision.policy, decision.options)).pathname, "/blocked");
assert.equal(evaluateExtensionCheck(state, {}, { url, event: "inspection" }, now).blocked, true);
assert.equal(safeBackUrl(state, {}, url, null, now), "", "return links cannot bypass a cached restriction");
assert.ok(extensionRuleSnapshot(state, now).rules.some(rule => rule.domain === domain));

completeSketchySiteLookup(state, domain, registration(14));
assert.equal(matchSketchySite(state, url, now), null, "exactly 14 days is outside an under-14-days rule");
assert.equal(extensionRuleSnapshot(state, now).rules.some(rule => rule.domain === domain), false);
updateSettings(state.settings, { sketchySiteMaxAgeDays: 21 });
assert.ok(matchSketchySite(state, url, now), "changing the threshold reevaluates saved evidence");
completeSketchySiteLookup(state, domain, registration(40));
assert.equal(matchSketchySite(state, url, now), null, "old domains do not qualify under this rule");

completeSketchySiteLookup(state, domain, { registeredAt: null, checkedAt: now.toISOString(), lookupStatus: "unavailable", lookupError: "Registry unavailable" });
assert.match(matchSketchySite(state, url, now)!.label, /unavailable/u, "an unknown age is never described as young");
assert.ok(isProtectedSetting("sketchySiteMaxAgeDays"));
updateSettings(state.settings, { sketchySiteMaxAgeDays: 0 });
assert.equal(state.settings.sketchySiteMaxAgeDays, 1, "zero cannot disable the rule");

const rdap = { objectClassName: "domain", ldhName: domain.toUpperCase(), events: [
  { eventAction: "last changed", eventDate: now.toISOString() },
  { eventAction: "registration", eventDate: registration(7).registeredAt }
] };
assert.equal(registrationDateFromRdap(rdap, domain, now), registration(7).registeredAt);
assert.equal(registrationDateFromRdap({ ...rdap, ldhName: "wrong.com" }, domain, now), null);
assert.equal(registrationDateFromRdap({ ...rdap, events: [{ eventAction: "last changed", eventDate: now.toISOString() }] }, domain, now), null, "recent updates are not registration dates");
assert.equal(registrationDateFromRdap({ ...rdap, events: [{ eventAction: "registration", eventDate: "2027-01-01T00:00:00Z" }] }, domain, now), null);
const requested: string[] = [];
const lookup = await lookupDomainRegistration(domain, async (input, options) => {
  requested.push(String(input));
  assert.equal(options?.redirect, "error");
  return new Response(JSON.stringify(rdap));
});
assert.equal(lookup.lookupStatus, "verified");
assert.deepEqual(requested, [`https://rdap.verisign.com/com/v1/domain/${domain}`], "only the registered domain is sent to the official registry");
const unavailable = await lookupDomainRegistration(domain, async () => new Response("Rate limited", { status: 429 }));
assert.equal(unavailable.lookupStatus, "unavailable");
assert.equal(unavailable.registeredAt, null);
const unsupportedState = defaultState();
for (const destination of ["https://new.unknown-test-tld/", "http://192.0.2.7/"]) {
  const evidence = observeSafariContentBlockerError(unsupportedState, destination, now)!;
  assert.ok(evidence);
  const result = await lookupDomainRegistration(evidence.domain, async () => { throw new Error("An unsupported registration must not make a network request"); });
  completeSketchySiteLookup(unsupportedState, evidence.domain, result);
  assert.equal(result.lookupStatus, "unavailable");
  assert.ok(matchSketchySite(unsupportedState, destination, now), "a missing registry or suffix cannot bypass unknown-age blocking");
}
assert.equal(observeSafariContentBlockerError(unsupportedState, "http://127.0.0.1:8787/blocked", now), null, "Vigil's own local pages stay reachable");

// Exercise the actual monitor trigger with a stubbed registry, rather than
// assuming every URL inspection is allowed to initiate a lookup.
const originalFetch = globalThis.fetch;
let networkLookups = 0;
try {
  globalThis.fetch = async () => {
    networkLookups += 1;
    return new Response(JSON.stringify({ ...rdap, events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] }));
  };
  const triggerState = defaultState();
  triggerState.settings.intentionalUseEnabled = false;
  const triggerMonitor = new Monitor({ state: triggerState, usage: {} });
  const sample = { app: "Safari", url, hostname: `jk45.${domain}` };
  await triggerMonitor.enforce(sample);
  assert.equal(networkLookups, 0, "ordinary visits do not query a registry");
  await triggerMonitor.enforce({ ...sample, safariContentBlockerError: true });
  assert.equal(networkLookups, 1, "only the native blocker-error signal initiates a lookup");
  await triggerMonitor.enforce({ ...sample, safariContentBlockerError: true });
  assert.equal(networkLookups, 1, "repeat errors reuse the successful cache");
  triggerState.sketchySites[0]!.checkedAt = "2020-01-01T00:00:00Z";
  await triggerMonitor.enforce(sample);
  await triggerMonitor.refreshSketchySiteRegistrations();
  assert.equal(networkLookups, 1, "an expired cache is not a reason to poll history or normal visits");
  await triggerMonitor.enforce({ ...sample, safariContentBlockerError: true });
  assert.equal(networkLookups, 2, "a later blocker error can refresh an expired cache");
} finally { globalThis.fetch = originalFetch; }

for (const switchAway of [false, true]) {
  const queuedState = defaultState();
  const usage = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(queuedState, usage, [], async () => { snapshotWrites += 1; });
  const queuedMonitor = new Monitor({
    state: queuedState, usage, externalEffectsEnabled: false, browserActivityNow: () => now.getTime(),
    mutate: async (operation, options) => coordinator.run(
      ({ state: draft, usage: draftUsage, afterCommit, requestPersistence }) => operation(draft, draftUsage, afterCommit, requestPersistence), options
    )
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  void queuedMonitor.enqueueOperation(async () => gate);
  let hasError = true;
  let currentUrl = url;
  queuedMonitor.readFrontmost = async () => ({ ok: true, app: "Safari", url: currentUrl,
    hostname: new URL(currentUrl).hostname, safariContentBlockerError: hasError });
  const enforcedUrls: string[] = [];
  queuedMonitor.enforce = async front => { enforcedUrls.push(front.url); };
  await queuedMonitor.probeBrowserActivity();
  assert.equal(queuedState.sketchySites.length, 0, "queued evidence uses transactional state rather than mutating the committed snapshot");
  hasError = false; // Safari's Reload Without Content Blockers clears the error.
  if (switchAway) {
    currentUrl = "https://ordinary.example.com/";
    queuedMonitor.breakBrowserActivityContinuity();
  }
  release();
  await queuedMonitor.operationTail;
  assert.equal(queuedState.sketchySites[0]?.domain, domain,
    "a confirmed blocker error survives both reload and a change of browsing continuity");
  assert.equal(queuedState.sketchySites[0]?.observedAt, now.toISOString());
  assert.ok(snapshotWrites > 0, "the original blocker evidence is durably committed");
  if (switchAway) assert.deepEqual(enforcedUrls, [], "the original evidence cannot enforce a stale foreground target");
  else assert.deepEqual(enforcedUrls, [url], "foreground enforcement still uses the fresh blocker-bypassed sample");
  assert.ok(queuedMonitor.browserBlockDecision({ app: "Safari", url, hostname: new URL(url).hostname }),
    "remembered evidence protects later visits with content blockers bypassed");
  coordinator.stopAdmission();
  await coordinator.drain();
}

completeSketchySiteLookup(state, domain, registration(7));
await saveState(state);
const restored = await loadState();
assert.equal(restored.sketchySites[0]!.registeredAt, registration(7).registeredAt, "evidence survives restart");
const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
raw.sketchySites = [];
assert.equal((await verifyStateTextSeal(JSON.stringify(raw), { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH })).ok, false, "removing evidence cannot be repaired as harmless bookkeeping");
console.log("New-domain risk policy: native evidence binding, PSL, RDAP, age boundaries, protected settings and restart integrity passed.");
