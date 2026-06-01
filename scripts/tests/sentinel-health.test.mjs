import assert from "node:assert/strict";
import {
  fetchSentinelStateHealth,
  isSentinelStateResponse,
  sentinelAppInfo,
  sentinelStateHeaders,
  SENTINEL_STATE_HEADER,
  SENTINEL_STATE_HEADER_VALUE
} from "../../src/sentinelHealth.js";

const payload = {
  app: sentinelAppInfo({ port: 8787, startedAt: "2026-06-01T12:00:00.000Z" }),
  state: { settings: {} },
  monitor: { ok: true }
};

assert.equal(isSentinelStateResponse(payload, { expectedPort: 8787 }), true);
assert.equal(isSentinelStateResponse({ ...payload, app: { ...payload.app, id: "other-app" } }, { expectedPort: 8787 }), false);
assert.equal(isSentinelStateResponse({ ...payload, app: { ...payload.app, port: 9999 } }, { expectedPort: 8787 }), false);
assert.deepEqual(sentinelStateHeaders(), { [SENTINEL_STATE_HEADER]: SENTINEL_STATE_HEADER_VALUE });

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => jsonResponse(payload, sentinelStateHeaders());
  assert.equal((await fetchSentinelStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, true);

  globalThis.fetch = async () => jsonResponse(payload, {});
  assert.equal((await fetchSentinelStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);

  globalThis.fetch = async () => jsonResponse({ ok: true }, sentinelStateHeaders());
  assert.equal((await fetchSentinelStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);
} finally {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body, headers) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
