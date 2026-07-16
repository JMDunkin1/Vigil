import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { MONITOR_PERSIST_INTERVAL_MS, Monitor, wifiEnvironmentObservationRequired } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import type { UsageState } from "../src/types.js";

{
  const state = defaultState();
  const usage: UsageState = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });

  await coordinator.run(async ({ state: draftState }) => {
    draftState.environment.wifiSsid = "efficient-monitor";
  }, { persist: false });

  assert.equal(state.environment.wifiSsid, "efficient-monitor", "transient monitor updates must still publish to live state");
  assert.equal(snapshotWrites, 0, "a routine monitor sample must not write a full sealed snapshot every poll");

  await coordinator.run(async ({ afterCommit }) => {
    afterCommit(
      async () => ({ ok: true }),
      { key: "efficiency-durable-effect", kind: "test-effect", payload: {} }
    );
  }, { persist: false });

  assert.equal(snapshotWrites >= 3, true, "a monitor cycle with an external effect must remain durable through intent, running, and completion commits");
  assert.equal(coordinator.pendingEffects().length, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  assert.equal(wifiEnvironmentObservationRequired(state), false);
  await monitor.refreshEnvironment(Date.now());
  assert.equal(monitor.nextEnvironmentRefreshAt, 0, "Wi-Fi subprocess checks must stay dormant when no enabled schedule depends on an SSID");

  state.schedules[0].enabled = true;
  state.schedules[0].wifiNetworks = ["Office"];
  assert.equal(wifiEnvironmentObservationRequired(state), true, "adding an SSID-bound schedule must immediately restore Wi-Fi observation");
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const persistenceRequests: Array<boolean | undefined> = [];
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => {
      persistenceRequests.push(options?.persist);
      return await operation(state, usage, (effect) => { void effect(); });
    }
  });
  monitor.tick = async () => {};

  await monitor.runScheduledTick();
  await monitor.runScheduledTick();

  assert.deepEqual(persistenceRequests, [true, false], "the monitor must persist its first heartbeat and batch subsequent polls");
  assert.equal(MONITOR_PERSIST_INTERVAL_MS, 30_000, "batched persistence must remain well inside the runtime-gap safety window");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  let durableEffects = 0;
  monitor.externalEffect = (async () => {
    durableEffects += 1;
    return { ok: true };
  }) as typeof monitor.externalEffect;

  const summary = await monitor.syncFocusShortcut(Date.now());
  assert.equal(summary.enabled, false);
  assert.equal(durableEffects, 0, "a disabled and inactive Focus hook must not create a durable OS intent every poll");
  assert.equal(monitor.status.componentHealth["focus-shortcut"]?.state, "disabled");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });

  await monitor.refreshAppleContentFilterLockdown(Date.now());

  assert.equal(
    monitor.status.appleContentFilterLockdown?.skipped,
    "no-protected-lock",
    "Apple profile tools must stay idle when no protected lock or recovery needs them"
  );
  assert.equal(monitor.nextAppleContentFilterRefreshAt, 0, "a future protected lock must trigger an immediate filter check");
}
