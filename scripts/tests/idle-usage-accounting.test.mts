import assert from "node:assert/strict";
import { parseHidIdleSeconds } from "../../src/macos.js";
import { activeSecondsBeforeIdleThreshold } from "../../src/monitor.js";

assert.equal(parseHidIdleSeconds('"HIDIdleTime" = 1500000000'), 1.5);
assert.equal(parseHidIdleSeconds('      "HIDIdleTime" = 3376045002708'), 3376.045002708);
assert.equal(parseHidIdleSeconds("no idle value"), null);

assert.equal(activeSecondsBeforeIdleThreshold(3, 10, 120), 3);
assert.equal(activeSecondsBeforeIdleThreshold(3, 121, 120), 2);
assert.equal(activeSecondsBeforeIdleThreshold(3, 125, 120), 0);
assert.equal(activeSecondsBeforeIdleThreshold(6.25, 122.5, 120), 3.8);
assert.equal(activeSecondsBeforeIdleThreshold(3, 10, 5), 3);
assert.equal(activeSecondsBeforeIdleThreshold(-1, 125, 120), 0);
