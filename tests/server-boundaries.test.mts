import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { BRICK_MODE_PROFILE_ID, defaultState } from "../src/defaults.js";
import { buildDiagnosticExport, diagnosticExportFilename } from "../src/server/diagnosticExportRoutes.js";
import { externalNetworkBlockSummary } from "../src/externalNetworkBlock.js";
import { hardeningActions, hostsDetail, launchAgentDetail } from "../src/server/hardeningSummary.js";
import { contentType, resolvePublicPath, securityHeaders } from "../src/server/http.js";
import { createLocalScriptRunner, shellQuote, appleScriptString } from "../src/server/localScripts.js";
import { commitmentLockError, escapeHtml, safeScriptJson } from "../src/server/pages.js";
import { handleSessionApiRoute, previewManualSession } from "../src/server/sessionRoutes.js";
import { activePolicy } from "../src/policy.js";
import type { ActivePolicy, Session } from "../src/types.js";

const publicDir = join(process.cwd(), "public");

function recordValue(value: unknown, label = "value"): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label = "value"): unknown[] {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value;
}

assert.equal(resolvePublicPath("/", publicDir), join(publicDir, "index.html"));
assert.equal(resolvePublicPath("/app.js", publicDir), join(publicDir, "app.js"));
assert.equal(resolvePublicPath("/../package.json", publicDir), null);
assert.equal(resolvePublicPath("/%2e%2e/package.json", publicDir), null);
assert.equal(resolvePublicPath("/bad%zz", publicDir), null);

assert.equal(contentType("public/app.js"), "text/javascript; charset=utf-8");
assert.equal(contentType("public/styles.css"), "text/css; charset=utf-8");
assert.equal(contentType("public/audio/baroque/bach-goldberg-aria-harpsichord.ogg"), "audio/ogg");
assert.equal(contentType("public/audio/nature/rain.ogg"), "audio/ogg");
assert.equal(contentType("unknown.bin"), "application/octet-stream");
assert.equal(securityHeaders()["X-Content-Type-Options"], "nosniff");
assert.match(securityHeaders()["Content-Security-Policy"], /frame-ancestors 'none'/);
assert.equal(diagnosticExportFilename(new Date("2026-06-04T12:34:56.789Z")), "sentinel-diagnostic-2026-06-04T12-34-56Z.json");

const previewState = defaultState();
previewState.deviceControls.ios.enabled = true;
const preview = previewManualSession(previewState, {
  title: "Full Brick",
  mode: "brick",
  profileId: BRICK_MODE_PROFILE_ID,
  durationMinutes: 90,
  lockLevel: "deep",
  commitmentLock: true,
  deviceTargets: ["computer", "phone"]
}, new Date("2026-06-04T12:00:00.000Z"));
assert.equal(preview.title, "Full Brick");
assert.equal(preview.deviceLabel, "Computer + iPhone");
assert.equal(preview.profileMode, "allowlist");
assert.equal(preview.commitmentLock, true);
assert.equal(preview.phone.targeted, true);
assert.equal(preview.phone.ready, true);
assert.ok(preview.allowedApps.includes("Mail"));
assert.ok(preview.protections.includes("Browser settings and extensions controls"));
assert.equal(previewState.activeSession, null);

const conflictState = defaultState();
const existingSession: Session = {
  id: "active",
  title: "Existing",
  mode: "focus",
  profileId: "default",
  lockLevel: "light",
  startedAt: "2026-06-04T11:00:00.000Z",
  endsAt: "2026-06-04T13:00:00.000Z",
  canEndEarly: true,
  source: "manual",
  deviceTargets: ["computer"]
};
conflictState.activeSessions = { computer: existingSession, phone: null };
conflictState.activeSession = existingSession;
const conflictPreview = previewManualSession(conflictState, {
  profileId: "default",
  durationMinutes: 25,
  deviceTargets: ["computer"]
}, new Date("2026-06-04T12:00:00.000Z"));
assert.deepEqual(conflictPreview.conflicts, ["computer"]);

