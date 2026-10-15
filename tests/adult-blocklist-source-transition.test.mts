import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-source-transition-"));
process.env.VIGIL_DATA_DIR = dataDir;
const {
  ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH,
  adultBlocklistPreloadDomains,
  adultBlocklistSummary,
  adultBlocklistSnapshotRequiredButUnavailable,
  clearAdultBlocklistCacheForTest,
  commitAdultBlocklistRefresh,
  matchAdultBlocklistHost,
  prepareAdultBlocklistRefresh,
  syncAdultBlocklistPhoneArtifact,
  writeAdultBlocklistPhoneArtifact
} = await import("../src/adultBlocklist.js");
const { decodePhoneBlocklistArtifact, phoneBlocklistMatchesHost } = await import("../src/adultBlocklistPhoneArtifact.js");
const { defaultState } = await import("../src/defaults.js");
const { handleAdultBlocklistApiRoute } = await import("../src/server/adultBlocklistRoutes.js");
const { handleSettingsApiRoute } = await import("../src/server/settingsRoutes.js");
const { policyForSample } = await import("../src/monitor/policy.js");
const { Monitor } = await import("../src/monitor.js");
const { evaluateExtensionCheck } = await import("../src/extensionPolicy.js");

const now = new Date("2026-10-13T12:00:00-04:00");
const state = defaultState();
state.settings.adultBlocklistSourceId = "custom";
state.settings.adultBlocklistCustomUrl = "https://policy-source.example/old.txt";
const oldDomain = "listed-only.old-policy.example";
const newDomain = "listed-only.new-policy.example";
function sourceHooks(domain: string) {
  return {
    resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
    request: async () => ({
      statusCode: 200, headers: {},
      body: Readable.from([[domain, ...Array.from({ length: 1_000 }, (_, index) => `listed-${index}.${domain}`)].join("\n")]),
      destroy: () => {}
    }),
    ianaTldRegistryText: null
  };
}

