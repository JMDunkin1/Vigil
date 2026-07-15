import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  assertSafeAdultBlocklistUrl,
  ADULT_BLOCKLIST_SOURCES,
  adultBlocklistPreloadDomains,
  adultBlocklistSource,
  adultBlocklistSummary,
  clearAdultBlocklistCacheForTest,
  fetchAdultBlocklistSourceTextForTest,
  invalidateAdultBlocklistIfSourceChanged,
  matchAdultBlocklistHost,
  normalizeAdultDomain,
  normalizeAdultDomainList,
  parseAdultBlocklistDomains,
  refreshAdultBlocklist,
  setAdultBlocklistDomainsForTest,
  setAdultBlocklistSnapshotCandidatesForTest,
  writeAdultBlocklistPhoneArtifact
} from "../src/adultBlocklist.js";
import type { AdultBlocklistPinnedResponse } from "../src/adultBlocklist.js";
import {
  decodePhoneBlocklistArtifact,
  phoneBlocklistMatchesHost
} from "../src/adultBlocklistPhoneArtifact.js";
import {
  DEFAULT_ADULT_BLOCKLIST_SOURCE_ID,
  MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS,
  SOFT_BLOCK_PROFILE_ID,
  defaultState
} from "../src/defaults.js";
import { evaluateExtensionCheck, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { buildHostsBlock } from "../src/hardening.js";
import { iosPolicyTargets } from "../src/iosProfiles.js";
import { explainRuleDecision } from "../src/ruleSimulator.js";
import { safariFilterDenyUrls } from "../src/safariFilter.js";
import { writeFileAtomically } from "../src/snapshotFiles.js";
import { now, recordValue } from "./test-helpers.mjs";

await assert.rejects(() => assertSafeAdultBlocklistUrl(new URL("http://example.com/list.txt")), /HTTPS/);
await assert.rejects(() => assertSafeAdultBlocklistUrl(new URL("https://localhost/list.txt")), /local network/);
await assert.rejects(() => assertSafeAdultBlocklistUrl(new URL("https://127.0.0.1/list.txt")), /private network/);
await assert.rejects(() => assertSafeAdultBlocklistUrl(new URL("https://169.254.169.254/latest/meta-data")), /private network/);
await assert.rejects(() => assertSafeAdultBlocklistUrl(new URL("https://[fc00::1]/list.txt")), /private network/);

{
  let resolveCalls = 0;
  const requestedAddresses: string[] = [];
  const text = await fetchAdultBlocklistSourceTextForTest("https://source.example/list.txt", {
    resolve: async () => {
      resolveCalls += 1;
      return resolveCalls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    request: async (_url, address) => {
      requestedAddresses.push(address.address);
      return pinnedResponse(200, ["exampleadult.test\n"]);
    }
  });
  assert.equal(text, "exampleadult.test\n");
  assert.equal(resolveCalls, 1);
  assert.deepEqual(requestedAddresses, ["93.184.216.34"]);
}

{
  const resolvedHosts: string[] = [];
  const requestedHosts: string[] = [];
  let redirectDestroyed = false;
  await assert.rejects(
    () => fetchAdultBlocklistSourceTextForTest("https://source.example/list.txt", {
      resolve: async (hostname) => {
        resolvedHosts.push(hostname);
        return hostname === "source.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      request: async (url) => {
        requestedHosts.push(url.hostname);
        return pinnedResponse(302, [], { location: "https://redirect.example/private.txt" }, () => {
          redirectDestroyed = true;
        });
      }
    }),
    /private network/
  );
  assert.deepEqual(resolvedHosts, ["source.example", "redirect.example"]);
  assert.deepEqual(requestedHosts, ["source.example"]);
  assert.equal(redirectDestroyed, true);
}

{
  const requested: Array<{ hostname: string; address: string }> = [];
  const text = await fetchAdultBlocklistSourceTextForTest("https://source.example/list.txt", {
    resolve: async (hostname) => hostname === "source.example"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "1.1.1.1", family: 4 }],
    request: async (url, address) => {
      requested.push({ hostname: url.hostname, address: address.address });
      return requested.length === 1
        ? pinnedResponse(302, [], { location: "https://mirror.example/list.txt" })
        : pinnedResponse(200, ["redirected.exampleadult.test\n"]);
    }
  });
  assert.equal(text, "redirected.exampleadult.test\n");
  assert.deepEqual(requested, [
    { hostname: "source.example", address: "93.184.216.34" },
    { hostname: "mirror.example", address: "1.1.1.1" }
  ]);
}

{
  let destroyed = false;
  await assert.rejects(
    () => fetchAdultBlocklistSourceTextForTest("https://source.example/list.txt", {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => pinnedResponse(200, ["123", "456"], {}, () => {
        destroyed = true;
      }),
      maxBytes: 5
    }),
    /too large/
  );
  assert.equal(destroyed, true);
}

await assert.rejects(
  () => fetchAdultBlocklistSourceTextForTest("https://source.example/list.txt", {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_url, _address, signal) => await new Promise<AdultBlocklistPinnedResponse>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
    timeoutMs: 10
  }),
  /timed out/
);

