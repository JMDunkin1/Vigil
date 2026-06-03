import assert from "node:assert/strict";
import { accountStatusFromGroups, parseGroups } from "../../src/account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, deviceUsageSyncAuthorization, EXTENSION_TOKEN_HEADER, extensionCorsHeaders, extensionRequestGuard, isTrustedExtensionRequest, publicHostGuard } from "../../src/apiSecurity.js";
import { parseBoolean } from "../../src/booleans.js";
import { normalizeIosMdmSettings } from "../../src/iosMdm.js";
import { normalizeLimitRule } from "../../src/limits.js";

assert.deepEqual(parseGroups("staff admin everyone staff"), ["admin", "everyone", "staff"]);
const admin = accountStatusFromGroups("daily", "staff admin everyone");
assert.equal(admin.ok, false);
assert.equal(admin.isAdmin, true);
const standard = accountStatusFromGroups("focus", "staff everyone");
assert.equal(standard.ok, true);
assert.equal(standard.isAdmin, false);

assert.equal(parseBoolean("false", true), false);
assert.equal(parseBoolean("0", true), false);
assert.equal(parseBoolean("off", true), false);
assert.equal(parseBoolean("true", false), true);
assert.equal(parseBoolean("on", false), true);
assert.equal(parseBoolean("not-a-bool", true), true);
assert.equal(normalizeLimitRule({ enabled: "false" }, { enabled: true }, "limit").enabled, false);
const mdmBooleans = normalizeIosMdmSettings({
  enabled: "false",
  signMessage: "false",
  useDevelopmentApns: "false",
  checkOutWhenRemoved: "false"
}, {
  enabled: true,
  signMessage: true,
  useDevelopmentApns: true,
  checkOutWhenRemoved: true
});
assert.equal(mdmBooleans.enabled, false);
assert.equal(mdmBooleans.signMessage, false);
assert.equal(mdmBooleans.useDevelopmentApns, false);
assert.equal(mdmBooleans.checkOutWhenRemoved, false);
assert.equal(apiRequestGuard({ method: "GET", path: "/api/state", headers: {} }).ok, true);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/check", headers: {} }).ok, false);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/rules/sync", headers: { "content-type": "application/json" } }).ok, false);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/pause/continue", headers: { "content-type": "application/json" } }).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "DELETE",
  path: "/api/schedule/test",
  headers: {
    origin: "http://localhost:8787",
    "sec-fetch-site": "same-origin",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "https://example.com",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "cross-site",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "text/plain",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json"
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/devices/usage",
  headers: { origin: "https://phone.example", "content-type": "application/json" }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/extension/check",
  headers: {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);

const previousExtensionEnv = {
  VIGIL_EXTENSION_ORIGINS: process.env.VIGIL_EXTENSION_ORIGINS,
  VIGIL_EXTENSION_ORIGIN: process.env.VIGIL_EXTENSION_ORIGIN,
  VIGIL_EXTENSION_IDS: process.env.VIGIL_EXTENSION_IDS,
  VIGIL_EXTENSION_ID: process.env.VIGIL_EXTENSION_ID,
  VIGIL_EXTENSION_TOKEN: process.env.VIGIL_EXTENSION_TOKEN,
  VIGIL_EXTENSION_ORIGINS: process.env.VIGIL_EXTENSION_ORIGINS,
  VIGIL_EXTENSION_ORIGIN: process.env.VIGIL_EXTENSION_ORIGIN,
  VIGIL_EXTENSION_IDS: process.env.VIGIL_EXTENSION_IDS,
  VIGIL_EXTENSION_ID: process.env.VIGIL_EXTENSION_ID,
  VIGIL_EXTENSION_TOKEN: process.env.VIGIL_EXTENSION_TOKEN
};
try {
  for (const key of Object.keys(previousExtensionEnv)) delete process.env[key];
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({ origin: "chrome-extension://abc" }), false);

  process.env.VIGIL_EXTENSION_ORIGINS = "chrome-extension://abc";
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/extension/check",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/extension/pause/skip",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://xyz",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "text/plain"
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({ origin: "chrome-extension://abc" }), true);
  assert.equal(extensionCorsHeaders({ origin: "chrome-extension://abc" })["Access-Control-Allow-Origin"], "chrome-extension://abc");

  delete process.env.VIGIL_EXTENSION_ORIGINS;
  process.env.VIGIL_EXTENSION_TOKEN = "shared-extension-secret";
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://xyz",
      "content-type": "application/json",
      [EXTENSION_TOKEN_HEADER]: "shared-extension-secret"
    }
  }).ok, true);
  assert.equal(isTrustedExtensionRequest({ [EXTENSION_TOKEN_HEADER]: "shared-extension-secret" }), true);
  assert.equal(extensionCorsHeaders({ origin: "chrome-extension://xyz" })["Access-Control-Allow-Origin"], "chrome-extension://xyz");
} finally {
  for (const [key, value] of Object.entries(previousExtensionEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
assert.equal(isTrustedExtensionRequest({ origin: "http://127.0.0.1:8787" }), false);
assert.equal(extensionCorsHeaders({ origin: "https://example.com" })["Access-Control-Allow-Origin"], undefined);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "127.0.0.1:8787" } }).ok, true);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "localhost:8787" } }).ok, true);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "vigil.example.test" } }).ok, false);
assert.equal(publicHostGuard({ path: "/mdm/checkin", headers: { host: "vigil.example.test" } }).ok, true);
assert.equal(publicHostGuard({ path: "/api/devices/usage", headers: { host: "vigil.example.test" } }).ok, true);
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "127.0.0.1:8787", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("http://127.0.0.1:8787/api/devices/usage"),
  enrollmentSecret: "device-secret"
}), { ok: true, kind: "local-intent" });
assert.equal(deviceUsageSyncAuthorization({
  headers: { host: "vigil.example.test", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("https://vigil.example.test/api/devices/usage"),
  enrollmentSecret: "device-secret"
}).ok, false);
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "vigil.example.test", "x-vigil-device-token": "device-secret" },
  url: new URL("https://vigil.example.test/api/devices/usage"),
  enrollmentSecret: "device-secret"
}), { ok: true, kind: "device-token" });
