import type { ControlElement, DashboardData, FormPayload, QueuePolicyResponse } from "./app-model.js";
import { detailBlock } from "./dom.js";
import { shortDateTime } from "./format.js";

type QueryElement = (selector: string) => ControlElement;
type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;

interface DevicePanelContext {
  $: QueryElement;
  post: PostRequest;
  lines(value: unknown): string[];
  toast(message: string): void;
  errorMessage(error: unknown): string;
  refresh(): Promise<void>;
}

export function createDevicePanel(context: DevicePanelContext) {
  return {
    bind() {
      bindDeviceForms(context);
    },
    render(devices: DashboardData["devices"]) {
      renderDevices(devices, context.$);
    }
  };
}

function bindDeviceForms({ $, post, lines, toast, errorMessage, refresh }: DevicePanelContext): void {
  $("#iosForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      await post("/api/devices/ios/settings", {
        enabled: $("#iosEnabled").checked,
        mode: $("#iosMode").value,
        webMode: $("#iosWebMode").value,
        blockApps: $("#iosBlockApps").checked,
        blockWeb: $("#iosBlockWeb").checked,
        hardenRemoval: $("#iosHardenRemoval").checked,
        restrictInstallAndErase: $("#iosRestrictInstallErase").checked,
        allowSafariHistoryClearing: $("#iosAllowSafariHistoryClearing").checked,
        blockedAppBundleIds: lines($("#iosBlockedBundles").value),
        allowedAppBundleIds: lines($("#iosAllowedBundles").value),
        deniedUrls: lines($("#iosDeniedUrls").value),
        allowedUrls: lines($("#iosAllowedUrls").value),
        focusedSocial: readFocusedSocialPayload($)
      });
      toast("iPhone policy saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#iosDownloadProfile").addEventListener("click", () => {
    window.location.href = "/api/devices/ios/profile.mobileconfig";
  });

  $("#iosMdmForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      const payload: FormPayload = {
        enabled: $("#iosMdmEnabled").checked,
        publicBaseUrl: $("#iosMdmPublicBaseUrl").value,
        topic: $("#iosMdmTopic").value,
        identityCertificateUuid: $("#iosMdmIdentityUuid").value,
        signMessage: $("#iosMdmSignMessage").checked,
        useDevelopmentApns: $("#iosMdmDevApns").checked
      };
      const identityPayload = $("#iosMdmIdentityPayload").value.trim();
      const identityPassword = $("#iosMdmIdentityPassword").value;
      const pushPayload = $("#iosMdmPushPayload").value.trim();
      const pushPassword = $("#iosMdmPushPassword").value;
      if (identityPayload) payload.identityCertificatePayloadBase64 = identityPayload;
      if (identityPassword) payload.identityCertificatePassword = identityPassword;
      if (pushPayload) payload.pushCertificatePayloadBase64 = pushPayload;
      if (pushPassword) payload.pushCertificatePassword = pushPassword;
      await post("/api/devices/ios/mdm/settings", payload);
      $("#iosMdmIdentityPayload").value = "";
      $("#iosMdmIdentityPassword").value = "";
      $("#iosMdmPushPayload").value = "";
      $("#iosMdmPushPassword").value = "";
      toast("Advanced iPhone MDM setup saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#iosMdmDownloadEnrollment").addEventListener("click", () => {
    window.location.href = "/api/devices/ios/mdm/enrollment.mobileconfig";
  });

  $("#iosMdmQueuePolicy").addEventListener("click", async () => {
    try {
      const response = await post<QueuePolicyResponse>("/api/devices/ios/mdm/queue-policy", {});
      toast(response.result?.queued ? `Queued ${response.result.queued} iPhone update(s)` : "No enrolled iPhones to update");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });
}

