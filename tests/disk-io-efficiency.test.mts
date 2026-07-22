import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-disk-io-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [
  { defaultState },
  store,
  monitorModule,
  { handleSettingsApiRoute, updateSettings, settingsRequireImmediatePolicyEnforcement },
  { interventionSummary },
  { usageSummary },
  { verifyStateTextSeal }
] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/store.js"),
  import("../src/monitor.js"),
  import("../src/server/settingsRoutes.js"),
  import("../src/intervention.js"),
  import("../src/usage.js"),
  import("../src/seal.js")
]);

try {
  const at = "2026-07-21T13:00:00.000-04:00";
  const smallDetail = { requestId: "request-1", ok: true, nested: { exact: "kept" } };
  const [small] = store.compactStateEvents([{
    id: "small",
    type: "unknown_small_event",
    at,
    detail: smallDetail
  }]);
  assert.deepEqual(small?.detail, smallDetail, "small unknown audit events must remain lossless");
  const smallKnownDetail = { site: "example.com", app: "Safari", source: "foreground", escalated: true, attempts: 2 };
  const [smallKnown] = store.compactStateEvents([{
    id: "small-known",
    type: "blocked_app",
    at,
    detail: smallKnownDetail
  }]);
  assert.deepEqual(smallKnown?.detail, smallKnownDetail, "small known audit events must remain lossless too");

  const sentinel = "RAW-RECURSIVE-URL-SENTINEL";
  const hugeUrl = `https://example.com/path?payload=${sentinel.repeat(5_000)}`;
  const legacyKey = `monitor-os:redirect-browser:${JSON.stringify({ currentUrl: hugeUrl, url: hugeUrl })}`;
  const [effectEvent] = store.compactStateEvents([{
    id: "large-effect",
    type: "monitor_os_effect_completed",
    at,
    detail: {
      kind: "redirect-browser",
      key: legacyKey,
      payload: { app: "Safari", currentUrl: hugeUrl, url: hugeUrl, policyId: "focus-policy" },
      result: { ok: true, intentKey: legacyKey }
    }
  }]);
  const compactedEffectText = JSON.stringify(effectEvent);
  assert.ok(Buffer.byteLength(compactedEffectText, "utf8") <= store.STATE_EVENT_MAX_BYTES);
  assert.doesNotMatch(compactedEffectText, new RegExp(sentinel));
  assert.match(String(effectEvent?.detail.key), /^monitor-os:redirect-browser:[a-f\d]{64}$/u);
  assert.equal(effectEvent?.detail.app, "Safari");
  assert.equal(effectEvent?.detail.hostname, "example.com");
  assert.equal(effectEvent?.detail.compacted, true);
  assert.match(String(effectEvent?.detail.detailSha256), /^[a-f\d]{64}$/u);

  const newestFirst = Array.from({ length: 251 }, (_value, index) => ({
    id: `event-${index}`,
    type: "bounded_history",
    at: new Date(Date.parse(at) - index).toISOString(),
    detail: { index }
  }));
  const bounded = store.compactStateEvents(newestFirst);
  assert.equal(bounded.length, store.STATE_EVENT_HISTORY_MAX);
  assert.equal(bounded[0]?.id, "event-0");
  assert.equal(bounded.at(-1)?.id, "event-249");
  const worstCase = store.compactStateEvents(Array.from({ length: 250 }, (_value, index) => ({
    id: `oversized-${index}`,
    type: "oversized_generic_event",
    at,
    detail: {
      requestId: `request-${index}`,
      error: `${sentinel}-${index}-${"x".repeat(20_000)}`,
      unbounded: Array.from({ length: 100 }, () => hugeUrl)
    }
  })));
  assert.equal(worstCase.length, 250);
  assert.equal(worstCase.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") <= store.STATE_EVENT_MAX_BYTES), true);
  assert.ok(Buffer.byteLength(JSON.stringify(worstCase), "utf8") <= store.STATE_EVENT_HISTORY_MAX * (store.STATE_EVENT_MAX_BYTES + 1) + 2,
    "even a worst-case full history must stay within the aggregate event bound");

  const functionalState = defaultState();
  const functionalNow = new Date();
  const functionalDayStart = new Date(functionalNow);
  functionalDayStart.setHours(0, 0, 0, 0);
  const functionalStartedAt = new Date(Math.max(
    functionalDayStart.getTime(),
    functionalNow.getTime() - 60 * 60_000
  ));
  const functionalSession = {
    id: "functional-session",
    title: "Functional session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: functionalStartedAt.toISOString(),
    endsAt: new Date(functionalNow.getTime() + 60 * 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  store.addEvent(functionalState, "session_started", functionalSession);
  for (const site of ["one.example", "two.example", "three.example"]) {
    store.addEvent(functionalState, "blocked_site", { site, app: "Safari" });
  }
  store.addEvent(functionalState, "session_ended", functionalSession);
  for (let index = 0; index < store.STATE_EVENT_HISTORY_MAX + 25; index += 1) {
    store.addEvent(functionalState, "diagnostic_noise", { index });
  }
  assert.equal(functionalState.events.some((event) => ["session_started", "session_ended", "blocked_site"].includes(event.type)), false,
    "ordinary diagnostic retention should be free to evict old display events");
  assert.equal(interventionSummary(functionalState, new Date()).attempts, 3,
    "event eviction must not weaken adaptive intervention friction");
  const functionalUsage = usageSummary({}, functionalState, new Date());
  assert.equal(functionalUsage.blockCount, 3, "event eviction must not lower the daily block count");
  const expectedProtectedSeconds = Math.floor((functionalNow.getTime() - functionalStartedAt.getTime()) / 1000);
  assert.ok(functionalUsage.protectedSeconds >= Math.max(0, expectedProtectedSeconds - 2),
    "event eviction must not erase completed protected-session time");
  assert.ok(functionalState.functionalEvents.firstSessionStartedAt,
    "the first-lock milestone must survive bounded diagnostic history");

  const multiDeviceState = defaultState();
  const multiDeviceNow = new Date(functionalNow);
  multiDeviceNow.setHours(14, 0, 0, 0);
  const multiStartedAt = new Date(multiDeviceNow.getTime() - 2 * 60 * 60_000).toISOString();
  const earlierDeviceEnd = new Date(multiDeviceNow.getTime() - 60 * 60_000).toISOString();
  const laterDeviceEnd = new Date(multiDeviceNow.getTime() - 30 * 60_000).toISOString();
  multiDeviceState.functionalEvents.sessions = [{
    id: "multi-device-session",
    startedAt: multiStartedAt,
    endsAt: new Date(functionalNow.getTime() + 60 * 60_000).toISOString(),
    endedAt: laterDeviceEnd
  }];
  multiDeviceState.events = [
    { id: "later-end", type: "session_ended", at: laterDeviceEnd, detail: { id: "multi-device-session", startedAt: multiStartedAt } },
    { id: "earlier-end", type: "session_ended", at: earlierDeviceEnd, detail: { id: "multi-device-session", startedAt: multiStartedAt } }
  ];
  assert.ok(usageSummary({}, multiDeviceState, multiDeviceNow).protectedSeconds >= 89 * 60,
    "an older per-device end event must not overwrite the later functional session boundary");

  const dashboardNow = new Date(2026, 6, 21, 14, 0);
  const evidenceState = defaultState();
  delete (evidenceState as Partial<typeof evidenceState>).functionalEvents;
  evidenceState.events = store.compactStateEvents([
    {
      id: "blocked",
      type: "blocked_site",
      at: new Date(dashboardNow.getTime() - 60_000).toISOString(),
      detail: { site: "instagram.com", app: "Safari", originalSite: hugeUrl, result: { ok: true, intentKey: legacyKey } }
    },
    {
      id: "ended",
      type: "session_ended",
      at: new Date(dashboardNow.getTime() - 30 * 60_000).toISOString(),
      detail: {
        id: "compact-session",
        title: "Compact session",
        mode: "focus",
        profileId: "default",
        lockLevel: "deep",
        startedAt: new Date(dashboardNow.getTime() - 90 * 60_000).toISOString(),
        endsAt: new Date(dashboardNow.getTime() + 30 * 60_000).toISOString(),
        canEndEarly: false,
        source: "manual",
        profileSnapshot: { blockedSites: [hugeUrl] }
      }
    },
    {
      id: "started",
      type: "session_started",
      at: new Date(dashboardNow.getTime() - 90 * 60_000).toISOString(),
      detail: {
        id: "compact-session",
        title: "Compact session",
        mode: "focus",
        profileId: "default",
        lockLevel: "deep",
        startedAt: new Date(dashboardNow.getTime() - 90 * 60_000).toISOString(),
        endsAt: new Date(dashboardNow.getTime() + 30 * 60_000).toISOString(),
        canEndEarly: false,
        source: "manual",
        profileSnapshot: { blockedSites: [hugeUrl] }
      }
    }
  ]);
  assert.equal(usageSummary({}, evidenceState, dashboardNow).protectedSeconds, 60 * 60,
    "session audit compaction must retain dashboard duration evidence");
  const intervention = interventionSummary(evidenceState, dashboardNow);
  assert.equal(intervention.attempts, 1);
  assert.equal(intervention.topTargets[0]?.label, "instagram.com");

  const settings = defaultState().settings;
  assert.deepEqual(updateSettings(settings, { focusSoundVolume: settings.focusSoundVolume }), [],
    "same-value settings must not create a write");
  const audioKeys = updateSettings(settings, {
    focusSoundVolume: settings.focusSoundVolume === 42 ? 43 : 42,
    focusSoundMode: settings.focusSoundMode === "focus" ? "relax" : "focus"
  });
  assert.equal(settingsRequireImmediatePolicyEnforcement(audioKeys), false,
    "audio-only settings must not launch full OS enforcement");
  assert.equal(settingsRequireImmediatePolicyEnforcement([
    "browserNoiseBlockingEnabled",
    "externalNetworkBlockEnabled",
    "externalNetworkBlockProvider",
    "hostsBlockingEnabled"
  ]), false, "settings outside the immediate monitor call-chain must not launch an unrelated full OS sweep");
  const policyKeys = updateSettings(settings, { siteRedirectEnabled: !settings.siteRedirectEnabled });
  assert.equal(settingsRequireImmediatePolicyEnforcement(policyKeys), true);
  assert.equal(settingsRequireImmediatePolicyEnforcement([...audioKeys, ...policyKeys]), true);
  assert.deepEqual(updateSettings(settings, { futureUnknownSetting: true }), []);
  assert.equal(settingsRequireImmediatePolicyEnforcement(["futureKnownSetting"]), true,
    "future recognized settings must default to immediate enforcement until explicitly audited");

  const routeState = defaultState();
  routeState.settings.protectedEditsEnabled = false;
  await store.saveState(routeState);
  let routeEnforcements = 0;
  const postSettings = async (body: Record<string, unknown>) => {
    const request = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = "/api/settings";
    let responseBody = "";
    const response = {
      req: request,
      writeHead() { return response; },
      end(value?: string | Buffer) { responseBody += value?.toString() || ""; return response; }
    } as unknown as ServerResponse;
    assert.equal(await handleSettingsApiRoute(request, response, {
      state: routeState,
      schedulePolicyEnforcement: () => { routeEnforcements += 1; }
    }), true);
    return JSON.parse(responseBody) as { keys: string[] };
  };
  assert.deepEqual((await postSettings({ focusSoundVolume: 41 })).keys, ["focusSoundVolume"]);
  assert.equal(routeEnforcements, 0);
  const beforeNoopPost = await readFile(store.STATE_PATH, "utf8");
  assert.deepEqual((await postSettings({ focusSoundVolume: 41 })).keys, []);
  assert.equal(await readFile(store.STATE_PATH, "utf8"), beforeNoopPost,
    "a same-value settings post must not rewrite state or its seal metadata");
  assert.deepEqual((await postSettings({ siteRedirectEnabled: !routeState.settings.siteRedirectEnabled })).keys, ["siteRedirectEnabled"]);
  assert.equal(routeEnforcements, 1, "a current-enforcement setting must schedule one immediate reconciliation");

  const quietState = defaultState();
  const quietBoundary = new Date(2026, 6, 21, 12, 35).getTime();
  assert.equal(monitorModule.policyBoundaryRequiresImmediateEnforcement(quietState, quietBoundary, quietBoundary + 25), false,
    "a quiet minute must not run full enforcement");

  const scheduledState = defaultState();
  const scheduleBoundary = new Date(2026, 6, 21, 13, 0).getTime();
  const scheduleDate = new Date(scheduleBoundary);
  scheduledState.schedules = [{
    id: "boundary-schedule",
    name: "Boundary schedule",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    days: [scheduleDate.getDay()],
    start: "13:00",
    end: "14:00",
    wifiNetworks: []
  }];
  assert.equal(monitorModule.policyBoundaryRequiresImmediateEnforcement(scheduledState, scheduleBoundary, scheduleBoundary + 25), true,
    "a schedule start must retain exact enforcement");

  const grayscaleState = defaultState();
  grayscaleState.grayscale.schedules = [{
    id: "boundary-grayscale",
    name: "Boundary grayscale",
    enabled: true,
    days: [scheduleDate.getDay()],
    start: "13:00",
    end: "14:00",
    deviceTargets: ["computer"]
  }];
  assert.equal(monitorModule.policyBoundaryRequiresImmediateEnforcement(grayscaleState, scheduleBoundary, scheduleBoundary + 25), true,
    "a grayscale schedule start must retain exact enforcement");

  const pauseState = defaultState();
  const eligibleBoundary = new Date(2026, 6, 21, 12, 45).getTime();
  pauseState.intentionalUse.pauses = [{
    id: "pause-1",
    ruleId: "short-form-intent-template",
    ruleName: "Short-form pause",
    status: "pending",
    requestedAt: new Date(eligibleBoundary - 30_000).toISOString(),
    eligibleAt: new Date(eligibleBoundary).toISOString(),
    expiresAt: new Date(eligibleBoundary + 5 * 60_000).toISOString(),
    frictionLevel: "standard",
    delaySeconds: 30,
    sessionMinutes: 5,
    targetType: "site",
    targetLabel: "instagram.com",
    app: "Safari",
    hostname: "instagram.com",
    returnUrl: "https://instagram.com",
    event: "navigation"
  }];
  assert.equal(monitorModule.policyBoundaryRequiresImmediateEnforcement(pauseState, eligibleBoundary, eligibleBoundary + 25), false,
    "pause eligibility changes confirmation UX, not active enforcement");
  const expiryBoundary = Date.parse(pauseState.intentionalUse.pauses[0]!.expiresAt);
  assert.equal(monitorModule.policyBoundaryRequiresImmediateEnforcement(pauseState, expiryBoundary, expiryBoundary + 25), true,
    "pause expiry must refresh enforcement");

  const raceMonitor = new monitorModule.Monitor({ state: defaultState(), usage: {} });
  const immediateReasons: string[] = [];
  let markImmediateStarted = () => {};
  const immediateStarted = new Promise<void>((resolve) => { markImmediateStarted = resolve; });
  let releaseImmediate = () => {};
  const immediateGate = new Promise<void>((resolve) => { releaseImmediate = resolve; });
  raceMonitor.runImmediateEnforcement = async (reason: string) => {
    immediateReasons.push(reason);
    if (immediateReasons.length === 1) {
      markImmediateStarted();
      await immediateGate;
    }
    return { ok: true, reason };
  };
  const preBoundarySweep = raceMonitor.enforceImmediately("pre-boundary");
  await immediateStarted;
  const boundarySweep = raceMonitor.enforceImmediately("policy-boundary");
  assert.equal(boundarySweep, preBoundarySweep, "coalesced callers should await the complete enforcement drain");
  releaseImmediate();
  await Promise.all([preBoundarySweep, boundarySweep]);
  assert.deepEqual(immediateReasons, ["pre-boundary", "policy-boundary"],
    "a boundary arriving during an older sweep must force a post-boundary pass");

  const rearmMonitor = new monitorModule.Monitor({ state: defaultState(), usage: {} });
  let boundaryRearms = 0;
  rearmMonitor.armPolicyBoundaryTimer = () => { boundaryRearms += 1; };
  await rearmMonitor.enqueueMutationOperation(async () => {}, { persist: false });
  await Promise.resolve();
  assert.equal(boundaryRearms, 1, "each committed monitor mutation must reconsider newly created exact deadlines");

  const oldBlockedUrl = "http://127.0.0.1:49152/blocked?site=instagram.com&until=2026-07-21T18%3A00%3A00.000Z&mode=focus&policyId=policy-1";
  assert.equal(monitorModule.isVigilBlockedPageUrl(oldBlockedUrl), true);
  assert.equal(monitorModule.isVigilBlockedPageUrl("http://127.0.0.1:49152/blocked"), false,
    "an unrelated loopback page must not receive the old-port exemption");

  const effectState = defaultState();
  const effectMonitor = new monitorModule.Monitor({ state: effectState, usage: {} });
  const effectDescriptors: Array<{ key: string; payload?: Record<string, unknown> }> = [];
  effectMonitor.activeAfterCommit = ((_effect: unknown, descriptor: { key: string; payload?: Record<string, unknown> } | undefined) => {
    if (descriptor) effectDescriptors.push(descriptor);
  }) as never;
  await effectMonitor.externalEffect(
    "redirect-browser",
    { app: "Safari", currentUrl: hugeUrl, url: hugeUrl },
    async () => ({ ok: true })
  );
  const effectDescriptor = effectDescriptors.at(-1);
  assert.match(String(effectDescriptor?.key), /^monitor-os:redirect-browser:[a-f\d]{64}$/u);
  assert.equal(effectDescriptor?.payload?.currentUrl, hugeUrl, "the durable retry payload must remain exact");
  assert.equal(effectState.events.some((event) => event.type === "monitor_os_effect_intended"), false,
    "the durable outbox must be the single source of pending-intent evidence");
  await effectMonitor.externalEffect("mdm-push", { reason: "canonical", options: { alpha: 1, beta: 2 } }, async () => ({ ok: true }));
  await effectMonitor.externalEffect("mdm-push", { options: { beta: 2, alpha: 1 }, reason: "canonical" }, async () => ({ ok: true }));
  await effectMonitor.externalEffect("mdm-push", { options: { beta: 3, alpha: 1 }, reason: "canonical" }, async () => ({ ok: true }));
  assert.equal(effectDescriptors.at(-3)?.key, effectDescriptors.at(-2)?.key,
    "semantically identical nested payloads must deduplicate regardless of insertion order");
  assert.notEqual(effectDescriptors.at(-2)?.key, effectDescriptors.at(-1)?.key,
    "a real nested payload change must produce a distinct durable key");

  const legacyState = defaultState();
  legacyState.settings.pollIntervalMs = 3_000;
  legacyState.events = [{
    id: "legacy-large-event",
    type: "monitor_os_effect_completed",
    at,
    detail: {
      kind: "redirect-browser",
      key: legacyKey,
      payload: { app: "Safari", currentUrl: hugeUrl, url: hugeUrl },
      result: { ok: true, intentKey: legacyKey }
    }
  }];
  await store.saveState(legacyState);
  const legacyText = await readFile(store.STATE_PATH, "utf8");
  const legacyBytes = Buffer.byteLength(legacyText, "utf8");
  const migrated = await store.loadState();
  assert.equal(migrated.settings.pollIntervalMs, 3_000,
    "loading an old exact three-second setting must not silently reinterpret an intentional cadence");
  assert.equal(await readFile(store.STATE_PATH, "utf8"), legacyText,
    "startup compaction must wait for an atomic coordinated snapshot instead of opening a state/seal crash window");
  await store.saveRuntimeSnapshot(migrated, {}, { outbox: [] });
  const migratedText = await readFile(store.STATE_PATH, "utf8");
  assert.ok(Buffer.byteLength(migratedText, "utf8") < legacyBytes / 5,
    "the next coordinated snapshot must persist the one-time legacy event compaction");
  assert.ok(Buffer.byteLength(JSON.stringify(migrated.events[0]), "utf8") <= store.STATE_EVENT_MAX_BYTES);
  const verification = await verifyStateTextSeal(migratedText, {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.STATE_SEAL_PATH
  });
  assert.equal(verification.ok, true);
  await store.loadState();
  assert.equal(await readFile(store.STATE_PATH, "utf8"), migratedText,
    "event migration must be idempotent and avoid a startup rewrite loop");

  const legacyFunctionalState = defaultState();
  delete (legacyFunctionalState as Partial<typeof legacyFunctionalState>).functionalEvents;
  const migrationNow = new Date();
  const migrationDayStart = new Date(migrationNow);
  migrationDayStart.setHours(0, 0, 0, 0);
  const migrationStartedAt = new Date(Math.max(
    migrationDayStart.getTime(),
    migrationNow.getTime() - 70 * 60_000
  ));
  const migrationSession = {
    id: "legacy-functional-session",
    startedAt: migrationStartedAt.toISOString(),
    endsAt: new Date(migrationNow.getTime() + 60 * 60_000).toISOString()
  };
  legacyFunctionalState.events = [
    ...Array.from({ length: store.STATE_EVENT_HISTORY_MAX + 25 }, (_value, index) => ({
      id: `newer-noise-${index}`,
      type: "newer_diagnostic_noise",
      at: new Date(migrationNow.getTime() - index).toISOString(),
      detail: { index }
    })),
    {
      id: "legacy-functional-block",
      type: "blocked_site",
      at: new Date(migrationNow.getTime() - 5 * 60_000).toISOString(),
      detail: { site: "legacy-functional.example", app: "Safari" }
    },
    {
      id: "legacy-functional-end",
      type: "session_ended",
      at: migrationNow.toISOString(),
      detail: migrationSession
    },
    {
      id: "legacy-functional-start",
      type: "session_started",
      at: migrationSession.startedAt,
      detail: migrationSession
    }
  ];
  await store.saveState(legacyFunctionalState);
  const migratedFunctionalState = await store.loadState();
  assert.equal(migratedFunctionalState.events.some((event) => ["blocked_site", "session_started", "session_ended"].includes(event.type)), false);
  assert.equal(interventionSummary(migratedFunctionalState, migrationNow).attempts, 1,
    "legacy functional events beyond the display-history cap must migrate into the safety ledger");
  const migratedFunctionalUsage = usageSummary({}, migratedFunctionalState, migrationNow);
  assert.equal(migratedFunctionalUsage.blockCount, 1);
  const expectedMigratedProtectedSeconds = Math.floor((migrationNow.getTime() - migrationStartedAt.getTime()) / 1000);
  assert.ok(migratedFunctionalUsage.protectedSeconds >= Math.max(0, expectedMigratedProtectedSeconds - 2),
    "legacy completed sessions beyond the display-history cap must retain protected-time accounting");
  assert.ok(migratedFunctionalState.functionalEvents.firstSessionStartedAt);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