{
  const routeState = defaultState();
  let strictPreflightCalls = 0;
  await assert.rejects(
    handleSessionApiRoute(
      mockSessionRequest("POST", "/api/session/preview", {
        title: "Full Brick",
        mode: "brick",
        profileId: BRICK_MODE_PROFILE_ID,
        durationMinutes: 90,
        lockLevel: "deep",
        commitmentLock: true,
        deviceTargets: ["computer"]
      }),
      mockSessionResponse(),
      {
        state: routeState,
        recordIosMdmPolicyQueue: () => null,
        scheduleImmediateSessionEnforcement: () => {},
        assertStrictLockAllowed: async () => {
          strictPreflightCalls += 1;
          throw new Error("strict preflight failed");
        }
      }
    ),
    /strict preflight failed/
  );
  assert.equal(strictPreflightCalls, 1);
}

{
  const routeState = defaultState();
  const activeRouteSession: Session = {
    ...existingSession,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };
  routeState.activeSessions = { computer: activeRouteSession, phone: null };
  routeState.activeSession = activeRouteSession;
  let strictPreflightCalls = 0;
  const response = mockSessionResponse();
  const handled = await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/session/preview", {
      profileId: "default",
      durationMinutes: 25,
      lockLevel: "deep",
      deviceTargets: ["computer"]
    }),
    response,
    {
      state: routeState,
      recordIosMdmPolicyQueue: () => null,
      scheduleImmediateSessionEnforcement: () => {},
      assertStrictLockAllowed: async () => {
        strictPreflightCalls += 1;
      }
    }
  );
  const body = recordValue(JSON.parse(response.bodyText), "preview response");
  const previewBody = recordValue(body.preview, "preview response preview");
  assert.equal(handled, true);
  assert.equal(response.statusCodeValue, 200);
  assert.deepEqual(previewBody.conflicts, ["computer"]);
  assert.equal(strictPreflightCalls, 0);
}

{
  const routeState = defaultState();
  routeState.settings.emergencyDelaySeconds = 0;
  const phoneSession: Session = {
    ...existingSession,
    id: "phone-only-emergency",
    title: "Phone Only Emergency",
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    emergencyUnlocksAllowed: true,
    deviceTargets: ["phone"]
  };
  routeState.activeSessions = { computer: null, phone: phoneSession };
  routeState.activeSession = null;
  let queuedReason = "";
  const context = {
    state: routeState,
    recordIosMdmPolicyQueue: (reason: string) => {
      queuedReason = reason;
      return null;
    },
    scheduleImmediateSessionEnforcement: () => {},
    assertStrictLockAllowed: async () => {}
  };

  const requestResponse = mockSessionResponse();
  const requestHandled = await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/request", {
      reason: "I need to temporarily unlock my phone for a legitimate urgent task."
    }),
    requestResponse,
    context
  );
  const requestBody = recordValue(JSON.parse(requestResponse.bodyText), "phone emergency request response");
  const pending = recordValue(requestBody.pending, "phone emergency pending");
  assert.equal(requestHandled, true);
  assert.equal(requestResponse.statusCodeValue, 200);
  assert.equal(pending.activeKind, "manual");
  assert.equal(pending.sessionId, "phone-only-emergency");
  const storedPending = routeState.emergency.pending.find((item) => item.id === pending.id);
  assert.ok(storedPending, "phone emergency request should be stored");
  storedPending.eligibleAt = new Date(Date.now() - 1000).toISOString();

  const confirmResponse = mockSessionResponse();
  const confirmHandled = await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/confirm", {
      requestId: pending.id,
      challengeText: String(recordValue(pending.challenge, "phone emergency challenge").text || "")
    }),
    confirmResponse,
    context
  );
  assert.equal(confirmHandled, true);
  assert.equal(confirmResponse.statusCodeValue, 200);
  assert.equal(recordValue(JSON.parse(confirmResponse.bodyText), "phone emergency confirm response").ok, true);
  assert.equal(routeState.activeSessions.phone, null);
  assert.equal(routeState.activeSession, null);
  assert.equal(queuedReason, "emergency-unlock");
}

