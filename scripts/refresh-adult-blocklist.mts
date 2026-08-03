import {
  ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH,
  adultBlocklistSummary,
  finalizeAdultBlocklistSnapshot,
  refreshAdultBlocklist,
  writeAdultBlocklistPhoneArtifact
} from "../src/adultBlocklist.js";
import { addEvent, loadState, saveState } from "../src/store.js";

const state = await loadState();

try {
  const summary = await refreshAdultBlocklist(state);
  addEvent(state, "adult_blocklist_refreshed", {
    sourceId: summary.selectedSourceId,
    sourceDomainCount: summary.sourceDomainCount,
    domainCount: summary.domainCount,
    activeDomainCount: summary.activeDomainCount,
    suffixRedundantCount: summary.qualityAudit?.suffixRedundantCount || 0,
    invalidLineCount: summary.qualityAudit?.invalidLineCount || 0,
    unrecognizedTldCount: summary.qualityAudit?.tldRegistryChecked
      ? summary.qualityAudit.unrecognizedTldCount
      : null,
    hash: summary.shortHash
  });
  await saveState(state);
  const phoneArtifact = await writeAdultBlocklistPhoneArtifact(state);
  await finalizeAdultBlocklistSnapshot(state);
  console.log([
    `Adult blocklist refreshed from ${summary.selectedSourceLabel}.`,
    `Source domains: ${summary.sourceDomainCount}`,
    `Effective domains: ${summary.domainCount}`,
    `Covered children compacted: ${summary.qualityAudit?.suffixRedundantCount || 0}`,
    `Invalid rows rejected: ${summary.qualityAudit?.invalidLineCount || 0}`,
    `Unrecognized TLDs retained: ${summary.qualityAudit?.tldRegistryChecked ? summary.qualityAudit.unrecognizedTldCount : "not checked"}`,
    `Active: ${summary.activeDomainCount}`,
    `Hash: ${summary.shortHash}`,
    `Snapshot: ${summary.snapshotPath}`,
    `Phone artifact: ${ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH} (${phoneArtifact.payloadBytes} compressed payload bytes)`
  ].join("\n"));
} catch (error) {
  addEvent(state, "adult_blocklist_refresh_failed", {
    error: error instanceof Error ? error.message : String(error),
    summary: adultBlocklistSummary(state)
  });
  await saveState(state);
  throw error;
}