function renderDevices(devices: DashboardData["devices"], $: QueryElement): void {
  if (!devices) return;
  const ios = devices.ios || {};
  $("#iosEnabled").checked = Boolean(ios.enabled);
  $("#iosMode").value = ios.mode || "denylist";
  $("#iosWebMode").value = ios.webMode || "denylist";
  $("#iosBlockApps").checked = ios.blockApps !== false;
  $("#iosBlockWeb").checked = ios.blockWeb !== false;
  $("#iosHardenRemoval").checked = ios.removalHardened || ios.hardenRemoval !== false;
  $("#iosRestrictInstallErase").checked = ios.restrictInstallAndErase !== false;
  $("#iosAllowSafariHistoryClearing").checked = ios.allowSafariHistoryClearing !== false;
  $("#iosBlockedBundles").value = (ios.blockedAppBundleIds || []).join("\n");
  $("#iosAllowedBundles").value = (ios.allowedAppBundleIds || []).join("\n");
  $("#iosDeniedUrls").value = (ios.deniedUrls || []).join("\n");
  $("#iosAllowedUrls").value = (ios.allowedUrls || []).join("\n");
  renderFocusedSocialSettings(ios.focusedSocial || {}, $);

  $("#iosStatus").textContent = ios.enabled ? "Enabled" : "Ready";
  $("#iosStatus").className = ios.enabled ? "pill good" : "pill neutral";
  $("#iosStatusTitle").textContent = ios.enabled ? "Supervised policy enabled" : "Supervised profile ready";
  $("#iosStatusText").textContent = ios.note || "Apple-only iPhone blocking needs a supervised device policy.";

  const iosSummary = $("#iosSummary");
  iosSummary.replaceChildren();
  const profile = ios.profile || {};
  const manageEngine = ios.manageEngine || {};
  [
    ["Delivery", manageEngine.deliveryProvider === "manageengine" ? "ManageEngine" : "Apple devices only"],
    ["Setup", ios.supervisedRequired ? "supervised iPhone required" : "standard"],
    ["Apps", ios.blockApps ? `${profile.appBundleCount || 0} bundle IDs` : "off"],
    ["Web", ios.blockWeb ? `${profile.deniedUrlCount || 0} denied / ${profile.allowedUrlCount || 0} allowed` : "off"],
    ["Web clips", profile.webClipCount ? `${profile.webClipCount} managed` : "none"],
    ["Focused social", focusedSocialSummaryText(profile.focusedSocial)],
    ["Native social apps", nativeSocialText(profile.focusedSocial, Boolean(ios.enabled))],
    ["Grayscale", profile.grayscale?.desired ? `${profile.grayscale.label || "on"}${profile.grayscale.settingsGuarded ? " + Settings guard" : ""}` : "normal"],
    ["Native Reels", "not available through public iOS APIs"],
    ["Safari history", ios.allowSafariHistoryClearing !== false ? "clearing allowed" : "clearing blocked"],
    ["Removal", ios.removalHardened ? "passcode protected" : "device removable"],
    ["Profile", profile.generatedFrom || "saved policy"],
    ["ManageEngine export", manageEngine.exportCommand || "npm run ios:manageengine:export"],
    ["ManageEngine policy", manageEngine.policyPath || "data/manageengine/vigil-manageengine-policy.mobileconfig"],
    ["Enrollment window", manageEngine.enrollmentWindowCommand || "npm run ios:manageengine:apply-enrollment-window"]
  ].forEach(([label, value]) => iosSummary.append(deviceRow(label, value)));

  const mdm = ios.mdm || {};
  $("#iosMdmEnabled").checked = Boolean(mdm.enabled);
  $("#iosMdmPublicBaseUrl").value = mdm.publicBaseUrl || "";
  $("#iosMdmTopic").value = mdm.topic || "";
  $("#iosMdmIdentityUuid").value = mdm.identityCertificateUuid || "";
  $("#iosMdmIdentityPayload").placeholder = mdm.identityCertificatePayloadSet ? "Saved payload is set" : "Base64 payload";
  $("#iosMdmIdentityPassword").placeholder = mdm.identityCertificatePasswordSet ? "Saved password is set" : "Leave blank to keep saved password";
  $("#iosMdmPushPayload").placeholder = mdm.pushCertificatePayloadSet ? "Saved APNs push certificate is set" : "Base64 APNs push PKCS#12";
  $("#iosMdmPushPassword").placeholder = mdm.pushCertificatePasswordSet ? "Saved password is set" : "Leave blank to keep saved password";
  $("#iosMdmSignMessage").checked = Boolean(mdm.signMessage);
  $("#iosMdmDevApns").checked = Boolean(mdm.useDevelopmentApns);
  $("#iosMdmStatus").textContent = mdm.enabled ? (mdm.ready ? "Advanced Ready" : "Advanced Setup") : "Not used";
  $("#iosMdmStatus").className = mdm.enabled ? (mdm.ready ? "pill good" : "pill warn") : "pill neutral";
  $("#iosMdmTitle").textContent = mdm.enabled ? "Advanced self-hosted MDM" : "ManageEngine is the normal path";
  $("#iosMdmText").textContent = mdm.note || "Vigil normally exports profiles for ManageEngine; use this only if replacing ManageEngine with your own APNs-backed MDM server.";

  const mdmSummary = $("#iosMdmSummary");
  mdmSummary.replaceChildren();
  [
    ["Default delivery", "ManageEngine"],
    ["Self-hosted URL", mdm.publicBaseUrl || "not set"],
    ["Self-hosted identity", mdm.identityCertificatePayloadSet ? "payload set" : "missing payload"],
    ["Self-hosted APNs", mdm.pushCertificatePayloadSet ? "certificate set" : "missing certificate"],
    ["Self-hosted enroll", mdm.enrollmentUrl || mdm.localEnrollmentPath || "not ready"],
    ["Self-hosted devices", `${mdm.enrolledDeviceCount || 0} enrolled`],
    ["Self-hosted commands", `${mdm.pendingCommandCount || 0} queued / ${mdm.sentCommandCount || 0} sent`],
    ["Grayscale command", mdm.grayscale?.desired ? `on: ${mdm.grayscale.label || "active"}` : "normal"],
    ["Last push", mdm.lastPushAt ? `${shortDateTime(mdm.lastPushAt)} ${mdm.lastPushStatus || ""}`.trim() : "never"],
    ["Push error", mdm.lastPushError || "none"],
    ["Last seen", mdm.lastSeenAt ? shortDateTime(mdm.lastSeenAt) : "never"],
    ["Self-hosted wireless", mdm.pushSupported ? "APNs ready" : "not the ManageEngine path"]
  ].forEach(([label, value]) => mdmSummary.append(deviceRow(label, value)));
  for (const blocker of mdm.blockers || []) {
    mdmSummary.append(deviceRow("Self-hosted need", blocker));
  }
  for (const device of (mdm.devices || []).slice(0, 3)) {
    const details = [device.status, device.productName, device.osVersion].filter(Boolean).join(" / ");
    mdmSummary.append(deviceRow(device.udid || "iPhone", details || device.lastStatus || "seen"));
  }
}