{
  const routeState = defaultState();
  const phoneSession: Session = {
    ...existingSession,
    id: "phone-only-commitment",
    title: "Phone Only Commitment",
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    deviceTargets: ["phone"]
  };
  routeState.activeSessions = { computer: null, phone: phoneSession };
  routeState.activeSession = null;
  const response = mockSessionResponse();
  const handled = await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/request", {
      reason: "I want to bypass the commitment lock on the phone right now."
    }),
    response,
    {
      state: routeState,
      recordIosMdmPolicyQueue: () => null,
      scheduleImmediateSessionEnforcement: () => {},
      assertStrictLockAllowed: async () => {}
    }
  );
  const body = recordValue(JSON.parse(response.bodyText), "phone commitment emergency response");
  assert.equal(handled, true);
  assert.equal(response.statusCodeValue, 423);
  assert.equal(body.error, "This commitment lock does not allow emergency unlocks. Open a protected maintenance window if this was a mistake.");
  assert.equal(recordValue(body.active, "phone commitment active").id, "phone-only-commitment");
  assert.equal(routeState.activeSessions.phone?.id, "phone-only-commitment");
}

{
  const routeState = defaultState();
  routeState.settings.emergencyDelaySeconds = 0;
  const now = new Date();
  const scheduleClock = (value: Date) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  const scheduleStart = scheduleClock(new Date(now.getTime() - 30 * 60 * 1000));
  const scheduleEnd = scheduleClock(new Date(now.getTime() + 30 * 60 * 1000));
  const manualSession: Session = {
    ...existingSession,
    id: "combined-emergency-manual",
    title: "Combined emergency manual",
    lockLevel: "deep",
    startedAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    endsAt: new Date(now.getTime() + 90 * 60 * 1000).toISOString(),
    canEndEarly: false,
    emergencyUnlocksAllowed: true,
    deviceTargets: ["computer"]
  };
  routeState.activeSessions = { computer: manualSession, phone: null };
  routeState.activeSession = manualSession;
  routeState.intentionalUse.planBlocks = [{
    id: "combined-emergency-planner",
    title: "Combined emergency planner",
    notes: "",
    listId: "",
    itemId: "",
    startsAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    endsAt: new Date(now.getTime() + 45 * 60 * 1000).toISOString(),
    enabled: true,
    completed: false,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    commitmentLock: false,
    deviceTargets: ["computer"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }];
  routeState.schedules = [
    {
      id: "combined-emergency-schedule",
      name: "Combined emergency schedule",
      enabled: true,
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      commitmentLock: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: scheduleStart,
      end: scheduleEnd,
      wifiNetworks: [],
      deviceTargets: ["computer"]
    },
    {
      id: "unrelated-phone-schedule",
      name: "Unrelated phone schedule",
      enabled: true,
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      commitmentLock: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: scheduleStart,
      end: scheduleEnd,
      wifiNetworks: [],
      deviceTargets: ["phone"]
    }
  ];
  const context = {
    state: routeState,
    recordIosMdmPolicyQueue: () => null,
    scheduleImmediateSessionEnforcement: () => {},
    assertStrictLockAllowed: async () => {}
  };

  const requestResponse = mockSessionResponse();
  await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/request", {
      reason: "I need to release this combined focus policy for an urgent necessary task."
    }),
    requestResponse,
    context
  );
  assert.equal(requestResponse.statusCodeValue, 200);
  const requestBody = recordValue(JSON.parse(requestResponse.bodyText), "combined emergency request response");
  const pending = recordValue(requestBody.pending, "combined emergency pending");
  const contributors = arrayValue(pending.policyContributors, "combined emergency contributors").map((item) => (
    recordValue(item, "combined emergency contributor")
  ));
  assert.deepEqual(
    new Set(contributors.map((contributor) => contributor.kind)),
    new Set(["manual", "planner", "schedule"])
  );
  assert.equal(contributors.length, 3);
  const storedPending = routeState.emergency.pending.find((item) => item.id === pending.id);
  assert.ok(storedPending, "combined emergency request should be stored");
  storedPending.eligibleAt = new Date(Date.now() - 1000).toISOString();

  const confirmResponse = mockSessionResponse();
  await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/confirm", {
      requestId: pending.id,
      challengeText: String(recordValue(pending.challenge, "combined emergency challenge").text || "")
    }),
    confirmResponse,
    context
  );
  assert.equal(confirmResponse.statusCodeValue, 200);
  const confirmBody = recordValue(JSON.parse(confirmResponse.bodyText), "combined emergency confirm response");
  assert.equal(arrayValue(confirmBody.releasedPolicyContributors, "released policy contributors").length, 3);
  assert.equal(routeState.activeSessions.computer, null);
  assert.equal(routeState.intentionalUse.planBlocks[0]?.completed, true);
  assert.equal(routeState.overrides.some((override) => override.scheduleId === "combined-emergency-schedule"), true);
  assert.equal(routeState.overrides.some((override) => override.scheduleId === "unrelated-phone-schedule"), false);
  assert.equal(activePolicy(routeState, new Date(), { device: "computer" }), null);
  assert.equal(activePolicy(routeState, new Date(), { device: "phone" })?.schedule?.id, "unrelated-phone-schedule");
  assert.equal(Object.values(routeState.emergency.tokensUsedByWeek).reduce((total, count) => total + count, 0), 1);
}

