import assert from "node:assert/strict";
import { accountStatusFromGroups, parseGroups } from "../src/account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, deviceUsageSyncAuthorization, EXTENSION_ID_HEADER, EXTENSION_TOKEN_HEADER, extensionCorsHeaders, extensionRequestGuard, extensionTrustSummary, isLoopbackHostHeader, isLoopbackRemoteAddress, isTrustedExtensionRequest, publicHostGuard } from "../src/apiSecurity.js";
import { parseBoolean } from "../src/booleans.js";
import { BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { iosMdmReadiness, normalizeIosMdmSettings } from "../src/iosMdm.js";
import { normalizeLimitRule } from "../src/limits.js";

const LOCAL_TRANSPORT = { trustedLoopback: true } as const;

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
  publicBaseUrl: "https://vigil.example.test",
  topic: "com.apple.mgmt.vigil",
  identityCertificateUuid: "11111111-1111-4111-8111-111111111111",
  identityCertificatePayloadBase64: pkcs12ShapeFixture()
});
assert.equal(mdmQueueOnly.status, "queue-only");
assert.equal(mdmQueueOnly.capabilityLevel, "command-queue");
assert.equal(mdmQueueOnly.pushBlockers.length, 1);
const mdmWireless = iosMdmReadiness({
  ...mdmQueueOnly,
  enabled: true,
  publicBaseUrl: "https://vigil.example.test",
  topic: "com.apple.mgmt.vigil",
  identityCertificateUuid: "11111111-1111-4111-8111-111111111111",
  identityCertificatePayloadBase64: pkcs12ShapeFixture(),
  pushCertificatePayloadBase64: pkcs12ShapeFixture()
});
assert.equal(mdmWireless.status, "ready");
assert.equal(mdmWireless.capabilityLevel, "wireless-push");
const mdmFakeCertificate = iosMdmReadiness({
  enabled: true,
  publicBaseUrl: "https://vigil.example.test",
  topic: "com.apple.mgmt.vigil",
  identityCertificateUuid: "11111111-1111-4111-8111-111111111111",
  identityCertificatePayloadBase64: Buffer.from("fake-pkcs12").toString("base64")
});
assert.equal(mdmFakeCertificate.status, "setup-needed");
assert.equal(mdmFakeCertificate.setupBlockers.some((blocker) => blocker.includes("DER PKCS#12")), true);
assert.equal(apiRequestGuard({ method: "GET", path: "/api/state", headers: {} }).ok, true);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/check", headers: {} }).ok, false);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/rules/sync", headers: { "content-type": "application/json" } }).ok, false);
assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/pause/continue", headers: { "content-type": "application/json" } }).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  remoteAddress: "127.0.0.1",
  headers: {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "DELETE",
  path: "/api/schedule/test",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "localhost:8787",
    origin: "http://localhost:8787",
    "sec-fetch-site": "same-origin",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
    origin: "https://example.com",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  remoteAddress: "127.0.0.1",
  headers: {
    host: "vigil.example.test",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
for (const forwardingHeader of ["forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "via"]) {
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "content-type": "application/json",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE,
      [forwardingHeader]: forwardingHeader === "forwarded" ? "for=203.0.113.20" : "203.0.113.20"
    }
  }).ok, false, `${forwardingHeader} must prevent direct-loopback trust`);
}
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "cross-site",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "text/plain",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
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
  ...LOCAL_TRANSPORT,
  headers: {
    host: "127.0.0.1:8787",
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
  VIGIL_EXTENSION_TOKEN: process.env.VIGIL_EXTENSION_TOKEN
};
try {
  for (const key of Object.keys(previousExtensionEnv)) delete process.env[key];
  assert.equal(extensionRequestGuard({
    method: "POST",
    ...LOCAL_TRANSPORT,
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({ origin: "chrome-extension://abc" }), false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    ...LOCAL_TRANSPORT,
    headers: {
      origin: `chrome-extension://${BUILT_IN_CHROME_EXTENSION_ID}`,
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "GET",
    ...LOCAL_TRANSPORT,
    headers: {
      [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({
    origin: "chrome-extension://attacker-extension",
    [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
  }, LOCAL_TRANSPORT), false);
  assert.deepEqual(extensionTrustSummary({
    origin: "chrome-extension://attacker-extension",
    [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
  }, LOCAL_TRANSPORT), {
    trusted: false,
    trustedBy: "none",
    requestOrigin: "chrome-extension://attacker-extension",
    normalizedOrigin: "chrome-extension://attacker-extension",
    extensionId: "attacker-extension",
    tokenConfigured: false,
    tokenSupplied: false,
    tokenHeader: EXTENSION_TOKEN_HEADER,
    configuredOriginCount: 3,
    suggestedOriginEnv: "VIGIL_EXTENSION_ORIGIN=chrome-extension://attacker-extension",
    suggestedIdEnv: "VIGIL_EXTENSION_ID=attacker-extension",
    suggestedTokenEnv: "VIGIL_EXTENSION_TOKEN=<shared-token>"
  });
  assert.equal(extensionRequestGuard({
    method: "GET",
    remoteAddress: "203.0.113.10",
    headers: {
      host: "127.0.0.1:8787",
      [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
    }
  }).ok, false);

  process.env.VIGIL_EXTENSION_ORIGINS = "chrome-extension://abc";
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/extension/check",
    ...LOCAL_TRANSPORT,
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "vigil.example.test",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json",
      forwarded: "for=203.0.113.20"
    }
  }).ok, false);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/extension/pause/skip",
    ...LOCAL_TRANSPORT,
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    ...LOCAL_TRANSPORT,
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.deepEqual({
    trusted: extensionTrustSummary({ host: "127.0.0.1:8787", origin: "chrome-extension://abc" }, LOCAL_TRANSPORT).trusted,
    trustedBy: extensionTrustSummary({ host: "127.0.0.1:8787", origin: "chrome-extension://abc" }, LOCAL_TRANSPORT).trustedBy,
    suggestedIdEnv: extensionTrustSummary({ host: "127.0.0.1:8787", origin: "chrome-extension://abc" }, LOCAL_TRANSPORT).suggestedIdEnv
  }, {
    trusted: true,
    trustedBy: "origin",
    suggestedIdEnv: "VIGIL_EXTENSION_ID=abc"
  });
  assert.equal(extensionRequestGuard({
    method: "POST",
    ...LOCAL_TRANSPORT,
    headers: {
      origin: "chrome-extension://xyz",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    ...LOCAL_TRANSPORT,
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "text/plain"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    remoteAddress: "203.0.113.20",
    headers: {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({ host: "127.0.0.1:8787", origin: "chrome-extension://abc" }, LOCAL_TRANSPORT), true);
  assert.equal(extensionCorsHeaders({ host: "127.0.0.1:8787", origin: "chrome-extension://abc" }, LOCAL_TRANSPORT)["Access-Control-Allow-Origin"], "chrome-extension://abc");

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
assert.equal(isLoopbackHostHeader(undefined), false);
assert.equal(isLoopbackHostHeader("127.0.0.1:8787"), true);
assert.equal(isLoopbackHostHeader("[::1]:8787"), true);
assert.equal(isLoopbackHostHeader("attacker@127.0.0.1:8787"), false);
assert.equal(isLoopbackHostHeader("127.0.0.1.example.test"), false);
assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
assert.equal(isLoopbackRemoteAddress("::1"), true);
assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
assert.equal(isLoopbackRemoteAddress("203.0.113.20"), false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  remoteAddress: "::1",
  headers: {
    host: "[::1]:8787",
    origin: "http://[::1]:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, true);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  remoteAddress: "203.0.113.20",
  headers: {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(apiRequestGuard({
  method: "POST",
  path: "/api/settings",
  headers: {
    host: "vigil.example.test",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }
}).ok, false);
assert.equal(publicHostGuard({ path: "/api/state", headers: {} }).ok, false);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "127.0.0.1:8787" }, ...LOCAL_TRANSPORT }).ok, true);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "localhost:8787" }, ...LOCAL_TRANSPORT }).ok, true);
assert.equal(publicHostGuard({
  path: "/api/state",
  headers: { host: "127.0.0.1:8787" },
  remoteAddress: "203.0.113.20"
}).ok, false);
assert.equal(publicHostGuard({
  path: "/api/state",
  headers: { host: "vigil.example.test" },
  remoteAddress: "127.0.0.1"
}).ok, false);
assert.equal(publicHostGuard({
  path: "/api/state",
  headers: { host: "127.0.0.1:8787", "x-forwarded-for": "203.0.113.20" },
  remoteAddress: "127.0.0.1"
}).ok, false);
assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "vigil.example.test" } }).ok, false);
assert.equal(publicHostGuard({ path: "/mdm/checkin", headers: { host: "vigil.example.test" } }).ok, true);
assert.equal(publicHostGuard({ path: "/api/devices/usage", headers: { host: "vigil.example.test" } }).ok, true);
const previousHostedEnv = {
  auth: process.env.VIGIL_AUTH_ENABLED,
  hosts: process.env.VIGIL_PUBLIC_HOSTS
};
try {
  process.env.VIGIL_AUTH_ENABLED = "1";
  process.env.VIGIL_PUBLIC_HOSTS = "vigil.example.test";
  assert.equal(publicHostGuard({ path: "/", headers: { host: "vigil.example.test" } }).ok, true);
  assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "unknown.example.test" } }).ok, false);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/account/login",
    headers: {
      host: "vigil.example.test",
      origin: "https://vigil.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/account/login",
    headers: {
      host: "vigil.example.test",
      origin: "https://attacker.example.test",
      "content-type": "application/json"
    }
  }).ok, false);
} finally {
  if (previousHostedEnv.auth === undefined) delete process.env.VIGIL_AUTH_ENABLED;
  else process.env.VIGIL_AUTH_ENABLED = previousHostedEnv.auth;
  if (previousHostedEnv.hosts === undefined) delete process.env.VIGIL_PUBLIC_HOSTS;
  else process.env.VIGIL_PUBLIC_HOSTS = previousHostedEnv.hosts;
}
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "127.0.0.1:8787", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("http://127.0.0.1:8787/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" },
  ...LOCAL_TRANSPORT
}), { ok: true, kind: "local-intent" });
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: { host: "127.0.0.1:8787", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("http://127.0.0.1:8787/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" },
  remoteAddress: "127.0.0.1"
}), { ok: true, kind: "local-intent" });
assert.equal(deviceUsageSyncAuthorization({
  headers: { host: "vigil.example.test", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("https://vigil.example.test/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" },
  remoteAddress: "127.0.0.1"
}).ok, false);
assert.equal(deviceUsageSyncAuthorization({
  headers: { [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("http://127.0.0.1:8787/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" }
}).ok, false);
assert.equal(deviceUsageSyncAuthorization({
  headers: { host: "vigil.example.test", [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE },
  url: new URL("https://vigil.example.test/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" }
}).ok, false);
assert.deepEqual(deviceUsageSyncAuthorization({
  headers: {
    host: "vigil.example.test",
    "x-vigil-device-id": "phone-udid",
    "x-vigil-device-token": "device-secret"
  },
  url: new URL("https://vigil.example.test/api/devices/usage"),
  deviceTokens: { "phone-udid": "device-secret" }
}), { ok: true, kind: "device-token", deviceId: "phone-udid" });

const previousHostedExtensionEnv = {
  auth: process.env.VIGIL_AUTH_ENABLED,
  origin: process.env.VIGIL_EXTENSION_ORIGIN,
  token: process.env.VIGIL_EXTENSION_TOKEN
};
try {
  process.env.VIGIL_AUTH_ENABLED = "1";
  process.env.VIGIL_EXTENSION_ORIGIN = "chrome-extension://trusted-extension";
  process.env.VIGIL_EXTENSION_TOKEN = "hosted-extension-secret";
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      host: "vigil.example.test",
      origin: "chrome-extension://trusted-extension",
      "content-type": "application/json"
    }
  }).ok, false, "a public client must not authenticate by forging Origin");
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      host: "vigil.example.test",
      origin: "chrome-extension://trusted-extension",
      "content-type": "application/json",
      [EXTENSION_TOKEN_HEADER]: "hosted-extension-secret"
    }
  }).ok, true);
} finally {
  restoreEnv("VIGIL_AUTH_ENABLED", previousHostedExtensionEnv.auth);
  restoreEnv("VIGIL_EXTENSION_ORIGIN", previousHostedExtensionEnv.origin);
  restoreEnv("VIGIL_EXTENSION_TOKEN", previousHostedExtensionEnv.token);
}

function pkcs12ShapeFixture(): string {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x80]), Buffer.alloc(128, 1)]).toString("base64");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
