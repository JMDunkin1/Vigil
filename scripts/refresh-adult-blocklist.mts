import { adultBlocklistSummary, refreshAdultBlocklist } from "../src/adultBlocklist.js";
import { addEvent, loadState, saveState } from "../src/store.js";

const state = await loadState();

try {
  const summary = await refreshAdultBlocklist(state);
  addEvent(state, "adult_blocklist_refreshed", {
    sourceId: summary.selectedSourceId,
    domainCount: summary.domainCount,
    activeDomainCount: summary.activeDomainCount,
    hash: summary.shortHash
  });
  await saveState(state);
  console.log([
    `Adult blocklist refreshed from ${summary.selectedSourceLabel}.`,
    `Domains: ${summary.domainCount}`,
    `Active: ${summary.activeDomainCount}`,
    `Hash: ${summary.shortHash}`,
    `Snapshot: ${summary.snapshotPath}`
  ].join("\n"));
} catch (error) {
  addEvent(state, "adult_blocklist_refresh_failed", {
    error: error instanceof Error ? error.message : String(error),
    summary: adultBlocklistSummary(state)
  });
  await saveState(state);
  throw error;
}