{
  const routeState = defaultState();
  routeState.settings.emergencyDelaySeconds = 0;
  const activeSession: Session = {
    ...existingSession,
    id: "expired-emergency-session",
    title: "Expired emergency session",
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    emergencyUnlocksAllowed: true,
    deviceTargets: ["computer"]
  };
  routeState.activeSessions = { computer: activeSession, phone: null };
  routeState.activeSession = activeSession;
  let queuedReason = "";
  const context = {
    state: routeState,
    recordIosMdmPolicyQueue: (reason: string) => {
      queuedReason = reason;
      return null;
    },
    scheduleImmediateSessionEnforcement: () => {},
    assertStrictLockAllowed: async () => {}
  };
  const requestResponse = mockSessionResponse();
  await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/request", {
      reason: "I need this emergency request for a legitimate urgent task."
    }),
    requestResponse,
    context
  );
  const requestBody = recordValue(JSON.parse(requestResponse.bodyText), "expiring emergency request response");
  const pending = recordValue(requestBody.pending, "expiring emergency pending");
  const storedPending = routeState.emergency.pending.find((item) => item.id === pending.id);
  assert.ok(storedPending, "expiring emergency request should be stored");
  storedPending.eligibleAt = new Date(Date.now() - 2000).toISOString();
  storedPending.expiresAt = new Date(Date.now() - 1000).toISOString();

  const confirmBody = {
    requestId: pending.id,
    challengeText: String(recordValue(pending.challenge, "expiring emergency challenge").text || "")
  };
  const confirmResponse = mockSessionResponse();
  await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/confirm", confirmBody),
    confirmResponse,
    context
  );
  assert.equal(confirmResponse.statusCodeValue, 410);
  assert.equal(storedPending.status, "expired");
  assert.equal(routeState.activeSessions.computer?.id, "expired-emergency-session");
  assert.equal(Object.values(routeState.emergency.tokensUsedByWeek).reduce((total, count) => total + count, 0), 0);
  assert.equal(queuedReason, "");

  const repeatedResponse = mockSessionResponse();
  await handleSessionApiRoute(
    mockSessionRequest("POST", "/api/emergency/confirm", confirmBody),
    repeatedResponse,
    context
  );
  assert.equal(repeatedResponse.statusCodeValue, 404);
  assert.equal(Object.values(routeState.emergency.tokensUsedByWeek).reduce((total, count) => total + count, 0), 0);
}

