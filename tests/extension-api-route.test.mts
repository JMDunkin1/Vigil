import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, EXTENSION_ID_HEADER, EXTENSION_TOKEN_HEADER } from "../src/apiSecurity.js";
import { BUILT_IN_CHROME_EXTENSION_ID, defaultState, REQUIRED_EXTENSION_VERSION } from "../src/defaults.js";
import { extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { handleExtensionApiRoute } from "../src/server/extensionApi.js";
import type { UsageState } from "../src/types.js";

function request(method: string, url: string, headers: Record<string, string>, body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}

interface MockResponse {
  statusCodeValue?: number;
  bodyText: string;
  headersValue: Record<string, unknown>;
  writeHead(statusCode: number, headers?: Record<string, unknown>): MockResponse;
  end(chunk?: unknown): MockResponse;
}

function response(): ServerResponse & MockResponse {
  const target: MockResponse = {
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
  return target as ServerResponse & MockResponse;
}

const state = defaultState();
const usage: UsageState = {};
const localResponse = response();
const handled = await handleExtensionApiRoute(
  request("POST", "/api/extension/check", {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
  }, {
    url: "https://example.com",
    event: "heartbeat"
  }),
  localResponse,
  new URL("http://127.0.0.1:8787/api/extension/check"),
  { state, usage }
);

assert.equal(handled, true);
assert.equal(localResponse.statusCodeValue, 200);
const localBody: unknown = JSON.parse(localResponse.bodyText);
assert.equal(isRecord(localBody) && localBody.ok, true);
assert.equal(state.extension.lastSeenAt, null);

const pairingResponse = response();
await handleExtensionApiRoute(
  request("GET", "/api/extension/pairing", {
    origin: "chrome-extension://new-extension"
  }, {}),
  pairingResponse,
  new URL("http://127.0.0.1:8787/api/extension/pairing"),
  { state, usage }
);

assert.equal(pairingResponse.statusCodeValue, 200);
const pairingBody: unknown = JSON.parse(pairingResponse.bodyText);
assert.equal(isRecord(pairingBody) && isRecord(pairingBody.trust) && pairingBody.trust.trusted, false);
assert.equal(isRecord(pairingBody) && isRecord(pairingBody.setup) && pairingBody.setup.idEnv, "VIGIL_EXTENSION_ID=new-extension");
assert.equal(isRecord(pairingBody) && isRecord(pairingBody.status) && "lastHost" in pairingBody.status, false);
assert.equal(state.extension.lastSeenAt, null);

const untrustedResponse = response();
await handleExtensionApiRoute(
  request("POST", "/api/extension/check", {
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json"
  }, {
    url: "https://example.com",
    event: "heartbeat"
  }),
  untrustedResponse,
  new URL("http://127.0.0.1:8787/api/extension/check"),
  { state: defaultState(), usage: {} }
);

assert.equal(untrustedResponse.statusCodeValue, 403);

const spoofedSyncResponse = response();
const spoofedSyncState = defaultState();
await handleExtensionApiRoute(
  request("POST", "/api/extension/rules/sync", {
    host: "127.0.0.1:8787",
    origin: "chrome-extension://attacker-extension",
    "content-type": "application/json",
    [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
  }, {
    ok: true,
    count: 0,
    signature: ""
  }),
  spoofedSyncResponse,
  new URL("http://127.0.0.1:8787/api/extension/rules/sync"),
  { state: spoofedSyncState, usage: {} }
);

assert.equal(spoofedSyncResponse.statusCodeValue, 403);
assert.equal(spoofedSyncState.extension.lastSeenAt, null);
assert.equal(spoofedSyncState.extension.dynamicRules.status, "missing");

const previousToken = process.env.VIGIL_EXTENSION_TOKEN;
try {
  process.env.VIGIL_EXTENSION_TOKEN = "test-extension-secret";
  const persistenceHeaders = {
    origin: "chrome-extension://persistence-extension",
    "content-type": "application/json",
    [EXTENSION_TOKEN_HEADER]: "test-extension-secret"
  };

  const pulseState = defaultState();
  pulseState.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const pulseUsage: UsageState = {};
  let pulsePersistenceRequests = 0;
  for (let pulse = 0; pulse < 2; pulse += 1) {
    const pulseResponse = response();
    await handleExtensionApiRoute(
      request("POST", "/api/extension/check", persistenceHeaders, {
        url: "https://example.com/",
        event: "heartbeat",
        seconds: 5,
        extensionVersion: REQUIRED_EXTENSION_VERSION
      }),
      pulseResponse,
      new URL("http://127.0.0.1:8787/api/extension/check"),
      {
        state: pulseState,
        usage: pulseUsage,
        requestPersistence: () => { pulsePersistenceRequests += 1; }
      }
    );
    assert.equal(pulseResponse.statusCodeValue, 200);
  }
  assert.equal(pulsePersistenceRequests, 0, "ordinary usage and last-seen pulses should stay memory-only");
  assert.notDeepEqual(pulseUsage, {}, "memory-only pulses must still update live usage");
  assert.notEqual(pulseState.extension.lastSeenAt, null);

  const blockState = defaultState();
  blockState.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const blockNow = new Date();
  blockState.activeSession = {
    id: "extension-block-session",
    title: "Extension block session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: blockNow.toISOString(),
    endsAt: new Date(blockNow.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  let blockPersistenceRequests = 0;
  const blockResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/check", persistenceHeaders, {
      url: "https://youtube.com/",
      event: "navigation",
      extensionVersion: REQUIRED_EXTENSION_VERSION
    }),
    blockResponse,
    new URL("http://127.0.0.1:8787/api/extension/check"),
    {
      state: blockState,
      usage: {},
      requestPersistence: () => { blockPersistenceRequests += 1; }
    }
  );
  assert.equal(blockResponse.statusCodeValue, 200);
  assert.equal(blockPersistenceRequests, 1, "new block events must request durability");

  const limitState = defaultState();
  limitState.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  limitState.limitRules = [{
    id: "extension-pulse-limit",
    name: "Extension pulse limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: [],
    sites: ["example.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 10
  }];
  limitState.limitBlocks = [];
  const limitUsage: UsageState = {};
  let limitPersistenceRequests = 0;
  for (let pulse = 0; pulse < 12; pulse += 1) {
    const limitResponse = response();
    await handleExtensionApiRoute(
      request("POST", "/api/extension/check", persistenceHeaders, {
        url: "https://example.com/",
        event: "heartbeat",
        seconds: 5,
        extensionVersion: REQUIRED_EXTENSION_VERSION
      }),
      limitResponse,
      new URL("http://127.0.0.1:8787/api/extension/check"),
      {
        state: limitState,
        usage: limitUsage,
        requestPersistence: () => { limitPersistenceRequests += 1; }
      }
    );
    assert.equal(limitResponse.statusCodeValue, 200);
    if (pulse < 11) assert.equal(limitPersistenceRequests, 0);
  }
  assert.equal(limitState.limitBlocks.length, 1);
  assert.equal(limitPersistenceRequests, 1, "the pulse that creates a limit block must request durability");

  const rulesState = defaultState();
  rulesState.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const rulesUsage: UsageState = {};
  let rulesPersistenceRequests = 0;
  const rulesContext = {
    state: rulesState,
    usage: rulesUsage,
    requestPersistence: () => { rulesPersistenceRequests += 1; }
  };
  const rulesUrl = new URL(`http://127.0.0.1:8787/api/extension/rules?version=${REQUIRED_EXTENSION_VERSION}`);
  const firstRulesResponse = response();
  await handleExtensionApiRoute(
    request("GET", rulesUrl.pathname, persistenceHeaders, {}),
    firstRulesResponse,
    rulesUrl,
    rulesContext
  );
  assert.equal(firstRulesResponse.statusCodeValue, 200);
  assert.equal(rulesPersistenceRequests, 1, "new expected rule signatures must request durability");
  const firstRulesBody: unknown = JSON.parse(firstRulesResponse.bodyText);
  assert.equal(isRecord(firstRulesBody), true);

  const secondRulesResponse = response();
  await handleExtensionApiRoute(
    request("GET", rulesUrl.pathname, persistenceHeaders, {}),
    secondRulesResponse,
    rulesUrl,
    rulesContext
  );
  assert.equal(secondRulesResponse.statusCodeValue, 200);
  assert.equal(rulesPersistenceRequests, 1, "unchanged rules GET timestamps should stay memory-only");

  const expectedSnapshot = extensionRuleSnapshot(rulesState);
  const syncBody = {
    ok: true,
    count: extensionDynamicRuleCount(expectedSnapshot),
    signature: extensionDynamicRuleSignature(expectedSnapshot),
    extensionVersion: REQUIRED_EXTENSION_VERSION
  };
  for (let sync = 0; sync < 2; sync += 1) {
    const syncResponse = response();
    await handleExtensionApiRoute(
      request("POST", "/api/extension/rules/sync", persistenceHeaders, syncBody),
      syncResponse,
      new URL("http://127.0.0.1:8787/api/extension/rules/sync"),
      rulesContext
    );
    assert.equal(syncResponse.statusCodeValue, 200);
    assert.equal(rulesPersistenceRequests, 2, "identical sync results should not rewrite timestamps durably");
  }

  const failedSyncResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/rules/sync", persistenceHeaders, {
      ...syncBody,
      ok: false,
      error: "Dynamic rule update failed"
    }),
    failedSyncResponse,
    new URL("http://127.0.0.1:8787/api/extension/rules/sync"),
    rulesContext
  );
  assert.equal(failedSyncResponse.statusCodeValue, 200);
  assert.equal(rulesPersistenceRequests, 3, "material rule status and error changes must request durability");

  const pauseState = defaultState();
  pauseState.settings.activeProfileId = "normal";
  pauseState.settings.baselineProfileId = "normal";
  const pauseUsage: UsageState = {};
  let pausePersistenceRequests = 0;
  const pauseHeaders = {
    origin: "chrome-extension://pause-extension",
    "content-type": "application/json",
    [EXTENSION_TOKEN_HEADER]: "test-extension-secret"
  };
  const pauseResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/check", pauseHeaders, {
      url: "https://reddit.com/r/popular",
      event: "navigation",
      extensionVersion: REQUIRED_EXTENSION_VERSION
    }),
    pauseResponse,
    new URL("http://127.0.0.1:8787/api/extension/check"),
    {
      state: pauseState,
      usage: pauseUsage,
      requestPersistence: () => { pausePersistenceRequests += 1; }
    }
  );

  assert.equal(pauseResponse.statusCodeValue, 200);
  const pauseBody: unknown = JSON.parse(pauseResponse.bodyText);
  assert.equal(isRecord(pauseBody) && pauseBody.paused, true);
  assert.equal(isRecord(pauseBody) && isRecord(pauseBody.overlay), true);
  assert.equal(pauseState.intentionalUse.pauses.length, 1);
  assert.equal(pausePersistenceRequests, 1, "new intentional pauses must request durability");
  const pauseId = pauseState.intentionalUse.pauses[0].id;
  pauseState.intentionalUse.pauses[0].eligibleAt = new Date(Date.now() - 1000).toISOString();

  const spoofedContinueResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/pause/continue", {
      host: "127.0.0.1:8787",
      origin: "chrome-extension://attacker-extension",
      "content-type": "application/json",
      [EXTENSION_ID_HEADER]: BUILT_IN_CHROME_EXTENSION_ID
    }, {
      requestId: pauseId,
      intention: "Bypass the companion",
      mood: "Impersonating"
    }),
    spoofedContinueResponse,
    new URL("http://127.0.0.1:8787/api/extension/pause/continue"),
    {
      state: pauseState,
      usage: pauseUsage,
      requestPersistence: () => { pausePersistenceRequests += 1; }
    }
  );

  assert.equal(spoofedContinueResponse.statusCodeValue, 403);
  assert.equal(pauseState.intentionalUse.grants.length, 0);
  assert.equal(pauseState.intentionalUse.pauses[0].status, "pending");

  const continueResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/pause/continue", pauseHeaders, {
      requestId: pauseId,
      intention: "Watch one specific thing",
      mood: "Focused"
    }),
    continueResponse,
    new URL("http://127.0.0.1:8787/api/extension/pause/continue"),
    {
      state: pauseState,
      usage: pauseUsage,
      requestPersistence: () => { pausePersistenceRequests += 1; }
    }
  );

  assert.equal(continueResponse.statusCodeValue, 200);
  const continueBody: unknown = JSON.parse(continueResponse.bodyText);
  assert.equal(isRecord(continueBody) && continueBody.ok, true);
  assert.equal(pauseState.intentionalUse.grants.length, 1);
  assert.equal(pauseState.extension.lastEvent, "pause-continue");
  assert.equal(pausePersistenceRequests, 2, "pause decisions must remain durable");
} finally {
  if (previousToken === undefined) delete process.env.VIGIL_EXTENSION_TOKEN;
  else process.env.VIGIL_EXTENSION_TOKEN = previousToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
