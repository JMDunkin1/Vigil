import assert from "node:assert/strict";
import { drainLatestSettingsThroughRefresh } from "../public/app-events.js";

interface SettingsRevision {
  revision: number;
}

let pending: SettingsRevision | null = { revision: 1 };
const events: string[] = [];
let refreshCount = 0;

await drainLatestSettingsThroughRefresh(
  () => {
    const value = pending;
    pending = null;
    return value;
  },
  async (value) => {
    events.push(`save:${value.revision}`);
  },
  async () => {
    refreshCount += 1;
    events.push(`refresh:${refreshCount}`);
    if (refreshCount === 1) pending = { revision: 2 };
  }
);

assert.deepEqual(
  events,
  ["save:1", "refresh:1", "save:2", "refresh:2"],
  "a change arriving during confirmation must be saved and confirmed before the queue can clear its guard"
);
assert.equal(pending, null);