assert.equal(escapeHtml(`<script>"&'</script>`), "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
assert.equal(safeScriptJson({ value: "</script>&" }).includes("</script>"), false);
assert.equal(safeScriptJson({ value: "</script>&" }).includes("&"), false);
const panicPolicy: ActivePolicy = {
  kind: "panic",
  session: {
    id: "panic",
    title: "Panic",
    mode: "panic",
    profileId: "panic",
    lockLevel: "deep",
    startedAt: "2026-06-01T12:00:00.000Z",
    endsAt: "2026-06-01T12:05:00.000Z"
  },
  profile: {
    id: "panic",
    name: "Panic",
    mode: "allowlist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  },
  endsAt: "2026-06-01T12:05:00.000Z"
};
assert.equal(commitmentLockError(panicPolicy), "Panic lockout cannot be ended early.");

assert.match(hostsDetail({ partial: true }), /markers are incomplete/);
assert.match(hostsDetail({ installed: true, installedEntries: 10, expectedEntries: 10 }), /current \(10 entries\)/);
assert.match(launchAgentDetail({ installed: true, loaded: true, running: true, pid: 42 }), /PID 42/);

const actions = hardeningActions({
  localScriptCommand(name, options = {}) {
    return `cmd:${name}:${options.npmScript || ""}:${options.privileged ? "privileged" : "user"}`;
  },
  resourcePath(...parts) {
    return `/resources/${parts.join("/")}`;
  }
});
assert.equal(actions.hostsApply.command, "cmd:apply-hosts.mjs:network:apply:privileged");
assert.equal(actions.safariFilterApply.command, "cmd:apply-safari-filter.mjs:safari:apply:user");
assert.equal(actions.adultBlocklistRefresh.command, "cmd:refresh-adult-blocklist.mjs:adult:blocklist:refresh:user");
assert.equal(actions.sourceSeal.command, "cmd:seal-source.mjs:seal:source:user");
assert.equal(actions.extensionLoad.path, "/resources/extension");

const externalNetworkState = defaultState();
externalNetworkState.settings.externalNetworkBlockEnabled = true;
const externalNetwork = externalNetworkBlockSummary(externalNetworkState);
assert.equal(externalNetwork.provider, "manual");
assert.equal(externalNetwork.ready, true);
assert.equal(externalNetwork.current, false);
assert.ok(externalNetwork.targetDomainCount > 0);
assert.equal(externalNetwork.targetDomainCount, externalNetwork.targetDomains.length);
assert.equal(externalNetwork.targetDomains.includes("pornhub.com"), true);
assert.match(externalNetwork.signature, /^[a-f0-9]{16}$/);

assert.equal(shellQuote("it's here"), "'it'\\''s here'");
assert.equal(appleScriptString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');

const diagnosticState = defaultState();
diagnosticState.keyholder = {
  enabled: true,
  salt: "keyholder-salt",
  hash: "keyholder-hash",
  updatedAt: "2026-06-04T12:00:00.000Z"
};
diagnosticState.distanceKey = {
  enabled: true,
  salt: "distance-salt",
  hash: "distance-hash",
  keyFilePath: "/Volumes/Sentinel/key.txt",
  updatedAt: "2026-06-04T12:00:00.000Z",
  lastVerifiedAt: null,
  lastFileVerifiedAt: null
};
diagnosticState.deviceControls.ios.removalPassword = "remove-me";
diagnosticState.deviceControls.ios.mdm.publicBaseUrl = "https://sentinel.example.test";
diagnosticState.deviceControls.ios.mdm.enrollmentSecret = "enroll-secret";
diagnosticState.deviceControls.ios.mdm.identityCertificatePayloadBase64 = "identity-payload";
diagnosticState.deviceControls.ios.mdm.identityCertificatePassword = "identity-password";
diagnosticState.deviceControls.ios.mdm.pushCertificatePayloadBase64 = "push-payload";
diagnosticState.deviceControls.ios.mdm.pushCertificatePassword = "push-password";
diagnosticState.deviceControls.ios.mdm.enrollmentTokens = [{
  hash: "a".repeat(64),
  createdAt: "2026-06-04T12:00:00.000Z",
  boundUdid: "bound-phone-1"
}];
diagnosticState.deviceControls.ios.mdm.devices = [{
  id: "mdm-device-1",
  udid: "phone-1",
  token: "push-token",
  tokenHex: "70757368",
  unlockToken: "unlock-token",
  pushMagic: "push-magic",
  info: {
    SerialNumber: "serial-number-1",
    DeviceIdentifier: "device-identifier-1"
  }
}];
diagnosticState.deviceControls.ios.mdm.commands = [{ requestType: "InstallProfile", profileBase64: "mobileconfig" }];
diagnosticState.intentionalUse.journalEntries = [{
  id: "journal-entry",
  title: "Journal title",
  body: "Journal body that must not appear in diagnostics",
  mood: "calm",
  energy: 2,
  tags: ["reflection"],
  behaviorIds: [],
  ruleIds: [],
  createdAt: "2026-06-04T12:00:00.000Z",
  updatedAt: "2026-06-04T12:00:00.000Z",
  entryDate: "2026-06-04"
}];
diagnosticState.events = [{
  id: "event-1",
  type: "ios_mdm_link",
  detail: { enrollmentUrl: "https://sentinel.example.test/mdm/enroll.mobileconfig?token=secret" },
  at: "2026-06-04T12:00:00.000Z"
}];
const diagnostic = recordValue(buildDiagnosticExport({
  state: diagnosticState,
  usage: {
    "2026-06-04": {
      totalSeconds: 12,
      apps: { Safari: 12 },
      sites: {},
      opens: { apps: { Safari: 1 }, sites: {} },
      devices: {
        computer: {
          totalSeconds: 12,
          apps: { Safari: 12 },
          sites: {},
          opens: { apps: { Safari: 1 }, sites: {} }
        }
      }
    }
  },
  activePort: 8799,
  startedAt: "2026-06-04T11:00:00.000Z",
  now: new Date("2026-06-04T12:34:56.789Z")
}), "diagnostic export");
const diagnosticMetadata = recordValue(diagnostic.metadata, "diagnostic metadata");
const diagnosticCounts = recordValue(diagnosticMetadata.counts, "diagnostic counts");
const diagnosticSensitiveFields = recordValue(diagnosticMetadata.sensitiveFields, "diagnostic sensitive fields");
const redactedPaths = arrayValue(diagnosticSensitiveFields.redactedPaths, "diagnostic redacted paths").map(String);
assert.equal(recordValue(diagnostic.app, "diagnostic app").diagnosticExportVersion, 1);
assert.equal(diagnosticMetadata.exportedAt, "2026-06-04T12:34:56.789Z");
assert.equal(diagnosticMetadata.purpose, "diagnostic-snapshot");
assert.equal(diagnosticCounts.usageDays, 1);
assert.ok(redactedPaths.includes("state.keyholder.hash"));
assert.ok(redactedPaths.includes("state.distanceKey.salt"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.enrollmentSecret"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].tokenHex"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].unlockToken"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].pushMagic"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].udid"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].info.SerialNumber"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].info.DeviceIdentifier"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.enrollmentTokens[0].boundUdid"));
assert.ok(redactedPaths.includes("state.events[0].detail.enrollmentUrl"));
assert.ok(redactedPaths.includes("state.intentionalUse.journalEntries"));
const exportedState = recordValue(diagnostic.state, "diagnostic state");
assert.equal(recordValue(exportedState.keyholder, "diagnostic keyholder").hash, "[REDACTED]");
assert.equal(recordValue(exportedState.distanceKey, "diagnostic distance key").keyFilePath, "/Volumes/Sentinel/key.txt");
const exportedIos = recordValue(recordValue(exportedState.deviceControls, "diagnostic device controls").ios, "diagnostic ios");
assert.equal(exportedIos.removalPassword, "[REDACTED]");
const exportedMdm = recordValue(exportedIos.mdm, "diagnostic mdm");
assert.equal(exportedMdm.publicBaseUrl, "https://sentinel.example.test");
assert.equal(exportedMdm.enrollmentSecret, "[REDACTED]");
const exportedMdmDevice = recordValue(arrayValue(exportedMdm.devices, "diagnostic mdm devices")[0], "diagnostic mdm device");
assert.equal(exportedMdmDevice.id, "mdm-device-1");
assert.equal(exportedMdmDevice.token, "[REDACTED]");
assert.equal(exportedMdmDevice.unlockToken, "[REDACTED]");
assert.equal(exportedMdmDevice.pushMagic, "[REDACTED]");
assert.equal(exportedMdmDevice.udid, "[REDACTED]");
assert.equal(recordValue(exportedMdmDevice.info, "diagnostic mdm device info").SerialNumber, "[REDACTED]");
assert.equal(recordValue(exportedMdmDevice.info, "diagnostic mdm device info").DeviceIdentifier, "[REDACTED]");
assert.equal(recordValue(arrayValue(exportedMdm.commands, "diagnostic mdm commands")[0], "diagnostic mdm command").profileBase64, "[REDACTED]");
const exportedEvent = recordValue(arrayValue(exportedState.events, "diagnostic events")[0], "diagnostic event");
assert.equal(recordValue(exportedState.intentionalUse, "diagnostic intentional use").journalEntries, "[REDACTED]");
assert.equal(JSON.stringify(diagnostic).includes("Journal title"), false);
assert.equal(JSON.stringify(diagnostic).includes("Journal body"), false);
assert.match(
  String(recordValue(exportedEvent.detail, "diagnostic event detail").enrollmentUrl),
  /token=%5BREDACTED%5D/
);
assert.equal(recordValue(recordValue(diagnostic.usage, "diagnostic usage")["2026-06-04"], "diagnostic usage day").totalSeconds, 12);

