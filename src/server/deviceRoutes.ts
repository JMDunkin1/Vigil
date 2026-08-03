import type { IncomingMessage, ServerResponse } from "node:http";
import { deviceUsageSyncAuthorization } from "../apiSecurity.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { buildIosMdmEnrollmentProfile, iosMdmDeviceUsageCredential, iosMdmDeviceUsageTokens, iosMdmDoctor, iosMdmEnrollmentReadiness, markIosMdmEnrollmentGenerated, normalizeIosMdmSettings, publicIosMdmSettings } from "../iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated, normalizeIosSettings } from "../iosProfiles.js";
import { activeLimitPolicy } from "../limits.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { DATA_DIR, addEvent, saveState, saveUsage } from "../store.js";
import { configuredIosPhoneProfileOptions } from "../iosUrlFilterServiceConfiguration.js";
import type { VigilState, UnknownRecord, UsageBucket, UsageState } from "../types.js";
import { normalizeUsageDay, syncDeviceUsageSnapshot, usageSummary } from "../usage.js";
import { readBody, sendDownload, sendJson } from "./http.js";
import { publicIosState } from "./statePayload.js";

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
  deviceId?: string;
}

export interface IosMdmPushResult extends UnknownRecord {
  pushed?: number | boolean;
  failed?: number | boolean;
  queued?: boolean;
}

interface DeviceApiContext {
  state: VigilState;
  usage: UsageState;
  recordIosMdmPolicyQueue: (reason: string) => IosMdmPushResult;
}

