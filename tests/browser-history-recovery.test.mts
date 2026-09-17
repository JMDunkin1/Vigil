import assert from "node:assert/strict";
import { mock } from "node:test";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";

// Healthy Safari enforcement is driven by navigation/input. Merely leaving
// the browser foregrounded must not cause an OS poll every three seconds.
const blockedUrl = "https://www.google.com/search?q=porn";
const blockerUrl = "http://127.0.0.1:8787/blocked";
let currentUrl = blockerUrl;
let redirects = 0;
let ticks = 0;
const monitor = new Monitor({
  state: defaultState(),
  usage: {},
  browserActivitySubscribe: () => () => {},
  browserActivityHealthy: () => true,
  browserRedirect: async (app, _target, options) => {
    assert.equal(app, "Safari");
    assert.equal(options?.currentUrl, blockedUrl);
    assert.equal(currentUrl, blockedUrl);
    redirects += 1;
    currentUrl = blockerUrl;
    return { ok: true, matched: true, redirectedTabCount: 1 };
  }
});
const sample = () => ({ app: "Safari", hostname: new URL(currentUrl).hostname, url: currentUrl });
monitor.lastSample = sample();
monitor.readFrontmost = async () => ({ ok: true, ...sample() });
monitor.runScheduledTick = async () => {
  ticks += 1;
  monitor.lastScheduledTickAt = Date.now();
  monitor.lastSample = sample();
};

mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
try {
  monitor.start();
  mock.timers.tick(30_000);
  assert.equal(ticks, 1, "an idle foreground Safari tab must not trigger recurring enforcement ticks");
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    currentUrl = blockedUrl;
    await monitor.probeBrowserActivity();
    await monitor.operationTail;
    assert.equal(redirects, attempt, `navigation ${attempt} must still be blocked by the event-driven path`);
    assert.equal(currentUrl, blockerUrl);
  }
  assert.equal(ticks, 1, "navigation enforcement must not require full monitor polls");
} finally {
  await monitor.stop();
  mock.timers.reset();
}
