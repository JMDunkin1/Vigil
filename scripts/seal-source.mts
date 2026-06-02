import { clearTrustedSourceSealDrift } from "../src/integrityLockdown.js";
import { writeSourceSeal } from "../src/sourceSeal.js";
import { addEvent, loadState, saveState } from "../src/store.js";

const result = await writeSourceSeal();
const state = await loadState();
const cleared = clearTrustedSourceSealDrift(state);
if (cleared) {
  addEvent(state, "source_seal_trusted_drift_cleared", {
    sealedAt: result.sealedAt,
    fileCount: result.fileCount
  });
  await saveState(state);
}

console.log(`${result.detail} Sealed at ${result.sealedAt}.${cleared ? " Cleared source-seal hardening drift." : ""}`);
