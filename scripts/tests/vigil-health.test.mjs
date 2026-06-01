import assert from "node:assert/strict";
import {
  fetchVigilStateHealth,
  isVigilStateResponse,
  vigilAppInfo,
  vigilStateHeaders,
  VIGIL_STATE_HEADER,
  VIGIL_STATE_HEADER_VALUE
} from "../../src/vigilHealth.js";

const payload = {
  app: vigilAppInfo({ port: 8787, startedAt: "2026-06-01T12:00:00.000Z" }),
  state: { settings: {} },
  monitor: { ok: true }
};

assert.equal(isVigilStateResponse(payload, { expectedPort: 8787 }), true);
assert.equal(isVigilStateResponse({ ...payload, app: { ...payload.app, id: "other-app" } }, { expectedPort: 8787 }), false);
assert.equal(isVigilStateResponse({ ...payload, app: { ...payload.app, port: 9999 } }, { expectedPort: 8787 }), false);
assert.deepEqual(vigilStateHeaders(), { [VIGIL_STATE_HEADER]: VIGIL_STATE_HEADER_VALUE });

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => jsonResponse(payload, vigilStateHeaders());
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, true);

  globalThis.fetch = async () => jsonResponse(payload, {});
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);

  globalThis.fetch = async () => jsonResponse({ ok: true }, vigilStateHeaders());
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);
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