function readFocusedSocialPayload($: QueryElement) {
  return {
    enabled: $("#iosFocusedSocialEnabled").checked,
    forceWebClips: $("#iosFocusedSocialForceWebClips").checked,
    instagram: {
      enabled: $("#iosFocusedInstagramEnabled").checked,
      reels: $("#iosFocusedInstagramReels").checked,
      explore: $("#iosFocusedInstagramExplore").checked,
      suggested: $("#iosFocusedInstagramSuggested").checked,
      shopping: $("#iosFocusedInstagramShopping").checked,
      ads: $("#iosFocusedInstagramAds").checked
    },
    youtube: {
      enabled: $("#iosFocusedYoutubeEnabled").checked,
      shorts: $("#iosFocusedYoutubeShorts").checked,
      home: $("#iosFocusedYoutubeHome").checked,
      explore: $("#iosFocusedYoutubeExplore").checked,
      suggested: $("#iosFocusedYoutubeSuggested").checked,
      ads: $("#iosFocusedYoutubeAds").checked
    },
    snapchat: {
      enabled: $("#iosFocusedSnapchatEnabled").checked,
      spotlight: $("#iosFocusedSnapchatSpotlight").checked,
      stories: $("#iosFocusedSnapchatStories").checked
    }
  };
}

function renderFocusedSocialSettings(value: Record<string, unknown>, $: QueryElement): void {
  const instagram = recordValue(value.instagram);
  const youtube = recordValue(value.youtube);
  const snapchat = recordValue(value.snapchat);
  $("#iosFocusedSocialEnabled").checked = value.enabled !== false;
  $("#iosFocusedSocialForceWebClips").checked = value.forceWebClips !== false;
  $("#iosFocusedInstagramEnabled").checked = instagram.enabled !== false;
  $("#iosFocusedInstagramReels").checked = instagram.reels !== false;
  $("#iosFocusedInstagramExplore").checked = instagram.explore !== false;
  $("#iosFocusedInstagramSuggested").checked = instagram.suggested !== false;
  $("#iosFocusedInstagramShopping").checked = instagram.shopping !== false;
  $("#iosFocusedInstagramAds").checked = instagram.ads !== false;
  $("#iosFocusedYoutubeEnabled").checked = youtube.enabled !== false;
  $("#iosFocusedYoutubeShorts").checked = youtube.shorts !== false;
  $("#iosFocusedYoutubeHome").checked = youtube.home !== false;
  $("#iosFocusedYoutubeExplore").checked = youtube.explore !== false;
  $("#iosFocusedYoutubeSuggested").checked = youtube.suggested !== false;
  $("#iosFocusedYoutubeAds").checked = youtube.ads !== false;
  $("#iosFocusedSnapchatEnabled").checked = snapchat.enabled !== false;
  $("#iosFocusedSnapchatSpotlight").checked = snapchat.spotlight !== false;
  $("#iosFocusedSnapchatStories").checked = snapchat.stories !== false;
}

function focusedSocialSummaryText(value: unknown): string {
  const summary = recordValue(value);
  if (summary.enabled === false) return "off";
  const platformCount = Number(summary.platformCount || 0);
  const featureCount = Number(summary.featureCount || 0);
  const deniedUrlCount = Number(summary.deniedUrlCount || 0);
  if (!platformCount) return "no platforms";
  return `${platformCount} platforms / ${featureCount} features / ${deniedUrlCount} URLs`;
}

function nativeSocialText(value: unknown, active: boolean): string {
  const summary = recordValue(value);
  if (summary.enabled === false) return "unchanged";
  if (!active) return "ready when enabled";
  if (summary.forceWebClips === false) return "left available";
  const nativeAppBundleCount = Number(summary.nativeAppBundleCount || 0);
  return nativeAppBundleCount > 0 ? `${nativeAppBundleCount} blocked for web clips` : "ready during phone lock";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function deviceRow(label: string, value: string | number | boolean | null | undefined) {
  const row = detailBlock(label, value || "--");
  row.className = "device-row";
  return row;
}
