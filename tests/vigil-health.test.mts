import assert from "node:assert/strict";
import {
  fetchVigilStateHealth,
  isVigilHealthResponse,
  isVigilStateResponse,
  vigilAppInfo,
  vigilStateHeaders,
  VIGIL_STATE_HEADER,
  VIGIL_STATE_HEADER_VALUE
} from "../src/vigilHealth.js";

const payload = {
  app: vigilAppInfo({ port: 8787, startedAt: "2026-06-01T12:00:00.000Z" }),
  state: { settings: {} },
  monitor: { ok: true }
};
const healthPayload = {
  app: vigilAppInfo({ port: 8787, startedAt: "2026-06-01T12:00:00.000Z" }),
  liveness: { ok: true, status: "alive" },
  aggregate: { ok: true, status: "healthy" },
  monitor: { status: "healthy" },
  readiness: { ok: true, status: "ready", blockers: [] }
};

assert.equal(isVigilStateResponse(payload, { expectedPort: 8787 }), true);
assert.equal(isVigilStateResponse({ ...payload, app: { ...payload.app, id: "other-app" } }, { expectedPort: 8787 }), false);
assert.equal(isVigilStateResponse({ ...payload, app: { ...payload.app, port: 9999 } }, { expectedPort: 8787 }), false);
assert.equal(isVigilHealthResponse(healthPayload, { expectedPort: 8787 }), true);
assert.equal(isVigilHealthResponse({
  ...healthPayload,
  aggregate: { ok: false, status: "degraded" },
  monitor: { status: "degraded" },
  readiness: { ok: false, status: "not-ready", blockers: ["monitor tick is stale"] }
}, { expectedPort: 8787 }), true, "a well-formed degraded response still proves Vigil liveness");
assert.equal(isVigilHealthResponse({ ...healthPayload, app: { ...healthPayload.app, port: 9999 } }, { expectedPort: 8787 }), false);
assert.equal(isVigilHealthResponse({ ...healthPayload, liveness: { ok: false, status: "alive" } }, { expectedPort: 8787 }), false);
assert.equal(isVigilHealthResponse({ ...healthPayload, readiness: { ok: false, status: "ready", blockers: [] } }, { expectedPort: 8787 }), false);
assert.equal(isVigilHealthResponse({ app: healthPayload.app, liveness: healthPayload.liveness }, { expectedPort: 8787 }), false);
assert.deepEqual(vigilStateHeaders(), { [VIGIL_STATE_HEADER]: VIGIL_STATE_HEADER_VALUE });

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => jsonResponse(payload, vigilStateHeaders());
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, true);

  globalThis.fetch = async () => jsonResponse(payload, {});
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);

  globalThis.fetch = async () => jsonResponse({ ok: true }, vigilStateHeaders());
  assert.equal((await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 })).ok, false);

  globalThis.fetch = async () => jsonResponse(healthPayload, vigilStateHeaders());
  const health = await fetchVigilStateHealth("http://127.0.0.1:8787/api/health?source=test", { expectedPort: 8787 });
  assert.equal(health.ok, true, "the health endpoint must not require the full state payload");

  globalThis.fetch = async () => jsonResponse({ ...healthPayload, readiness: null }, vigilStateHeaders());
  const malformedHealth = await fetchVigilStateHealth("http://127.0.0.1:8787/api/health", { expectedPort: 8787 });
  assert.equal(malformedHealth.ok, false);
  assert.equal(malformedHealth.reason, "health-shape");

  globalThis.fetch = async () => jsonResponse(healthPayload, vigilStateHeaders());
  const healthAtStateEndpoint = await fetchVigilStateHealth("http://127.0.0.1:8787/api/state", { expectedPort: 8787 });
  assert.equal(healthAtStateEndpoint.ok, false, "the state endpoint must retain its full-state validation");
  assert.equal(healthAtStateEndpoint.reason, "state-shape");
} finally {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
