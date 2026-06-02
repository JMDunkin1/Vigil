import assert from "node:assert/strict";
import { join } from "node:path";
import { hardeningActions, hostsDetail, launchAgentDetail } from "../../src/server/hardeningSummary.js";
import { contentType, resolvePublicPath, securityHeaders } from "../../src/server/http.js";
import { createLocalScriptRunner, shellQuote, appleScriptString } from "../../src/server/localScripts.js";
import { commitmentLockError, escapeHtml, safeScriptJson } from "../../src/server/pages.js";
import type { ActivePolicy } from "../../src/types.js";

const publicDir = join(process.cwd(), "public");

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
assert.equal(actions.sourceSeal.command, "cmd:seal-source.mjs:seal:source:user");
assert.equal(actions.extensionLoad.path, "/resources/extension");

assert.equal(shellQuote("it's here"), "'it'\\''s here'");
assert.equal(appleScriptString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');

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