const testSource = ADULT_BLOCKLIST_SOURCES[0];

{
  clearAdultBlocklistCacheForTest();
  const state = defaultState();
  assert.equal(matchAdultBlocklistHost(state, "media.pornhub.com")?.domain, "pornhub.com");
  assert.equal(matchAdultBlocklistHost(state, "media.pornhub.com")?.sourceId, "vigil-explicit");
  state.adultBlocklist.allowlist = ["pornhub.com"];
  assert.equal(matchAdultBlocklistHost(state, "media.pornhub.com"), null);
  state.adultBlocklist.allowlist = [];
  state.settings.adultBlocklistEnabled = false;
  assert.equal(matchAdultBlocklistHost(state, "media.pornhub.com"), null);
}

{
  const rotationDir = await mkdtemp(join(tmpdir(), "vigil-adult-snapshot-"));
  try {
    const currentPath = join(rotationDir, "adult-blocklist.json");
    await writeFile(currentPath, "old snapshot\n", "utf8");
    await writeFileAtomically(currentPath, "new snapshot\n");
    assert.equal(await readFile(currentPath, "utf8"), "new snapshot\n");
  } finally {
    await rm(rotationDir, { recursive: true, force: true });
  }
}

{
  const crashState = defaultState();
  const hashes = setAdultBlocklistSnapshotCandidatesForTest(
    ["new.exampleadult.test"],
    ["old.exampleadult.test"],
    testSource
  );
  crashState.adultBlocklist.hash = hashes.previousHash;
  crashState.adultBlocklist.snapshotPath = hashes.previousPath;
  crashState.adultBlocklist.source = {
    id: testSource.id,
    label: testSource.label,
    url: testSource.url,
    homepage: testSource.homepage,
    license: testSource.license
  };
  const recovered = adultBlocklistSummary(crashState);
  assert.equal(recovered.current, true);
  assert.equal(recovered.hash, hashes.previousHash);
  assert.equal(matchAdultBlocklistHost(crashState, "media.old.exampleadult.test")?.domain, "old.exampleadult.test");
  assert.equal(matchAdultBlocklistHost(crashState, "media.new.exampleadult.test"), null);
  clearAdultBlocklistCacheForTest();
}

