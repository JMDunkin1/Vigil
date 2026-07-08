import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Session } from "../../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "sentinel-device-routes-"));
process.env.SENTINEL_DATA_DIR = dataDir;

const { defaultState, SOFT_BLOCK_PROFILE_ID } = await import("../../src/defaults.js");
const { assertProtectedEditAllowed } = await import("../../src/protection.js");
const { profileById } = await import("../../src/policy.js");
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
  state.deviceControls.ios.blockApps = true;

  assert.throws(() => assertProtectedEditAllowed(state, { kind: "settings" }, now), /Protected edits/);

  let blockedAppRemovalQueued = "";
  await assert.rejects(
    () => handleDeviceApiRoute(
      mockRequest("POST", "/api/devices/ios/app-removal", { enabled: false }),
      mockResponse(),
      new URL("http://127.0.0.1:8787/api/devices/ios/app-removal"),
      {
        state,
        usage: {},
        recordIosMdmPolicyQueue: (reason: string) => {
          blockedAppRemovalQueued = reason;
          return { queued: true };
        }
      }
    ),
    /Protected edits/
  );
  assert.equal(state.deviceControls.ios.blockApps, true);
  assert.equal(blockedAppRemovalQueued, "");
  assert.equal(state.events.some((event) => event.type === "ios_app_removal_toggled"), false);

  state.deviceControls.ios.blockApps = false;
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

  const doctorResponse = mockResponse();
  const doctorHandled = await handleDeviceApiRoute(
    mockRequest("GET", "/api/devices/ios/mdm/doctor", {}),
    doctorResponse,
    new URL("http://127.0.0.1:8787/api/devices/ios/mdm/doctor"),
    {
      state,
      usage: {},
      recordIosMdmPolicyQueue: () => ({ queued: false })
    }
  );
  const doctorBody = JSON.parse(doctorResponse.bodyText) as Record<string, unknown>;
  const mdm = doctorBody.mdm as Record<string, unknown>;
  const normalDeliveryPath = mdm.normalDeliveryPath as Record<string, unknown>;
  assert.equal(doctorHandled, true);
  assert.equal(doctorResponse.statusCodeValue, 200);
  assert.equal(doctorBody.ok, true);
  assert.equal(mdm.status, "off");
  assert.equal(normalDeliveryPath.provider, "manageengine");
  assert.equal((mdm.staticProfile as Record<string, unknown>).status, "supervised-profile-ready");

  const enrollmentResponse = mockResponse();
  const enrollmentHandled = await handleDeviceApiRoute(
    mockRequest("GET", "/api/devices/ios/mdm/enrollment.mobileconfig", {}),
    enrollmentResponse,
    new URL("http://127.0.0.1:8787/api/devices/ios/mdm/enrollment.mobileconfig"),
    {
      state,
      usage: {},
      recordIosMdmPolicyQueue: () => ({ queued: false })
    }
  );
  const enrollmentBody = JSON.parse(enrollmentResponse.bodyText) as Record<string, unknown>;
  assert.equal(enrollmentHandled, true);
  assert.equal(enrollmentResponse.statusCodeValue, 409);
  assert.equal(enrollmentBody.ok, false);
  assert.match(String(enrollmentBody.error), /Self-hosted Sentinel MDM enrollment is not ready/);
  assert.ok((enrollmentBody.blockers as unknown[]).some((item) => /public HTTPS URL/i.test(String(item))));
  assert.equal(state.deviceControls.ios.mdm.lastEnrollmentProfileGeneratedAt, null);
  assert.equal(state.events.some((event) => event.type === "ios_mdm_enrollment_generated"), false);

  const softState = defaultState();
  softState.deviceControls.ios.enabled = true;
  softState.activeSessions.phone = {
    id: "phone-soft-youtube-route",
    title: "Phone Soft Lock",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(softState, SOFT_BLOCK_PROFILE_ID)
  };
  const routeUsage = {};
  const queuedReasons: string[] = [];
  const instagramUsageResponse = mockResponse();
  const instagramUsageHandled = await handleDeviceApiRoute(
    mockRequest("POST", "/api/devices/usage", {
      device: "phone",
      totalSeconds: 20 * 60,
      apps: { "com.burbn.instagram": 20 * 60 },
      sites: { "instagram.com": 20 * 60 }
    }, {
      host: "127.0.0.1:8787",
      "x-sentinel-intent": "sentinel-app"
    }),
    instagramUsageResponse,
    new URL("http://127.0.0.1:8787/api/devices/usage"),
    {
      state: softState,
      usage: routeUsage,
      recordIosMdmPolicyQueue: (reason: string) => {
        queuedReasons.push(reason);
        return { queued: true };
      }
    }
  );
  const instagramUsageBody = JSON.parse(instagramUsageResponse.bodyText) as Record<string, unknown>;
  assert.equal(instagramUsageHandled, true);
  assert.equal(instagramUsageResponse.statusCodeValue, 200);
  assert.equal(instagramUsageBody.ok, true);
  assert.equal(softState.limitBlocks.some((block) => block.ruleId === "instagram-20-20-template"), false);
  assert.equal(queuedReasons.length, 0);

  const usageResponse = mockResponse();
  const usageHandled = await handleDeviceApiRoute(
    mockRequest("POST", "/api/devices/usage", {
      device: "phone",
      totalSeconds: 20 * 60,
      apps: { "com.google.ios.youtube": 20 * 60 },
      sites: { "youtube.com": 20 * 60 }
    }, {
      host: "127.0.0.1:8787",
      "x-sentinel-intent": "sentinel-app"
    }),
    usageResponse,
    new URL("http://127.0.0.1:8787/api/devices/usage"),
    {
      state: softState,
      usage: routeUsage,
      recordIosMdmPolicyQueue: (reason: string) => {
        queuedReasons.push(reason);
        return { queued: true };
      }
    }
  );
  const usageBody = JSON.parse(usageResponse.bodyText) as Record<string, unknown>;
  assert.equal(usageHandled, true);
  assert.equal(usageResponse.statusCodeValue, 200);
  assert.equal(usageBody.ok, true);
  assert.equal(softState.limitBlocks.some((block) => block.ruleId === "soft-lock-youtube-20-20-template"), true);
  assert.deepEqual(queuedReasons, ["device-usage-limit-block"]);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function mockRequest(method: string, url: string, body: object, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, { method, url, headers: { "content-type": "application/json", ...headers } }) as IncomingMessage;
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
