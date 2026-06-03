import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, EXTENSION_TOKEN_HEADER } from "../../src/apiSecurity.js";
import { defaultState } from "../../src/defaults.js";
import { handleExtensionApiRoute } from "../../src/server/extensionApi.js";
import type { UsageState } from "../../src/types.js";

function request(method: string, url: string, headers: Record<string, string>, body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, { method, url, headers }) as IncomingMessage;
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

const previousToken = process.env.SENTINEL_EXTENSION_TOKEN;
try {
  process.env.SENTINEL_EXTENSION_TOKEN = "test-extension-secret";
  const pauseState = defaultState();
  pauseState.settings.activeProfileId = "normal";
  pauseState.settings.baselineProfileId = "normal";
  const pauseUsage: UsageState = {};
  const pauseHeaders = {
    origin: "chrome-extension://pause-extension",
    "content-type": "application/json",
    [EXTENSION_TOKEN_HEADER]: "test-extension-secret"
  };
  const pauseResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/check", pauseHeaders, {
      url: "https://youtube.com/shorts/demo",
      event: "navigation",
      extensionVersion: "0.3.0"
    }),
    pauseResponse,
    new URL("http://127.0.0.1:8787/api/extension/check"),
    { state: pauseState, usage: pauseUsage }
  );

  assert.equal(pauseResponse.statusCodeValue, 200);
  const pauseBody: unknown = JSON.parse(pauseResponse.bodyText);
  assert.equal(isRecord(pauseBody) && pauseBody.paused, true);
  assert.equal(isRecord(pauseBody) && isRecord(pauseBody.overlay), true);
  assert.equal(pauseState.intentionalUse.pauses.length, 1);
  const pauseId = pauseState.intentionalUse.pauses[0].id;
  pauseState.intentionalUse.pauses[0].eligibleAt = new Date(Date.now() - 1000).toISOString();

  const continueResponse = response();
  await handleExtensionApiRoute(
    request("POST", "/api/extension/pause/continue", pauseHeaders, {
      requestId: pauseId,
      intention: "Watch one specific thing",
      mood: "Focused"
    }),
    continueResponse,
    new URL("http://127.0.0.1:8787/api/extension/pause/continue"),
    { state: pauseState, usage: pauseUsage }
  );

  assert.equal(continueResponse.statusCodeValue, 200);
  const continueBody: unknown = JSON.parse(continueResponse.bodyText);
  assert.equal(isRecord(continueBody) && continueBody.ok, true);
  assert.equal(pauseState.intentionalUse.grants.length, 1);
  assert.equal(pauseState.extension.lastEvent, "pause-continue");
} finally {
  if (previousToken === undefined) delete process.env.SENTINEL_EXTENSION_TOKEN;
  else process.env.SENTINEL_EXTENSION_TOKEN = previousToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