export async function handleDeviceApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { state, usage, recordIosMdmPolicyQueue }: DeviceApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = url.pathname;

  if (method === "POST" && path === "/api/devices/ios/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls.ios = normalizeIosSettings(body, state.deviceControls.ios) as VigilState["deviceControls"]["ios"];
    addEvent(state, "ios_settings_updated", {
      enabled: state.deviceControls.ios.enabled,
      mode: state.deviceControls.ios.mode,
      webMode: state.deviceControls.ios.webMode,
      blockedApps: state.deviceControls.ios.blockedAppBundleIds.length,
      allowedApps: state.deviceControls.ios.allowedAppBundleIds.length
    });
    recordIosMdmPolicyQueue("ios-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, ios: publicIosState(state.deviceControls.ios) });
    return true;
  }

  if (method === "POST" && path === "/api/devices/ios/app-removal") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls.ios.blockApps = parseToggle(body.enabled, state.deviceControls.ios.blockApps !== false);
    addEvent(state, "ios_app_removal_toggled", {
      enabled: state.deviceControls.ios.blockApps
    });
    recordIosMdmPolicyQueue("ios-app-removal-toggle");
    await saveState(state);
    sendJson(response, 200, { ok: true, ios: publicIosState(state.deviceControls.ios) });
    return true;
  }

  if (method === "POST" && path === "/api/devices/ios/usb-profile-apply") {
    const current = state.deviceControls.ios;
    state.deviceControls.ios = normalizeIosSettings({
      enabled: true,
      mode: current.mode || "denylist",
      webMode: current.webMode || "denylist",
      blockApps: current.blockApps !== false,
      blockWeb: current.blockWeb !== false,
      hardenRemoval: current.hardenRemoval !== false,
      restrictInstallAndErase: current.restrictInstallAndErase !== false,
      allowSafariHistoryClearing: current.allowSafariHistoryClearing !== false,
      blockedAppBundleIds: current.blockedAppBundleIds || [],
      allowedAppBundleIds: current.allowedAppBundleIds || [],
      deniedUrls: current.deniedUrls || [],
      allowedUrls: current.allowedUrls || [],
      focusedSocial: current.focusedSocial
    }, current) as VigilState["deviceControls"]["ios"];
    addEvent(state, "ios_usb_profile_apply_prepared", {
      enabled: state.deviceControls.ios.enabled,
      mode: state.deviceControls.ios.mode,
      webMode: state.deviceControls.ios.webMode,
      blockedApps: state.deviceControls.ios.blockedAppBundleIds.length,
      allowedApps: state.deviceControls.ios.allowedAppBundleIds.length
    });
    recordIosMdmPolicyQueue("ios-usb-profile-apply");
    await saveState(state);
    sendJson(response, 200, { ok: true, ios: publicIosState(state.deviceControls.ios) });
    return true;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls.ios.mdm = normalizeIosMdmSettings(body, state.deviceControls.ios.mdm) as VigilState["deviceControls"]["ios"]["mdm"];
    addEvent(state, "ios_mdm_settings_updated", {
      enabled: state.deviceControls.ios.mdm.enabled,
      hasPublicBaseUrl: Boolean(state.deviceControls.ios.mdm.publicBaseUrl),
      hasTopic: Boolean(state.deviceControls.ios.mdm.topic)
    });
    recordIosMdmPolicyQueue("ios-mdm-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, mdm: publicIosMdmSettings(state.deviceControls.ios.mdm) });
    return true;
  }

  if (method === "GET" && path === "/api/devices/ios/mdm/doctor") {
    sendJson(response, 200, { ok: true, mdm: iosMdmDoctor(state) });
    return true;
  }

  if (method === "GET" && path === "/api/devices/ios/mdm/enrollment.mobileconfig") {
    const readiness = iosMdmEnrollmentReadiness(state);
    if (!readiness.enrollmentReady) {
      sendJson(response, 409, {
        ok: false,
        error: "Self-hosted Vigil MDM enrollment is not ready.",
        blockers: readiness.setupBlockers,
        mdm: iosMdmDoctor(state)
      });
      return true;
    }
    const profile = buildIosMdmEnrollmentProfile(state);
    markIosMdmEnrollmentGenerated(state);
    addEvent(state, "ios_mdm_enrollment_generated", { bytes: Buffer.byteLength(profile), source: "app" });
    await saveState(state);
    sendDownload(response, 200, profile, "vigil-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return true;
  }

  if (method === "GET" && path === "/api/devices/ios/mdm/device-usage-token") {
    const identifier = String(url.searchParams.get("device") || "");
    const credential = iosMdmDeviceUsageCredential(state, identifier);
    if (!credential) {
      sendJson(response, 404, { ok: false, error: "Enrolled iPhone not found." });
      return true;
    }
    sendJson(response, 200, { ok: true, ...credential });
    return true;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/queue-policy") {
    const result = recordIosMdmPolicyQueue("app-refresh");
    await saveState(state);
    sendJson(response, 200, { ok: Boolean(result.queued), result, push: { staged: true } });
    return true;
  }

  if (method === "GET" && path === "/api/devices/ios/profile.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state, new Date(), configuredIosPhoneProfileOptions(DATA_DIR));
    markIosProfileGenerated(state);
    addEvent(state, "ios_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "vigil-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return true;
  }

  if (method === "POST" && path === "/api/devices/usage") {
    const body = await readBody(request);
    const authorization = deviceUsageSyncAuthorization({
      headers: request.headers,
      url,
      body,
      deviceTokens: iosMdmDeviceUsageTokens(state),
      remoteAddress: request.socket?.remoteAddress || null
    }) as GuardResult;
    if (!authorization.ok) {
      sendJson(response, authorization.status || 403, { error: authorization.error || "Forbidden" });
      return true;
    }

    const now = new Date();
    const result = syncDeviceUsageSnapshot(usage, body, now, {
      allowedDevices: authorization.kind === "device-token" ? ["phone"] : DEVICE_TARGETS
    });
    const newLimitBlocks = evaluateDeviceLimitBlocks(state, usage, result, now);
    if (newLimitBlocks.length) recordIosMdmPolicyQueue("device-usage-limit-block");
    addEvent(state, "device_usage_synced", {
      device: result.device,
      dayKey: result.dayKey,
      totalSeconds: result.deviceTotalSeconds,
      limitBlocks: newLimitBlocks.length
    });
    await saveUsage(usage);
    await saveState(state);
    sendJson(response, 200, { ok: true, result, usage: usageSummary(usage, state) });
    return true;
  }

  return false;
}

function parseToggle(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function evaluateDeviceLimitBlocks(
  state: VigilState,
  usage: UsageState,
  result: { device: string; dayKey: string },
  now: Date
): string[] {
  const before = new Set((state.limitBlocks || []).filter((block) => new Date(block.until) > now).map((block) => block.id));
  const day = normalizeUsageDay(usage[result.dayKey] || {});
  const bucket = day.devices?.[result.device] as UsageBucket | undefined;
  if (!bucket) return [];

  for (const [app, seconds] of Object.entries(bucket.apps || {})) {
    if (Number(seconds || 0) <= 0) continue;
    activeLimitPolicy(state, usage, { app, device: result.device }, now);
  }

  for (const [hostname, seconds] of Object.entries(bucket.sites || {})) {
    if (Number(seconds || 0) <= 0) continue;
    activeLimitPolicy(state, usage, { app: "Mobile Safari", hostname, device: result.device }, now);
  }

  return (state.limitBlocks || [])
    .filter((block) => new Date(block.until) > now && !before.has(block.id))
    .map((block) => block.id);
}
