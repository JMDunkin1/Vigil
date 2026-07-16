import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { canonicalFrontmostAppName, packagedAppBundleForExecutable, parseHidIdleSeconds, parseHumanActivitySample, parseHumanIdleSeconds } from "../src/macos.js";
import { activeSecondsBeforeIdleThreshold, Monitor } from "../src/monitor.js";
import { isInterruptedPollGap, maxTrustedPollGapSeconds } from "../src/monitor/timing.js";
import type { UsageState } from "../src/types.js";

assert.equal(parseHidIdleSeconds('"HIDIdleTime" = 1500000000'), 1.5);
assert.equal(parseHidIdleSeconds('      "HIDIdleTime" = 3376045002708'), 3376.045002708);
assert.equal(parseHidIdleSeconds("no idle value"), null);
assert.equal(parseHumanIdleSeconds("12.375\n"), 12.375);
assert.equal(parseHumanIdleSeconds("not-a-number"), null);
assert.deepEqual(parseHumanActivitySample("12.375\tSafari\tcom.apple.Safari\n"), {
  idleSeconds: 12.375,
  app: "Safari",
  bundleId: "com.apple.Safari"
});
assert.equal(parseHumanActivitySample("error"), null);
assert.equal(
  packagedAppBundleForExecutable("/Applications/Vigil.app/Contents/Resources/app.asar.unpacked/dist/runtime/bin/vigil-human-idle"),
  "/Applications/Vigil.app"
);
assert.equal(packagedAppBundleForExecutable("/tmp/vigil/dist/runtime/bin/vigil-human-idle"), null);
assert.equal(canonicalFrontmostAppName("ChatGPT", "com.openai.codex"), "Codex");

assert.equal(activeSecondsBeforeIdleThreshold(3, 10, 120), 3);
assert.equal(activeSecondsBeforeIdleThreshold(3, 121, 120), 2);
assert.equal(activeSecondsBeforeIdleThreshold(3, 125, 120), 0);
assert.equal(activeSecondsBeforeIdleThreshold(6.25, 122.5, 120), 3.8);
assert.equal(activeSecondsBeforeIdleThreshold(3, 10, 5), 3);
assert.equal(activeSecondsBeforeIdleThreshold(-1, 125, 120), 0);

assert.equal(maxTrustedPollGapSeconds(3000), 10);
assert.equal(isInterruptedPollGap(10, 3000), false);
assert.equal(isInterruptedPollGap(10.1, 3000), true);
assert.equal(isInterruptedPollGap(60 * 60, 3000), true, "a wake or suspension gap must not become trusted activity");
assert.equal(isInterruptedPollGap(30, 20_000), false, "custom poll intervals retain proportionate tolerance");

const usage: UsageState = {};
const monitor = new Monitor({ state: defaultState(), usage });
monitor.lastSample = { app: "Codex", hostname: "", url: "" };
await monitor.recordElapsedUsage({
  now: Date.parse("2026-05-28T14:00:00-04:00"),
  monotonicNow: 60 * 60 * 1000,
  previousWall: Date.parse("2026-05-28T13:00:00-04:00"),
  previousMonotonic: 0,
  seconds: 60 * 60
});
assert.deepEqual(usage, {}, "an interrupted poll must not create a trusted usage segment");
assert.equal(monitor.status.lastIdleAccounting?.reason, "interrupted-poll");
assert.equal(monitor.status.lastIdleAccounting?.countedSeconds, 0);
