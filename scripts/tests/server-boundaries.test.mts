import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultState } from "../../src/defaults.js";
import { buildBackupExport, backupExportFilename } from "../../src/server/backupRoutes.js";
import { hardeningActions, hostsDetail, launchAgentDetail } from "../../src/server/hardeningSummary.js";
import { contentType, resolvePublicPath, securityHeaders } from "../../src/server/http.js";
import { createLocalScriptRunner, shellQuote, appleScriptString } from "../../src/server/localScripts.js";
import { commitmentLockError, escapeHtml, safeScriptJson } from "../../src/server/pages.js";
import type { ActivePolicy } from "../../src/types.js";

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
assert.equal(contentType("unknown.bin"), "application/octet-stream");
assert.equal(securityHeaders()["X-Content-Type-Options"], "nosniff");
assert.match(securityHeaders()["Content-Security-Policy"], /frame-ancestors 'none'/);
assert.equal(backupExportFilename(new Date("2026-06-04T12:34:56.789Z")), "sentinel-backup-2026-06-04T12-34-56Z.json");

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
  keyFilePath: "/Volumes/Sentinel/key.txt",
  updatedAt: "2026-06-04T12:00:00.000Z",
  lastVerifiedAt: null,
  lastFileVerifiedAt: null
};
backupState.deviceControls.ios.removalPassword = "remove-me";
backupState.deviceControls.ios.mdm.publicBaseUrl = "https://sentinel.example.test";
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
  detail: { enrollmentUrl: "https://sentinel.example.test/mdm/enroll.mobileconfig?token=secret" },
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
assert.equal(recordValue(exportedState.distanceKey, "backup distance key").keyFilePath, "/Volumes/Sentinel/key.txt");
const exportedIos = recordValue(recordValue(exportedState.deviceControls, "backup device controls").ios, "backup ios");
assert.equal(exportedIos.removalPassword, "[REDACTED]");
const exportedMdm = recordValue(exportedIos.mdm, "backup mdm");
assert.equal(exportedMdm.publicBaseUrl, "https://sentinel.example.test");
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