try {
  setAdultBlocklistDomainsForTest([
    "exampleadult.test",
    "nested.exampleadult.test",
    "video.exampleexplicit.test"
  ], testSource);

  assert.deepEqual(parseAdultBlocklistDomains(`
# Comment
0.0.0.0 ExampleAdult.test
||video.exampleexplicit.test^
https://www.nested.exampleadult.test/path
localhost
bad_domain
`), [
    "exampleadult.test",
    "nested.exampleadult.test",
    "video.exampleexplicit.test"
  ]);
  assert.equal(normalizeAdultDomain("0.0.0.0 www.ExampleAdult.test"), "exampleadult.test");
  assert.deepEqual(normalizeAdultDomainList("www.ExampleAdult.test\nexampleadult.test"), ["exampleadult.test"]);

  const state = defaultState();
  state.settings.adultBlocklistPreloadLimit = 25;
  let match = matchAdultBlocklistHost(state, "media.exampleadult.test");
  assert.equal(match?.domain, "exampleadult.test");
  assert.equal(match?.sourceId, testSource.id);

  state.adultBlocklist.allowlist = ["exampleadult.test"];
  assert.equal(matchAdultBlocklistHost(state, "media.exampleadult.test"), null);
  assert.equal(matchAdultBlocklistHost(state, "video.exampleexplicit.test")?.domain, "video.exampleexplicit.test");
  assert.equal(adultBlocklistPreloadDomains(state).includes("exampleadult.test"), false);

  const phoneArtifactDir = await mkdtemp(join(tmpdir(), "vigil-adult-phone-artifact-"));
  try {
    const phoneArtifactPath = join(phoneArtifactDir, "adult-blocklist.sdi");
    const metadata = await writeAdultBlocklistPhoneArtifact(state, phoneArtifactPath);
    const phoneArtifact = decodePhoneBlocklistArtifact(await readFile(phoneArtifactPath));
    assert.equal(metadata.domainCount, 1);
    assert.equal(phoneBlocklistMatchesHost(phoneArtifact, "media.exampleadult.test"), "");
    assert.equal(phoneBlocklistMatchesHost(phoneArtifact, "nested.exampleadult.test"), "");
    assert.equal(phoneBlocklistMatchesHost(phoneArtifact, "video.exampleexplicit.test"), "video.exampleexplicit.test");
  } finally {
    await rm(phoneArtifactDir, { recursive: true, force: true });
  }
  state.adultBlocklist.allowlist = [];

  const summary = adultBlocklistSummary(state);
  assert.equal(summary.ready, true);
  assert.equal(summary.domainCount, 3);
  assert.equal(summary.preloadedDomainCount > 0, true);
  assert.equal(summary.selectedSourceId, DEFAULT_ADULT_BLOCKLIST_SOURCE_ID);
  state.adultBlocklist.hash = summary.hash;
  state.adultBlocklist.source = {
    id: testSource.id,
    label: testSource.label,
    url: testSource.url,
    homepage: testSource.homepage,
    license: testSource.license
  };
  assert.equal(adultBlocklistSummary(state).current, true);

  const blocked = evaluateExtensionCheck(state, {}, { url: "https://media.exampleadult.test/watch", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  assert.equal(recordValue(blocked.policy, "adult policy").kind, "adult-blocklist");

  const explained = explainRuleDecision(state, {}, { url: "https://media.exampleadult.test/watch", at: now.toISOString() });
  assert.equal(explained.blocked, true);
  assert.equal(explained.reasonCode, "adult-blocklist");
  assert.equal(explained.match?.domain, "exampleadult.test");

  const snapshot = extensionRuleSnapshot(state, now);
  assert.equal(snapshot.rules.some((rule) => rule.domain === "exampleadult.test" && rule.kind === "adult-blocklist"), true);
  assert.equal(snapshot.rules.length <= 300, true);

  const hosts = buildHostsBlock(state, now);
  assert.match(hosts, /0\.0\.0\.0 exampleadult\.test/);

  const safariUrls = safariFilterDenyUrls(state, now);
  assert.equal(safariUrls.includes("https://exampleadult.test/"), true);

  state.deviceControls.ios.enabled = true;
  const levelOneIosTargets = iosPolicyTargets(state, now);
  assert.equal(levelOneIosTargets.deniedUrls.includes("https://exampleadult.test/"), true);
  assert.equal(levelOneIosTargets.deniedUrls.includes("https://youtube.com/shorts"), true);
  const softProfile = state.profiles.find((profile) => profile.id === SOFT_BLOCK_PROFILE_ID);
  assert.ok(softProfile, "Soft Lock profile should exist");
  state.activeSessions.phone = {
    id: "adult-blocklist-phone-soft",
    title: "Phone Soft Lock",
    mode: "focus",
    profileId: softProfile.id,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: softProfile
  };
  const activeIosTargets = iosPolicyTargets(state, now);
  assert.equal(activeIosTargets.deniedUrls.includes("https://exampleadult.test/"), true);

  const previousSource = adultBlocklistSource(state);
  state.settings.adultBlocklistSourceId = "custom";
  state.settings.adultBlocklistCustomUrl = "https://example.test/custom-adult-domains.txt";
  const staleSummary = adultBlocklistSummary(state);
  assert.equal(staleSummary.current, false);
  assert.equal(staleSummary.ready, false);
  assert.equal(staleSummary.domainCount, 0);
  assert.equal(staleSummary.shortHash, "");
  assert.equal(matchAdultBlocklistHost(state, "media.exampleadult.test"), null);
  assert.equal(invalidateAdultBlocklistIfSourceChanged(state, previousSource), true);
  assert.equal(state.adultBlocklist.hash, "");
  assert.equal(state.adultBlocklist.source, null);
} finally {
  clearAdultBlocklistCacheForTest();
}

{
  const state = defaultState();
  const undersized = Array.from({ length: 1_000 }, (_, index) => `adult-${index}.example`).join("\n");
  assert.equal(state.settings.adultBlocklistSourceId, DEFAULT_ADULT_BLOCKLIST_SOURCE_ID);
  assert.equal(MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS, 600_000);
  await assert.rejects(
    () => refreshAdultBlocklist(state, now, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => pinnedResponse(200, [undersized])
    }),
    /600000 are required/
  );
}

{
  const state = defaultState();
  state.settings.adultBlocklistSourceId = "custom";
  state.settings.adultBlocklistCustomUrl = "https://source.example/custom.txt";
  state.adultBlocklist.hash = "previous-hash";
  state.adultBlocklist.snapshotPath = "/previous/adult-blocklist.json";
  state.adultBlocklist.domainCount = 42;
  state.adultBlocklist.activeDomainCount = 42;
  state.adultBlocklist.lastRefreshAt = "2026-06-01T00:00:00.000Z";
  const candidate = Array.from({ length: 1_000 }, (_, index) => `adult-${index}.example`).join("\n");

  await assert.rejects(
    () => refreshAdultBlocklist(state, now, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => pinnedResponse(200, [candidate]),
      buildPhoneArtifact: () => { throw new Error("Phone blocklist exceeds deliverable limits."); }
    }),
    /exceeds deliverable limits/
  );
  assert.equal(state.adultBlocklist.hash, "previous-hash");
  assert.equal(state.adultBlocklist.snapshotPath, "/previous/adult-blocklist.json");
  assert.equal(state.adultBlocklist.domainCount, 42);
  assert.equal(state.adultBlocklist.activeDomainCount, 42);
  assert.equal(state.adultBlocklist.lastRefreshAt, "2026-06-01T00:00:00.000Z");
}

function pinnedResponse(
  statusCode: number,
  chunks: Array<string | Uint8Array>,
  headers: Record<string, string | string[] | undefined> = {},
  onDestroy: () => void = () => {}
): AdultBlocklistPinnedResponse {
  const body = Readable.from(chunks);
  return {
    statusCode,
    headers,
    body,
    destroy: () => {
      onDestroy();
      body.destroy();
    }
  };
}
