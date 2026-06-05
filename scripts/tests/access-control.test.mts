import assert from "node:assert/strict";
import { accountStatusFromGroups, parseGroups } from "../../src/account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, deviceUsageSyncAuthorization, EXTENSION_TOKEN_HEADER, extensionCorsHeaders, extensionRequestGuard, extensionTrustSummary, isTrustedExtensionRequest, publicHostGuard } from "../../src/apiSecurity.js";
import { parseBoolean } from "../../src/booleans.js";
import { iosMdmReadiness, normalizeIosMdmSettings } from "../../src/iosMdm.js";
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
assert.deepEqual(
  {
    status: iosMdmReadiness({ enabled: false }).status,
    capabilityLevel: iosMdmReadiness({ enabled: false }).capabilityLevel
  },
  { status: "off", capabilityLevel: "static-profile" }
);
const mdmQueueOnly = iosMdmReadiness({
  enabled: true,
  publicBaseUrl: "https://sentinel.example.test",
  topic: "com.apple.mgmt.sentinel",
  identityCertificateUuid: "11111111-1111-4111-8111-111111111111",
  identityCertificatePayloadBase64: "ZmFrZS1wa2NzMTI="
});
assert.equal(mdmQueueOnly.status, "queue-only");
assert.equal(mdmQueueOnly.capabilityLevel, "command-queue");
assert.equal(mdmQueueOnly.pushBlockers.length, 1);
const mdmWireless = iosMdmReadiness({
  ...mdmQueueOnly,
  enabled: true,
  publicBaseUrl: "https://sentinel.example.test",
  topic: "com.apple.mgmt.sentinel",
  identityCertificateUuid: "11111111-1111-4111-8111-111111111111",
  identityCertificatePayloadBase64: "ZmFrZS1wa2NzMTI=",
  pushCertificatePayloadBase64: "ZmFrZS1wdXNo"
});
assert.equal(mdmWireless.status, "ready");
assert.equal(mdmWireless.capabilityLevel, "wireless-push");
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
  SENTINEL_EXTENSION_ORIGINS: process.env.SENTINEL_EXTENSION_ORIGINS,
  SENTINEL_EXTENSION_ORIGIN: process.env.SENTINEL_EXTENSION_ORIGIN,
  SENTINEL_EXTENSION_IDS: process.env.SENTINEL_EXTENSION_IDS,
  SENTINEL_EXTENSION_ID: process.env.SENTINEL_EXTENSION_ID,
  SENTINEL_EXTENSION_TOKEN: process.env.SENTINEL_EXTENSION_TOKEN,
  SCREEN_TIME_EXTENSION_ORIGINS: process.env.SCREEN_TIME_EXTENSION_ORIGINS,
  SCREEN_TIME_EXTENSION_ORIGIN: process.env.SCREEN_TIME_EXTENSION_ORIGIN,
  SCREEN_TIME_EXTENSION_IDS: process.env.SCREEN_TIME_EXTENSION_IDS,
  SCREEN_TIME_EXTENSION_ID: process.env.SCREEN_TIME_EXTENSION_ID,
  SCREEN_TIME_EXTENSION_TOKEN: process.env.SCREEN_TIME_EXTENSION_TOKEN
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

  process.env.SENTINEL_EXTENSION_ORIGINS = "chrome-extension://abc";
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
  assert.deepEqual({
    trusted: extensionTrustSummary({ origin: "chrome-extension://abc" }).trusted,
    trustedBy: extensionTrustSummary({ origin: "chrome-extension://abc" }).trustedBy,
    suggestedIdEnv: extensionTrustSummary({ origin: "chrome-extension://abc" }).suggestedIdEnv
  }, {
    trusted: true,
    trustedBy: "origin",
    suggestedIdEnv: "SENTINEL_EXTENSION_ID=abc"
  });
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

  delete process.env.SENTINEL_EXTENSION_ORIGINS;
  process.env.SENTINEL_EXTENSION_TOKEN = "shared-extension-secret";
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://xyz",
      "content-type": "application/json",
      [EXTENSION_TOKEN_HEADER]: "shared-extension-secret"
    }
  }).ok, true);
  assert.deepEqual({
    trusted: extensionTrustSummary({
      origin: "chrome-extension://xyz",
      [EXTENSION_TOKEN_HEADER]: "shared-extension-secret"
    }).trusted,
    trustedBy: extensionTrustSummary({
      origin: "chrome-extension://xyz",
      [EXTENSION_TOKEN_HEADER]: "shared-extension-secret"
    }).trustedBy,
    tokenConfigured: extensionTrustSummary({
      origin: "chrome-extension://xyz",
      [EXTENSION_TOKEN_HEADER]: "shared-extension-secret"
    }).tokenConfigured
  }, {
    trusted: true,
    trustedBy: "token",
    tokenConfigured: true
  });
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
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "sentinel.example.test" } }).ok, false);
assert.equal(publicHostGuard({ path: "/mdm/checkin", headers: { host: "sentinel.example.test" } }).ok, true);
assert.equal(publicHostGuard({ path: "/api/devices/usage", headers: { host: "sentinel.example.test" } }).ok, true);
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "127.0.0.1:8787", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("http://127.0.0.1:8787/api/devices/usage"),
  enrollmentSecret: "device-secret"
}), { ok: true, kind: "local-intent" });
assert.equal(deviceUsageSyncAuthorization({
  headers: { host: "sentinel.example.test", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("https://sentinel.example.test/api/devices/usage"),
  enrollmentSecret: "device-secret"
}).ok, false);
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "sentinel.example.test", "x-sentinel-device-token": "device-secret" },
  url: new URL("https://sentinel.example.test/api/devices/usage"),
  enrollmentSecret: "device-secret"
}), { ok: true, kind: "device-token" });
