import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { hardeningDriftAttestationRequired } from "../src/integrityLockdown.js";
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

  await coordinator.run(async ({ state: draftState, requestPersistence }) => {
    draftState.environment.wifiSsid = "safety-critical-monitor";
    requestPersistence();
  }, { persist: false });

  assert.equal(state.environment.wifiSsid, "safety-critical-monitor");
  assert.equal(snapshotWrites, 1, "a mutation must be able to promote a safety-critical result to a durable snapshot");

  await coordinator.run(async ({ afterCommit }) => {
    afterCommit(
      async () => ({ ok: true }),
      { key: "efficiency-durable-effect", kind: "test-effect", payload: {} }
    );
  }, { persist: false });

  assert.equal(snapshotWrites >= 4, true, "a monitor cycle with an external effect must remain durable through intent, running, and completion commits");
  assert.equal(coordinator.pendingEffects().length, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const now = Date.now();
  const state = defaultState();
  const usage: UsageState = {};
  state.settings.foolproofModeEnabled = true;
  state.activeSession = {
    id: "stale-hardening-evidence-lock",
    title: "Stale hardening evidence lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(now - 1_000).toISOString(),
    endsAt: new Date(now + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  let collections = 0;
  let releaseFirstCollection = () => {};
  const firstCollectionGate = new Promise<void>((resolve) => { releaseFirstCollection = resolve; });
  let markFirstCollection = () => {};
  const firstCollectionStarted = new Promise<void>((resolve) => { markFirstCollection = resolve; });
  monitor.collectHardeningDriftEvidence = async (_snapshot, checkedAt, policyFingerprint, monitorFingerprint) => {
    collections += 1;
    if (collections === 1) {
      markFirstCollection();
      await firstCollectionGate;
    }
    return {
      checkedAt,
      policyFingerprint: policyFingerprint!,
      monitorFingerprint: monitorFingerprint!,
      checks: {
        // The stale generation looks drifted on purpose. It must never create a
        // false lockdown after policy changes while evidence is in flight.
        hosts: { installed: collections !== 1, partial: false, stale: false },
        firewall: { installed: true, partial: false, stale: false },
        safariFilter: { required: false, installed: true, current: true },
        chromeSafeSearch: { required: false, installed: true, current: true },
        agent: { installed: true, loaded: true, running: true },
        monitor: JSON.parse(monitorFingerprint!),
        extensionRules: { ok: true, status: "current", count: 1 },
        sourceSeal: { ok: true, status: "sealed", fileCount: 1 }
      }
    };
  };

  const refresh = monitor.refreshHardeningDrift(now);
  await firstCollectionStarted;
  await coordinator.run(async ({ state: draftState }) => {
    draftState.profiles[0]!.blockedSites.push("generation-change.example");
  }, { persist: false });
  releaseFirstCollection();
  assert.equal(await refresh, false, "the fresh retry is clean and must not create an integrity lockdown");
  assert.equal(collections, 2,
    "stale hardening evidence must be discarded and recollected for the new policy generation");
  assert.equal(state.integrity.runtime.hardeningDriftDetectedAt, null,
    "a drift result measured for the stale generation must never be applied");
  assert.equal(monitor.status.hardeningDrift?.drift, null,
    "the accepted fresh evidence must publish clean status rather than stale drift");
  assert.ok(monitor.nextHardeningDriftRefreshAt > Date.now(),
    "only accepted fresh evidence may advance the hardening attestation deadline");
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

{
  const checkedAt = new Date("2026-07-21T12:00:00.000Z");
  const state = defaultState();
  state.activeSession = {
    id: "hardening-attestation-lock",
    title: "Hardening attestation lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: checkedAt.toISOString(),
    endsAt: new Date(checkedAt.getTime() + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const protectedSession = state.activeSession;
  const monitor = new Monitor({ state, usage: {} });

  monitor.nextHardeningDriftRefreshAt = checkedAt.getTime() + 15_000;
  await monitor.refreshHardeningDrift(checkedAt.getTime());
  assert.equal(
    monitor.nextHardeningDriftRefreshAt,
    0,
    "re-enabling foolproof mode during a protected lock must not inherit a disabled-state cooldown"
  );

  state.settings.foolproofModeEnabled = true;
  assert.equal(
    hardeningDriftAttestationRequired(state, checkedAt),
    true,
    "re-enabled foolproof mode must recognize an already-active protected overlap"
  );
  state.activeSession = null;
  assert.equal(hardeningDriftAttestationRequired(state, checkedAt), false);
  await monitor.refreshHardeningDrift(checkedAt.getTime());
  assert.equal(
    monitor.status.hardeningDrift?.skipped,
    "no-protected-lock",
    "idle foolproof monitoring must not launch fresh hardening attestation"
  );
  assert.equal(monitor.nextHardeningDriftRefreshAt, 0, "a future protected lock must attest hardening immediately");

  state.integrity.runtime.hardeningDriftDetectedAt = checkedAt.toISOString();
  state.integrity.runtime.hardeningDriftIssues = [{
    id: "apple-content-filter",
    detail: "Apple content filter recovery"
  }];
  await monitor.refreshHardeningDrift(checkedAt.getTime() + 1);
  assert.equal(
    monitor.status.hardeningDrift?.skipped,
    "apple-content-filter-recovery",
    "Apple filter recovery must stay on its dedicated fresh check without launching unrelated Chrome attestation"
  );

  state.activeSession = protectedSession;
  assert.equal(
    hardeningDriftAttestationRequired(state, checkedAt),
    true,
    "an active protected overlap must retain fresh fail-closed hardening attestation"
  );
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const order: string[] = [];
  const effectStarts: string[] = [];
  const postDriftSideEffects: string[] = [];
  let mutationActive = false;
  let releaseAttestation = () => {};
  const attestationGate = new Promise<void>((resolve) => { releaseAttestation = resolve; });
  let markAttestationStarted = () => {};
  const attestationStarted = new Promise<void>((resolve) => { markAttestationStarted = resolve; });
  let attestationPhaseSnapshots = 0;
  state.settings.foolproofModeEnabled = true;
  state.activeSession = {
    id: "slow-attestation-lock",
    title: "Slow attestation lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    if (order.includes("attestation-end")) attestationPhaseSnapshots += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(async ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => {
      mutationActive = true;
      try {
        return await operation(draftState, draftUsage, afterCommit, requestPersistence);
      } finally {
        mutationActive = false;
      }
    }, options)
  });
  monitor.nextPersistenceAt = Date.now() + MONITOR_PERSIST_INTERVAL_MS;
  monitor.recordElapsedUsage = async () => {};
  monitor.refreshSafetyRails = async () => {
    order.push("safety");
    await monitor.externalEffect("lock-screen", { policyId: "slow-attestation-lock" }, async () => {
      effectStarts.push("sleep-lock");
      return { ok: true };
    });
  };
  monitor.updateFrontmostSample = async () => {
    order.push("front");
    return { ok: true, app: "Safari", hostname: "reddit.com", url: "https://reddit.com/" };
  };
  let foregroundEnforcements = 0;
  monitor.enforceFrontmost = async () => {
    foregroundEnforcements += 1;
    if (foregroundEnforcements > 1) {
      order.push("enforce-after-drift");
      return;
    }
    order.push("enforce-before-attestation");
    await monitor.externalEffect(
      "redirect-browser",
      {
        app: "Safari",
        currentUrl: "https://reddit.com/",
        url: "http://127.0.0.1:43110/blocked",
        policyId: "slow-attestation-lock"
      },
      async () => {
        effectStarts.push("redirect");
        return { ok: true, matched: true };
      }
    );
  };
  monitor.collectHardeningDriftEvidence = async (_snapshot, checkedAt, policyFingerprint, monitorFingerprint) => {
    assert.equal(mutationActive, false,
      "slow hardening evidence collection must run outside both monitor and coordinator serialization");
    order.push("attestation-start");
    markAttestationStarted();
    await attestationGate;
    order.push("attestation-end");
    return {
      checkedAt,
      policyFingerprint: policyFingerprint!,
      monitorFingerprint: monitorFingerprint!,
      checks: {
        hosts: { installed: false, partial: false, stale: false },
        firewall: { installed: true, partial: false, stale: false },
        safariFilter: { required: false, installed: true, current: true },
        chromeSafeSearch: { required: false, installed: true, current: true },
        agent: { installed: true, loaded: true, running: true },
        monitor: JSON.parse(monitorFingerprint!),
        extensionRules: { ok: true, status: "current", count: 1 },
        sourceSeal: { ok: true, status: "sealed", fileCount: 1 }
      }
    };
  };
  monitor.readFrontmost = async (options) => {
    assert.equal(options?.fresh, true, "a newly detected drift lockdown must re-read the current target");
    assert.equal(mutationActive, false, "post-attestation foreground discovery must stay outside mutation serialization");
    order.push("fresh-front");
    return { ok: true, app: "Safari", hostname: "reddit.com", url: "https://reddit.com/" };
  };
  monitor.collectImmediateSideEffectObservations = async () => {
    assert.equal(mutationActive, false, "post-attestation process and grayscale discovery must stay outside mutation serialization");
    order.push("side-observations");
    return {
      grayscale: { ok: true, universalAccess: false, coreGraphics: false } as never,
      runningApps: { ok: true, apps: ["Chess"] } as never
    };
  };
  monitor.runBackgroundEnforcement = async () => {
    order.push("background");
    await monitor.externalEffect("quit-app", { app: "Chess", force: false }, async () => {
      effectStarts.push("process-sweep");
      return { ok: true };
    });
  };
  monitor.persistHeartbeat = async () => { order.push("persist"); };
  monitor.enforceSystemSleepLock = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("sleep-lock");
    order.push("post-sleep-lock");
    return null;
  };
  monitor.syncFocusShortcut = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("focus-shortcut");
    order.push("post-focus-shortcut");
    return {} as never;
  };
  monitor.reconcileGrayscale = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    assert.ok(options.observed);
    assert.ok(options.runningApps);
    postDriftSideEffects.push("grayscale");
    order.push("post-grayscale");
    return {};
  };
  monitor.sweepBlockedProcesses = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    assert.ok(options.runningApps);
    postDriftSideEffects.push("process-sweep");
    order.push("post-process-sweep");
  };
  monitor.syncIosMdmPolicy = () => {
    assert.equal(mutationActive, true);
    postDriftSideEffects.push("mdm-sync");
    order.push("post-mdm-sync");
    return { queued: true } as never;
  };
  monitor.pushIosMdmPolicy = async (_now, _reason, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("mdm-push");
    order.push("post-mdm-push");
    return { ok: true, pushed: 1 };
  };

  let tickFinished = false;
  const ticking = monitor.runScheduledTick().then(() => { tickFinished = true; });
  await attestationStarted;
  assert.deepEqual(effectStarts, ["sleep-lock", "redirect", "process-sweep"],
    "the real coordinator must commit and start every core enforcement effect before slow attestation");
  assert.deepEqual(order, ["safety", "front", "enforce-before-attestation", "background", "persist", "attestation-start"],
    "core enforcement must commit and dispatch before a slow fresh Chrome profile attestation");
  assert.equal(tickFinished, false);

  let markControlAttempted = () => {};
  const controlAttempted = new Promise<void>((resolve) => { markControlAttempted = resolve; });
  const concurrentPolicyRequest = coordinator.run(async ({ afterCommit }) => {
    afterCommit(
      () => {
        effectStarts.push("policy-enforcement");
        markControlAttempted();
        return { ok: true };
      },
      { key: "policy-enforcement:while-attestation-gated", kind: "policy-enforcement", payload: {} }
    );
  });
  await controlAttempted;
  await concurrentPolicyRequest;
  assert.equal(mutationActive, false);
  assert.deepEqual(effectStarts, ["sleep-lock", "redirect", "process-sweep", "policy-enforcement"],
    "a newly queued policy control attempt must enter while slow attestation is gated");

  releaseAttestation();
  await ticking;
  assert.deepEqual(order, [
    "safety",
    "front",
    "enforce-before-attestation",
    "background",
    "persist",
    "attestation-start",
    "attestation-end",
    "fresh-front",
    "side-observations",
    "enforce-after-drift",
    "post-sleep-lock",
    "post-focus-shortcut",
    "post-grayscale",
    "post-process-sweep",
    "post-mdm-sync",
    "post-mdm-push"
  ], "a fresh drift lockdown must publish every immediate enforcement intent in the same serialized tick");
  assert.deepEqual(postDriftSideEffects, [
    "sleep-lock",
    "focus-shortcut",
    "grayscale",
    "process-sweep",
    "mdm-sync",
    "mdm-push"
  ], "all fail-closed side effects must be published before waiting for a later poll");
  assert.equal(attestationPhaseSnapshots, 1,
    "a newly detected lockdown must request one durable snapshot even between heartbeat cadence writes");
  assert.equal(coordinator.pendingEffects().length, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}
