import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ADULT_BLOCKLIST_SNAPSHOT_PATH,
  ADULT_BLOCKLIST_SOURCES,
  clearAdultBlocklistCacheForTest,
  matchAdultBlocklistHost
} from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { loadState, STATE_PATH } from "../src/store.js";

const hagezi = ADULT_BLOCKLIST_SOURCES.find((source) => source.id === "hagezi-nsfw");
assert.ok(hagezi);

const domains = ["legacy.exampleadult.test"];
const hash = createHash("sha256").update(domains.join("\n")).digest("hex");
const source = {
  id: hagezi.id,
  label: hagezi.label,
  url: hagezi.url,
  homepage: hagezi.homepage,
  license: hagezi.license
};
const legacyState = defaultState();
legacyState.settings.adultBlocklistSourceId = hagezi.id;
legacyState.adultBlocklist = {
  allowlist: [],
  domainCount: domains.length,
  activeDomainCount: domains.length,
  hash,
  snapshotPath: ADULT_BLOCKLIST_SNAPSHOT_PATH,
  lastAttemptAt: "2026-07-01T12:00:00.000Z",
  lastRefreshAt: "2026-07-01T12:00:00.000Z",
  lastError: "",
  source
};

await mkdir(dirname(STATE_PATH), { recursive: true });
await writeFile(ADULT_BLOCKLIST_SNAPSHOT_PATH, `${JSON.stringify({
  version: 1,
  generatedAt: legacyState.adultBlocklist.lastRefreshAt,
  domainCount: domains.length,
  hash,
  source,
  domains
})}\n`);
await writeFile(STATE_PATH, `${JSON.stringify(legacyState, null, 2)}\n`);

const migrated = await loadState();
assert.equal(migrated.settings.adultBlocklistSourceId, "hagezi-nsfw");
assert.equal(migrated.adultBlocklist.source?.id, "hagezi-nsfw");
assert.equal(migrated.adultBlocklist.snapshotPath, ADULT_BLOCKLIST_SNAPSHOT_PATH);
assert.equal(migrated.adultBlocklist.hash, hash);

clearAdultBlocklistCacheForTest();
assert.deepEqual(matchAdultBlocklistHost(migrated, "media.legacy.exampleadult.test"), {
  id: "adult-blocklist",
  label: "Adult blocklist",
  hostname: "media.legacy.exampleadult.test",
  domain: "legacy.exampleadult.test",
  sourceId: "hagezi-nsfw",
  sourceLabel: "HaGeZi NSFW"
});
