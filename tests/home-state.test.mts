import assert from "node:assert/strict";
import { nextSchedule, nextScheduleLabel, protectionStatus } from "../public/home-state.js";

const now = new Date(2026, 9, 2, 10, 0); // Friday, local time.
const entry = (name: string, start: string, days: number[], enabled = true) => ({ name, start, days, enabled });
const next = nextSchedule([
  entry("Disabled", "10:01", [5], false),
  entry("Invalid", "25:00", [5]),
  entry("Past", "09:00", [5]),
  entry("Tomorrow", "08:00", [6]),
  entry("Today", "11:00", [5]),
  entry("Later today", "12:00", [5])
], now);
assert.equal(next?.name, "Today");
assert.equal(next?.startsAt.getTime(), new Date(2026, 9, 2, 11).getTime());
assert.equal(nextSchedule([entry("Weekly", "10:00", [5])], now)?.startsAt.getTime(), new Date(2026, 9, 9, 10).getTime(), "a start already reached must advance to its next weekday");
assert.equal(nextSchedule([entry("Sunday", "00:15", [0])], now)?.startsAt.getTime(), new Date(2026, 9, 4, 0, 15).getTime());
assert.equal(nextSchedule([], now), null);
assert.equal(nextSchedule([entry("No days", "12:00", []), entry("Disabled", "12:00", [5], false)], now), null);
assert.match(nextScheduleLabel(new Date(2026, 9, 2, 11), now), /^Today, /u);
assert.match(nextScheduleLabel(new Date(2026, 9, 3, 8), now), /^Tomorrow, /u);
assert.deepEqual(protectionStatus({ monitorOk: true }, now), { label: "Protected", tone: "good" });
assert.deepEqual(protectionStatus({}, now), { label: "Checking", tone: "warn" }, "unknown monitor health must not claim protection");
assert.deepEqual(protectionStatus({ monitorOk: false }, now), { label: "Check protection", tone: "warn" });
assert.deepEqual(protectionStatus({ monitorOk: true, monitorError: "Unavailable" }, now), { label: "Check protection", tone: "warn" });
assert.deepEqual(protectionStatus({ policyKind: "integrity", monitorOk: true }, now), { label: "Integrity lock", tone: "bad" });
assert.deepEqual(protectionStatus({ policyKind: "panic", monitorOk: true }, now), { label: "Panic", tone: "bad" });
assert.deepEqual(protectionStatus({ monitorOk: true, phaseKind: "break" }, now), { label: "Break", tone: "warn" });
assert.deepEqual(protectionStatus({ monitorOk: true, maintenanceUntil: new Date(now.getTime() + 60_000).toISOString() }, now), { label: "Maintenance", tone: "warn" });
assert.equal(protectionStatus({ monitorOk: true, maintenanceUntil: new Date(now.getTime() - 1).toISOString() }, now).label, "Protected");
