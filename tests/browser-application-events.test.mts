import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { parseApplicationActivity } from "../src/macos.js";
import { Monitor } from "../src/monitor.js";
import { resetBrowserProtectionHealthForTest, unsupportedBrowser } from "../src/browserProtection.js";

const application = { app: "DuckDuckGo", bundleId: "com.duckduckgo.macos.browser", pid: 12345, launchedAt: 1234 };
const signal = parseApplicationActivity(`application\t${JSON.stringify({ kind: "launch", ...application })}`)!;
assert.deepEqual(signal.application, application);
for (const change of [{ pid: -1 }, { pid: 1.5 }, { launchedAt: 0 }, { bundleId: "" }, { kind: "key" }]) {
  assert.equal(parseApplicationActivity(`application\t${JSON.stringify({ kind: "launch", ...application, ...change })}`), null);
}
assert.equal(parseApplicationActivity("application\tinvalid"), null);
const custom = parseApplicationActivity(`application\t${JSON.stringify({
  kind: "activate", ...application, app: "Unlisted Browser", bundleId: "org.test.browser",
  bundleInfo: { CFBundleURLTypes: [{ CFBundleURLSchemes: ["https", "http"] }], CFBundleDocumentTypes: [{ CFBundleTypeRole: "Viewer", LSItemContentTypes: ["public.html"] }] }
})}`)!;
assert.equal(unsupportedBrowser(custom.application!.app), true, "launch metadata discovers browsers without a process sweep");

const state = defaultState();
state.settings.protectedBrowsersOnly = true;
state.settings.appQuitEnabled = false;
state.settings.processSweepEnabled = false;
let releaseQueue!: () => void;
let releaseQuit!: () => void;
let quits = 0;
const quitGate = new Promise<void>(resolve => { releaseQuit = resolve; });
const monitor = new Monitor({ state, usage: {}, applicationQuit: async target => {
  assert.deepEqual(target, application);
  quits += 1;
  await quitGate;
  return { ok: true };
} });
const queueGate = new Promise<void>(resolve => { releaseQueue = resolve; });
void monitor.enqueueOperation(async () => await queueGate);
monitor.readFrontmost = async () => { throw new Error("must not read the foreground or URL"); };
const launched = monitor.enforceRestrictedBrowserInstance(signal);
const activated = monitor.enforceRestrictedBrowserInstance({ ...signal, kind: "activate" });
assert.equal(quits, 1, "launch and activation must coalesce and quit before blocked monitor work completes");
releaseQuit();
assert.equal(await launched, true);
assert.equal(await activated, true);
assert.equal(state.events.some(event => event.type === "blocked_app"), false, "only bookkeeping waits behind the queue");
releaseQueue();
await monitor.operationTail;
assert.ok(state.events.some(event => event.type === "blocked_app"));
assert.equal(await monitor.enforceRestrictedBrowserInstance({ kind: "launch", at: 0 }), false, "older helpers retain fallback enforcement");
for (const app of ["Safari", "Google Chrome", "Vigil", "Codex", "Terminal"]) {
  assert.equal(await monitor.enforceRestrictedBrowserInstance({ ...signal, application: { ...application, app } }), false, app);
}
monitor.applicationQuit = async () => ({ ok: false, error: "instance already exited" });
assert.equal(await monitor.enforceRestrictedBrowserInstance(signal), false, "failed instance enforcement must retain the ordinary backstop");
await monitor.operationTail;
resetBrowserProtectionHealthForTest();
