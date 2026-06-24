import type { IncomingMessage, ServerResponse } from "node:http";
import { deviceUsageSyncAuthorization } from "../apiSecurity.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { buildIosMdmEnrollmentProfile, iosMdmDoctor, markIosMdmEnrollmentGenerated, normalizeIosMdmSettings, publicIosMdmSettings, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "../iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated, normalizeIosSettings } from "../iosProfiles.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState, saveUsage } from "../store.js";
import type { SentinelState, UnknownRecord, UsageState } from "../types.js";
import { syncDeviceUsageSnapshot, usageSummary } from "../usage.js";
import { readBody, sendDownload, sendJson } from "./http.js";
import { publicIosState } from "./statePayload.js";

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
}

export interface IosMdmPushResult extends UnknownRecord {
  pushed?: number | boolean;
  failed?: number | boolean;
  queued?: boolean;
}

interface DeviceApiContext {
  state: SentinelState;
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
    state.deviceControls.ios = normalizeIosSettings(body, state.deviceControls.ios) as SentinelState["deviceControls"]["ios"];
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
      blockedAppBundleIds: current.blockedAppBundleIds || [],
      allowedAppBundleIds: current.allowedAppBundleIds || [],
      deniedUrls: current.deniedUrls || [],
      allowedUrls: current.allowedUrls || []
    }, current) as SentinelState["deviceControls"]["ios"];
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
    state.deviceControls.ios.mdm = normalizeIosMdmSettings(body, state.deviceControls.ios.mdm) as SentinelState["deviceControls"]["ios"]["mdm"];
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
    const profile = buildIosMdmEnrollmentProfile(state);
    markIosMdmEnrollmentGenerated(state);
    addEvent(state, "ios_mdm_enrollment_generated", { bytes: Buffer.byteLength(profile), source: "app" });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return true;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/queue-policy") {
    const result = queueIosMdmPolicyRefresh(state, "app-refresh");
    const push = await pushIosMdmQueuedCommands(state, "app-refresh", new Date(), { force: true }) as IosMdmPushResult;
    addEvent(state, "ios_mdm_policy_queued", result);
    if (push.pushed || push.failed) addEvent(state, "ios_mdm_push", push);
    await saveState(state);
    sendJson(response, 200, { ok: Boolean(result.queued || push.pushed), result, push });
    return true;
  }

  if (method === "GET" && path === "/api/devices/ios/profile.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state);
    markIosProfileGenerated(state);
    addEvent(state, "ios_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return true;
  }

  if (method === "POST" && path === "/api/devices/usage") {
    const body = await readBody(request);
    const authorization = deviceUsageSyncAuthorization({
      headers: request.headers,
      url,
      body,
      enrollmentSecret: state.deviceControls?.ios?.mdm?.enrollmentSecret
    }) as GuardResult;
    if (!authorization.ok) {
      sendJson(response, authorization.status || 403, { error: authorization.error || "Forbidden" });
      return true;
    }

    const result = syncDeviceUsageSnapshot(usage, body, new Date(), {
      allowedDevices: authorization.kind === "device-token" ? ["phone"] : DEVICE_TARGETS
    });
    addEvent(state, "device_usage_synced", {
      device: result.device,
      dayKey: result.dayKey,
      totalSeconds: result.deviceTotalSeconds
    });
    await saveUsage(usage);
    await saveState(state);
    sendJson(response, 200, { ok: true, result, usage: usageSummary(usage, state) });
    return true;
  }

  return false;
}
