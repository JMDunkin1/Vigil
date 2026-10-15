import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "vigil-extension-blocklist-recovery-"));
process.env.VIGIL_DATA_DIR = directory;
const { ADULT_BLOCKLIST_SNAPSHOT_PATH, ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest } = await import("../src/adultBlocklist.js");
const { defaultState } = await import("../src/defaults.js");
const { evaluateExtensionCheck } = await import("../src/extensionPolicy.js");
try {
  const state = defaultState();
  const usage = {};
  const missing = ADULT_BLOCKLIST_SNAPSHOT_PATH;
  assert.equal(evaluateExtensionCheck(state, usage, { url: "https://ordinary.example/", event: "embedded" }).blocked, false,
    "a fresh install without a committed bulk snapshot is distinct from a lost verified cache");
  state.adultBlocklist.hash = "committed-but-unavailable";
  state.adultBlocklist.snapshotPath = missing;
  state.adultBlocklist.source = ADULT_BLOCKLIST_SOURCES[0];
  for (const url of ["https://ordinary.example/", "http://ordinary.example/", "http://127.0.0.1:8080/", "http://localhost:8080/",
    "https://localhost:8787/", "http://user:password@localhost:8787/"]) {
    const result = evaluateExtensionCheck(state, usage, { url, event: "navigation", seconds: 5 });
    assert.equal(result.blocked, true, url);
    assert.equal(result.reason, "adult-blocklist-recovery");
    assert.equal(result.recorded, false, "unverified protection cannot begin activity accounting");
    assert.equal(new URL(result.redirectUrl!).pathname, "/blocked");
  }
  assert.deepEqual(usage, {});
  for (const url of ["http://127.0.0.1:8787/blocked", "http://localhost:8787/", "http://[::1]:8787/blocked"]) {
    assert.equal(evaluateExtensionCheck(state, usage, { url }).blocked, false, "the local recovery interface remains reachable");
  }
  await writeFile(missing, "{corrupt-json");
  clearAdultBlocklistCacheForTest();
  assert.equal(evaluateExtensionCheck(state, usage, { url: "https://ordinary.example/", event: "embedded" }).blocked, true,
    "a present but invalid snapshot cannot release the recovery gate");
  const domains = ["verified-block.example"];
  const hash = createHash("sha256").update(domains.join("\n")).digest("hex");
  await writeFile(missing, JSON.stringify({ version: 1, generatedAt: "2026-10-13T12:00:00.000Z",
    domainCount: domains.length, hash, source: ADULT_BLOCKLIST_SOURCES[0], domains }));
  state.adultBlocklist.hash = hash;
  clearAdultBlocklistCacheForTest();
  assert.equal(evaluateExtensionCheck(state, usage, { url: "https://ordinary.example/", event: "embedded" }).blocked, false);
  assert.equal(evaluateExtensionCheck(state, usage, { url: "https://verified-block.example/", event: "embedded" }).blocked, true);
} finally {
  clearAdultBlocklistCacheForTest();
  await rm(directory, { recursive: true, force: true });
}
console.log("Extension missing/corrupt committed blocklist recovery remains closed; fresh installs, local recovery and verified matcher restoration retain their intended behavior.");