const electronProcess = {
  ...process,
  env: {
    SENTINEL_DATA_DIR: "/tmp/sentinel state"
  },
  execPath: "/usr/local/bin/node",
  versions: {
    ...process.versions,
    electron: "42.0.0"
  }
};
const runner = createLocalScriptRunner({
  root: "/Applications/Sentinel.app/Contents/Resources/app.asar/dist/runtime",
  launchAgentStatus: async () => ({ running: true }),
  processObject: electronProcess
});

assert.equal(
  runner.resourcePath("scripts", "apply-hosts.mjs"),
  "/Applications/Sentinel.app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/apply-hosts.mjs"
);
const privilegedCommand = runner.localScriptCommand("apply-hosts.mjs", { privileged: true });
assert.match(privilegedCommand, /^sudo /);
assert.match(privilegedCommand, /ELECTRON_RUN_AS_NODE='1'/);
assert.match(privilegedCommand, /SENTINEL_DATA_DIR='\/tmp\/sentinel state'/);
assert.match(privilegedCommand, /app\.asar\.unpacked\/dist\/runtime\/scripts\/apply-hosts\.mjs/);

function mockSessionRequest(method: string, url: string, body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, { method, url, headers: { "content-type": "application/json" } }) as IncomingMessage;
}

interface MockSessionResponse {
  statusCodeValue?: number;
  bodyText: string;
  headersValue: Record<string, unknown>;
  writeHead(statusCode: number, headers?: Record<string, unknown>): MockSessionResponse;
  end(chunk?: unknown): MockSessionResponse;
}

function mockSessionResponse(): ServerResponse & MockSessionResponse {
  const target: MockSessionResponse = {
    bodyText: "",
    headersValue: {},
    writeHead(statusCode: number, headers: Record<string, unknown> = {}) {
      this.statusCodeValue = statusCode;
      this.headersValue = headers;
      return this;
    },
    end(chunk?: unknown) {
      this.bodyText += chunk ? String(chunk) : "";
      return this;
    }
  };
  return target as ServerResponse & MockSessionResponse;
}
