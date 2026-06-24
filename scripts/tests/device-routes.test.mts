import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Session } from "../../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-device-routes-"));
process.env.VIGIL_DATA_DIR = dataDir;

const { defaultState } = await import("../../src/defaults.js");
const { assertProtectedEditAllowed } = await import("../../src/protection.js");
const { handleDeviceApiRoute } = await import("../../src/server/deviceRoutes.js");

try {
  const state = defaultState();
  const now = new Date();
  const strictSession: Session = {
    id: "strict-computer",
    title: "Strict focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["computer"]
  };
  state.activeSessions.computer = strictSession;
  state.activeSession = strictSession;
  state.deviceControls.ios.enabled = false;
  state.deviceControls.ios.mode = "allowlist";
  state.deviceControls.ios.blockApps = false;

  assert.throws(() => assertProtectedEditAllowed(state, { kind: "settings" }, now), /Protected edits/);

  let queuedReason = "";
  const response = mockResponse();
  const handled = await handleDeviceApiRoute(
    mockRequest("POST", "/api/devices/ios/usb-profile-apply", {}),
    response,
    new URL("http://127.0.0.1:8787/api/devices/ios/usb-profile-apply"),
    {
      state,
      usage: {},
      recordIosMdmPolicyQueue: (reason: string) => {
        queuedReason = reason;
        return { queued: true };
      }
    }
  );

  const body = JSON.parse(response.bodyText) as Record<string, unknown>;
  const ios = body.ios as Record<string, unknown>;
  assert.equal(handled, true);
  assert.equal(response.statusCodeValue, 200);
  assert.equal(body.ok, true);
  assert.equal(state.deviceControls.ios.enabled, true);
  assert.equal(state.deviceControls.ios.mode, "allowlist");
  assert.equal(state.deviceControls.ios.blockApps, false);
  assert.equal(Boolean(state.deviceControls.ios.removalPassword), true);
  assert.equal(ios.removalPasswordSet, true);
  assert.equal(queuedReason, "ios-usb-profile-apply");
  assert.equal(state.events[0]?.type, "ios_usb_profile_apply_prepared");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function mockRequest(method: string, url: string, body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, { method, url, headers: { "content-type": "application/json" } }) as IncomingMessage;
}

interface MockResponse {
  statusCodeValue?: number;
  bodyText: string;
  headersValue: Record<string, unknown>;
  writeHead(statusCode: number, headers?: Record<string, unknown>): MockResponse;
  end(chunk?: unknown): MockResponse;
}

function mockResponse(): ServerResponse & MockResponse {
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
