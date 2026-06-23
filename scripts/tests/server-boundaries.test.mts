import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { BRICK_MODE_PROFILE_ID, defaultState } from "../../src/defaults.js";
import { buildBackupExport, backupExportFilename } from "../../src/server/backupRoutes.js";
import { externalNetworkBlockSummary } from "../../src/externalNetworkBlock.js";
import { hardeningActions, hostsDetail, launchAgentDetail } from "../../src/server/hardeningSummary.js";
import { contentType, resolvePublicPath, securityHeaders } from "../../src/server/http.js";
import { createLocalScriptRunner, shellQuote, appleScriptString } from "../../src/server/localScripts.js";
import { commitmentLockError, escapeHtml, safeScriptJson } from "../../src/server/pages.js";
import { handleSessionApiRoute, previewManualSession } from "../../src/server/sessionRoutes.js";
import type { ActivePolicy, Session } from "../../src/types.js";

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
assert.equal(backupExportFilename(new Date("2026-06-04T12:34:56.789Z")), "vigil-backup-2026-06-04T12-34-56Z.json");

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

const backupState = defaultState();
backupState.keyholder = {
  enabled: true,
  salt: "keyholder-salt",
  hash: "keyholder-hash",
  updatedAt: "2026-06-04T12:00:00.000Z"
};
backupState.distanceKey = {
  enabled: true,
  salt: "distance-salt",
  hash: "distance-hash",
  keyFilePath: "/Volumes/Vigil/key.txt",
  updatedAt: "2026-06-04T12:00:00.000Z",
  lastVerifiedAt: null,
  lastFileVerifiedAt: null
};
backupState.deviceControls.ios.removalPassword = "remove-me";
backupState.deviceControls.ios.mdm.publicBaseUrl = "https://vigil.example.test";
backupState.deviceControls.ios.mdm.enrollmentSecret = "enroll-secret";
backupState.deviceControls.ios.mdm.identityCertificatePayloadBase64 = "identity-payload";
backupState.deviceControls.ios.mdm.identityCertificatePassword = "identity-password";
backupState.deviceControls.ios.mdm.pushCertificatePayloadBase64 = "push-payload";
backupState.deviceControls.ios.mdm.pushCertificatePassword = "push-password";
backupState.deviceControls.ios.mdm.devices = [{ udid: "phone-1", token: "push-token", tokenHex: "70757368" }];
backupState.deviceControls.ios.mdm.commands = [{ requestType: "InstallProfile", profileBase64: "mobileconfig" }];
backupState.events = [{
  id: "event-1",
  type: "ios_mdm_link",
  detail: { enrollmentUrl: "https://vigil.example.test/mdm/enroll.mobileconfig?token=secret" },
  at: "2026-06-04T12:00:00.000Z"
}];
const backup = recordValue(buildBackupExport({
  state: backupState,
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
}), "backup export");
const backupMetadata = recordValue(backup.metadata, "backup metadata");
const backupCounts = recordValue(backupMetadata.counts, "backup counts");
const backupSensitiveFields = recordValue(backupMetadata.sensitiveFields, "backup sensitive fields");
const redactedPaths = arrayValue(backupSensitiveFields.redactedPaths, "backup redacted paths").map(String);
assert.equal(recordValue(backup.app, "backup app").backupExportVersion, 1);
assert.equal(backupMetadata.exportedAt, "2026-06-04T12:34:56.789Z");
assert.equal(recordValue(backupMetadata.restore, "restore metadata").supported, false);
assert.equal(backupCounts.usageDays, 1);
assert.ok(redactedPaths.includes("state.keyholder.hash"));
assert.ok(redactedPaths.includes("state.distanceKey.salt"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.enrollmentSecret"));
assert.ok(redactedPaths.includes("state.deviceControls.ios.mdm.devices[0].tokenHex"));
assert.ok(redactedPaths.includes("state.events[0].detail.enrollmentUrl"));
const exportedState = recordValue(backup.state, "backup state");
assert.equal(recordValue(exportedState.keyholder, "backup keyholder").hash, "[REDACTED]");
assert.equal(recordValue(exportedState.distanceKey, "backup distance key").keyFilePath, "/Volumes/Vigil/key.txt");
const exportedIos = recordValue(recordValue(exportedState.deviceControls, "backup device controls").ios, "backup ios");
assert.equal(exportedIos.removalPassword, "[REDACTED]");
const exportedMdm = recordValue(exportedIos.mdm, "backup mdm");
assert.equal(exportedMdm.publicBaseUrl, "https://vigil.example.test");
assert.equal(exportedMdm.enrollmentSecret, "[REDACTED]");
assert.equal(recordValue(arrayValue(exportedMdm.devices, "backup mdm devices")[0], "backup mdm device").token, "[REDACTED]");
assert.equal(recordValue(arrayValue(exportedMdm.commands, "backup mdm commands")[0], "backup mdm command").profileBase64, "[REDACTED]");
const exportedEvent = recordValue(arrayValue(exportedState.events, "backup events")[0], "backup event");
assert.match(
  String(recordValue(exportedEvent.detail, "backup event detail").enrollmentUrl),
  /token=%5BREDACTED%5D/
);
assert.equal(recordValue(recordValue(backup.usage, "backup usage")["2026-06-04"], "backup usage day").totalSeconds, 12);

const electronProcess = {
  ...process,
  env: {
    VIGIL_DATA_DIR: "/tmp/vigil state"
  },
  execPath: "/usr/local/bin/node",
  versions: {
    ...process.versions,
    electron: "42.0.0"
  }
};
const runner = createLocalScriptRunner({
  root: "/Applications/Vigil.app/Contents/Resources/app.asar/dist/runtime",
  launchAgentStatus: async () => ({ running: true }),
  processObject: electronProcess
});

assert.equal(
  runner.resourcePath("scripts", "apply-hosts.mjs"),
  "/Applications/Vigil.app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/apply-hosts.mjs"
);
const privilegedCommand = runner.localScriptCommand("apply-hosts.mjs", { privileged: true });
assert.match(privilegedCommand, /^sudo /);
assert.match(privilegedCommand, /ELECTRON_RUN_AS_NODE='1'/);
assert.match(privilegedCommand, /VIGIL_DATA_DIR='\/tmp\/vigil state'/);
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