try {
  const originalPreparation = await prepareAdultBlocklistRefresh(state, now, sourceHooks(oldDomain));
  assert.equal(originalPreparation.error, null);
  await commitAdultBlocklistRefresh(state, originalPreparation);
  await writeAdultBlocklistPhoneArtifact(state);
  const originalArtifact = await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH);
  const originalSnapshot = structuredClone(state.adultBlocklist);

  const legacy = structuredClone(state);
  legacy.adultBlocklist.source = null;
  const legacyResponse = response();
  await handleSettingsApiRoute(request("/api/settings", {
    adultBlocklistCustomUrl: "https://policy-source.example/legacy-next.txt"
  }), legacyResponse, { state: legacy });
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(adultBlocklistSummary(legacy).source?.url, originalSnapshot.source?.url,
    "legacy provenance must be recovered from the verified previous snapshot before selecting its replacement");
  clearAdultBlocklistCacheForTest();
  assert.equal(matchAdultBlocklistHost(legacy, oldDomain)?.domain, oldDomain);

  let sourceOnlyArtifactEffects = 0;
  const sourceChange = response();
  await handleAdultBlocklistApiRoute(request("/api/adult-blocklist/settings", {
    adultBlocklistCustomUrl: "https://policy-source.example/new.txt"
  }), sourceChange, {
    state, currentState: () => state,
    afterCommit: () => { sourceOnlyArtifactEffects += 1; }
  });
  assert.equal(sourceChange.statusCode, 200);
  assert.equal(sourceOnlyArtifactEffects, 0, "selecting a source must not enqueue artifact deletion or replacement");
  assert.deepEqual(committedSnapshot(), committedSnapshot(originalSnapshot), "source selection must retain committed snapshot provenance");
  assert.deepEqual(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH), originalArtifact);
  const pendingSummary = adultBlocklistSummary(state);
  assert.equal(pendingSummary.current, false, "selected source must accurately show that refresh is pending");
  assert.equal(pendingSummary.stale, true);
  assert.equal(pendingSummary.ready, true, "the prior verified source remains enforceable");
  assert.equal(pendingSummary.source?.url, originalSnapshot.source?.url);
  assert.equal(pendingSummary.selectedSourceUrl, state.settings.adultBlocklistCustomUrl);
  assert.match(pendingSummary.detail, /previous verified adult blocklist remains active/);

  clearAdultBlocklistCacheForTest();
  assert.equal(matchAdultBlocklistHost(state, oldDomain)?.domain, oldDomain, "disk recovery must retain the committed source");
  assert.equal(adultBlocklistPreloadDomains(state).includes(oldDomain), true);
  assert.equal(policyForSample(state, {}, { app: "Safari", hostname: oldDomain, url: `https://${oldDomain}/` }, now)?.kind, "adult-blocklist");
  assert.equal(evaluateExtensionCheck(state, {}, { url: `https://${oldDomain}/`, event: "inspection" }, now).blocked, true);
  await syncAdultBlocklistPhoneArtifact(state);
  assert.equal(phoneBlocklistMatchesHost(decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH)), oldDomain), oldDomain);

  await assert.rejects(commitAdultBlocklistRefresh(state, originalPreparation), /source changed while the refresh/,
    "an old in-flight fetch cannot commit after a newer source selection");
  const failedFetch = await prepareAdultBlocklistRefresh(state, now, {
    ...sourceHooks(newDomain), request: async () => { throw new Error("Replacement source unavailable"); }
  });
  await assert.rejects(commitAdultBlocklistRefresh(state, failedFetch), /Replacement source unavailable/);
  assert.deepEqual(committedSnapshot(), committedSnapshot(originalSnapshot));
  assert.equal(matchAdultBlocklistHost(state, oldDomain)?.domain, oldDomain);
  assert.deepEqual(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH), originalArtifact);

  const replacement = await prepareAdultBlocklistRefresh(state, now, sourceHooks(newDomain));
  assert.equal(replacement.error, null);
  await assert.rejects(commitAdultBlocklistRefresh(state, replacement, {
    buildPhoneArtifact: () => { throw new Error("Replacement phone artifact failed validation"); }
  }), /phone artifact failed validation/);
  assert.deepEqual(committedSnapshot(), committedSnapshot(originalSnapshot));
  assert.equal(matchAdultBlocklistHost(state, oldDomain)?.domain, oldDomain);
  assert.deepEqual(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH), originalArtifact);

  // The generic settings route must preserve the same transaction boundary.
  const genericResponse = response();
  await handleSettingsApiRoute(request("/api/settings", {
    adultBlocklistCustomUrl: "https://policy-source.example/third.txt"
  }), genericResponse, { state });
  assert.equal(genericResponse.statusCode, 200);
  assert.deepEqual(committedSnapshot(), committedSnapshot(originalSnapshot));
  clearAdultBlocklistCacheForTest();
  assert.equal(matchAdultBlocklistHost(state, oldDomain)?.domain, oldDomain);

  const verifiedReplacement = await prepareAdultBlocklistRefresh(state, now, sourceHooks(newDomain));
  await commitAdultBlocklistRefresh(state, verifiedReplacement);
  await syncAdultBlocklistPhoneArtifact(state);
  assert.equal(adultBlocklistSummary(state).current, true);
  assert.equal(matchAdultBlocklistHost(state, newDomain)?.domain, newDomain);
  assert.equal(matchAdultBlocklistHost(state, oldDomain), null);
  const newArtifact = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(newArtifact, newDomain), newDomain);
  assert.equal(phoneBlocklistMatchesHost(newArtifact, oldDomain), "");

  // A broken committed cache must not delete the last validated phone artifact.
  const validArtifact = await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH);
  await rm(state.adultBlocklist.snapshotPath);
  clearAdultBlocklistCacheForTest();
  assert.equal(adultBlocklistSnapshotRequiredButUnavailable(state), true);
  const remote = { app: "Safari", hostname: "ordinary.example", url: "https://ordinary.example/documents" };
  assert.equal(policyForSample(state, {}, remote, now)?.browserControl?.area, "adult-blocklist-recovery",
    "a missing committed cache must fail closed even for an unknown remote destination");
  assert.equal(policyForSample(state, {}, { ...remote, hostname: "127.0.0.1", url: "http://127.0.0.1:8787/blocked" }, now), null,
    "the local recovery block page remains available");
  assert.equal(policyForSample(state, {}, { ...remote, hostname: "127.0.0.1", url: "http://127.0.0.1:3000/proxy" }, now)?.browserControl?.area,
    "adult-blocklist-recovery", "arbitrary local proxy pages must not become recovery exemptions");
  const recoveryRedirects: string[] = [];
  const recoveryMonitor = new Monitor({ state, usage: {}, browserActivityNow: () => now.getTime(),
    browserRedirect: async (_app, target, options = {}) => {
      assert.equal(options.currentUrl, remote.url);
      recoveryRedirects.push(target);
      return { ok: true, matched: true, redirectedTabCount: 1 };
    }
  });
  const recoveryDecision = recoveryMonitor.browserBlockDecision(remote);
  assert.ok(recoveryDecision, "snapshot loss must dispatch the immediate native recovery redirect");
  const recoveryTarget = recoveryMonitor.blockedPageTarget(recoveryDecision.front, recoveryDecision.policy, recoveryDecision.options);
  const recoveryPayload = { app: remote.app, hostname: recoveryDecision.front.hostname, currentUrl: remote.url, url: recoveryTarget };
  assert.equal(recoveryMonitor.durableEffectApplicable("redirect-browser", recoveryPayload, now), true);
  await recoveryMonitor.enforce(remote);
  assert.equal(recoveryRedirects.length, 1, "the routine path must act on cache-loss policy");
  assert.equal(adultBlocklistSnapshotRequiredButUnavailable(defaultState()), false,
    "a fresh installation must not invent a missing committed snapshot");
  await assert.rejects(syncAdultBlocklistPhoneArtifact(state), /retaining the existing phone artifact/);
  assert.deepEqual(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH), validArtifact);
  const recovery = await prepareAdultBlocklistRefresh(state, now, sourceHooks(newDomain));
  await commitAdultBlocklistRefresh(state, recovery);
  assert.equal(adultBlocklistSnapshotRequiredButUnavailable(state), false);
  assert.equal(policyForSample(state, {}, remote, now), null, "verified repair releases the temporary remote browsing recovery block");
  assert.equal(recoveryMonitor.durableEffectApplicable("redirect-browser", recoveryPayload, now), false,
    "a successfully repaired snapshot must retire pending recovery redirects");
} finally {
  clearAdultBlocklistCacheForTest();
  await rm(dataDir, { recursive: true, force: true });
}

function committedSnapshot(value = state.adultBlocklist) {
  const { hash, snapshotPath, domainCount, activeDomainCount, source, lastRefreshAt } = value;
  return { hash, snapshotPath, domainCount, activeDomainCount, source, lastRefreshAt };
}

function request(url: string, body: object): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST", url, headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}

function response(): ServerResponse {
  const target: { statusCode: number; writeHead(status: number): unknown; end(): unknown } = {
    statusCode: 200,
    writeHead(status: number) { this.statusCode = status; return this; },
    end() { return this; }
  };
  return target as unknown as ServerResponse;
}

console.log("Adult source changes retain verified native/browser/phone restrictions through failed refreshes and artifact validation; replacement is committed atomically.");
