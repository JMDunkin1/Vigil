import assert from "node:assert/strict";

import { isClock, normalizeClock, parseClock } from "../src/time.js";

assert.equal(isClock("00:00"), true);
assert.equal(isClock("23:59"), true);
assert.equal(isClock("24:00"), false);
assert.equal(isClock("09:60"), false);
assert.equal(isClock("99:99"), false);
assert.equal(normalizeClock("99:99", "09:00"), "09:00");
assert.equal(parseClock("99:99"), 0);
assert.equal(parseClock("17:45"), 17 * 60 + 45);
