import assert from "node:assert/strict";
import { drainLatestSettingsThroughRefresh } from "../public/app-events.js";

interface SettingsRevision {
  revision: number;
}

let pending: SettingsRevision | null = { revision: 1 };
let guardActive = true;
const events: string[] = [];
let refreshCount = 0;

try {
  await drainLatestSettingsThroughRefresh(
    () => {
      const value = pending;
      pending = null;
      return value;
    },
    () => pending !== null,
    async (value) => {
      assert.equal(guardActive, true, "poll rendering must remain guarded while a settings write is active");
      events.push(`save:${value.revision}`);
    },
    async () => {
      assert.equal(guardActive, true, "poll rendering must remain guarded through the confirming refresh");
      refreshCount += 1;
      events.push(`refresh:${refreshCount}`);
      if (refreshCount === 1) pending = { revision: 2 };
    }
  );
} finally {
  guardActive = false;
}

assert.deepEqual(
  events,
  ["save:1", "refresh:1", "save:2", "refresh:2"],
  "a change arriving during confirmation must be saved and confirmed before the queue can clear its guard"
);
assert.equal(pending, null);
