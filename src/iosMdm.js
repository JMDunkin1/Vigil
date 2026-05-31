import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APP_NAME, PORT } from "./defaults.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "./iosProfiles.js";
import { plistData, toPlist } from "./plist.js";

const MDM_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios.mdm";
const MDM_PAYLOAD_IDENTIFIER = `${MDM_PROFILE_IDENTIFIER}.payload`;
const DEFAULT_ACCESS_RIGHTS = 8179;
const MAX_COMMANDS = 500;
const DEVICE_INFO_QUERIES = [
  "DeviceName",
  "OSVersion",
  "ProductName",
  "ModelName",
  "SerialNumber",
  "IsSupervised",
  "IsDeviceLocatorServiceEnabled",
  "IsActivationLockEnabled",
  "BatteryLevel"
];

export function normalizeIosMdmSettings(body = {}, existing = {}) {
  const enabled = body.enabled === undefined ? Boolean(existing.enabled) : Boolean(body.enabled);
  return {
    ...existing,
    enabled,
    publicBaseUrl: normalizeBaseUrl(body.publicBaseUrl ?? existing.publicBaseUrl ?? ""),
    topic: String(body.topic ?? existing.topic ?? "").trim(),
    identityCertificateUuid: normalizeUuid(body.identityCertificateUuid ?? existing.identityCertificateUuid ?? ""),
    identityCertificatePayloadBase64: normalizeBase64(body.identityCertificatePayloadBase64 ?? existing.identityCertificatePayloadBase64 ?? ""),
    identityCertificatePassword: String(body.identityCertificatePassword ?? existing.identityCertificatePassword ?? ""),
    accessRights: clampInteger(body.accessRights ?? existing.accessRights, 1, 8191, DEFAULT_ACCESS_RIGHTS),
    signMessage: body.signMessage === undefined ? Boolean(existing.signMessage) : Boolean(body.signMessage),
    useDevelopmentApns: body.useDevelopmentApns === undefined ? Boolean(existing.useDevelopmentApns) : Boolean(body.useDevelopmentApns),
    checkOutWhenRemoved: body.checkOutWhenRemoved === undefined ? existing.checkOutWhenRemoved !== false : body.checkOutWhenRemoved !== false,
    enrollmentSecret: existing.enrollmentSecret || randomSecret(),
    devices: normalizeMdmDevices(existing.devices),
    commands: normalizeMdmCommands(existing.commands),
    lastEnrollmentProfileGeneratedAt: existing.lastEnrollmentProfileGeneratedAt || null,
    lastCheckInAt: existing.lastCheckInAt || null,
    lastCommandQueuedAt: existing.lastCommandQueuedAt || null,
    lastPolicyHash: String(existing.lastPolicyHash || "")
  };
}

export function publicIosMdmSettings(mdm = {}) {
  const { enrollmentSecret, identityCertificatePayloadBase64, identityCertificatePassword, ...rest } = mdm || {};
  return {
    ...rest,
    enrollmentSecretSet: Boolean(enrollmentSecret),
    identityCertificatePayloadSet: Boolean(identityCertificatePayloadBase64),
    identityCertificatePasswordSet: Boolean(identityCertificatePassword)
  };
}

export function iosMdmSummary(state, now = new Date()) {
  const mdm = currentIosMdmSettings(state);
  const devices = normalizeMdmDevices(mdm.devices);
  const commands = normalizeMdmCommands(mdm.commands);
  const blockers = iosMdmReadinessBlockers(mdm);
  const enabled = Boolean(mdm.enabled);
  const enrolled = devices.filter((device) => device.status !== "checked-out");
  const pending = commands.filter((command) => command.status === "queued");
  const sent = commands.filter((command) => command.status === "sent");
  const completed = commands.filter((command) => command.status === "acknowledged");
  const failed = commands.filter((command) => ["error", "command-format-error"].includes(command.status));
  const ready = enabled && blockers.length === 0;

  return {
    enabled,
    ready,
    status: !enabled ? "off" : (ready ? "ready" : "setup-needed"),
    note: mdmNote(enabled, ready, blockers),
    publicBaseUrl: mdm.publicBaseUrl,
    topic: mdm.topic,
    identityCertificateUuid: mdm.identityCertificateUuid,
    accessRights: mdm.accessRights,
    signMessage: Boolean(mdm.signMessage),
    useDevelopmentApns: Boolean(mdm.useDevelopmentApns),
    checkOutWhenRemoved: mdm.checkOutWhenRemoved !== false,
    localEnrollmentPath: enrollmentPath(mdm),
    enrollmentUrl: fullMdmUrl(mdm, "/mdm/enroll.mobileconfig"),
    policyProfileUrl: fullMdmUrl(mdm, "/mdm/policy.mobileconfig"),
    checkInUrl: fullMdmUrl(mdm, "/mdm/checkin"),
    serverUrl: fullMdmUrl(mdm, "/mdm/connect"),
    pushSupported: false,
    pushNote: "Command queue is ready; APNs push delivery is the next server piece for truly wireless wakeups.",
    enrolledDeviceCount: enrolled.length,
    pendingCommandCount: pending.length,
    sentCommandCount: sent.length,
    completedCommandCount: completed.length,
    failedCommandCount: failed.length,
    lastSeenAt: latestDate(devices.map((device) => device.lastSeenAt)),
    lastEnrollmentProfileGeneratedAt: mdm.lastEnrollmentProfileGeneratedAt || null,
    lastCheckInAt: mdm.lastCheckInAt || null,
    lastCommandQueuedAt: mdm.lastCommandQueuedAt || null,
    lastPolicyHash: mdm.lastPolicyHash || "",
    blockers,
    devices: devices.map(publicMdmDevice),
    commands: commands.slice(0, 12).map(publicMdmCommand),
    generatedAt: now.toISOString()
  };
}

export function markIosMdmEnrollmentGenerated(state, at = new Date()) {
  const mdm = ensureMdmState(state);
  mdm.lastEnrollmentProfileGeneratedAt = at.toISOString();
}

export function buildIosMdmEnrollmentProfile(state, now = new Date()) {
  const mdm = currentIosMdmSettings(state);
  const baseUrl = mdm.publicBaseUrl || `https://replace-with-public-mdm-host.example`;
  const mdmPayload = commonPayload("com.apple.mdm", "Vigil MDM", "mdm", {
    AccessRights: mdm.accessRights || DEFAULT_ACCESS_RIGHTS,
    CheckInURL: `${baseUrl}/mdm/checkin?token=${encodeURIComponent(mdm.enrollmentSecret)}`,
    CheckOutWhenRemoved: mdm.checkOutWhenRemoved !== false,
    ServerURL: `${baseUrl}/mdm/connect?token=${encodeURIComponent(mdm.enrollmentSecret)}`,
    SignMessage: Boolean(mdm.signMessage),
    Topic: mdm.topic || "com.apple.mgmt.replace-with-apns-topic",
    UseDevelopmentAPNS: Boolean(mdm.useDevelopmentApns)
  });

  if (mdm.identityCertificateUuid) {
    mdmPayload.IdentityCertificateUUID = mdm.identityCertificateUuid;
  }

  const payloads = [];
  if (mdm.identityCertificatePayloadBase64 && mdm.identityCertificateUuid) {
    payloads.push(commonPayload("com.apple.security.pkcs12", "Vigil MDM Identity", "identity", {
      PayloadUUID: mdm.identityCertificateUuid,
      PayloadContent: plistData(mdm.identityCertificatePayloadBase64),
      Password: mdm.identityCertificatePassword || ""
    }));
  }
  payloads.push(mdmPayload);

  return toPlist({
    PayloadContent: payloads,
    PayloadDescription: "Enrolls this supervised iPhone with the Vigil MDM server for desktop-managed app and web restrictions.",
    PayloadDisplayName: "Vigil iPhone MDM",
    PayloadIdentifier: MDM_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: true,
    PayloadType: "Configuration",
    PayloadUUID: randomUUID(),
    PayloadVersion: 1
  });
}

export function authorizeIosMdmRequest(state, url) {
  const mdm = currentIosMdmSettings(state);
  const token = url.searchParams.get("token") || "";
  return Boolean(mdm.enrollmentSecret && token && token === mdm.enrollmentSecret);
}

export function handleIosMdmCheckIn(state, requestBody, now = new Date()) {
  const mdm = ensureMdmState(state);
  const messageType = String(requestBody.MessageType || requestBody.messageType || "Unknown");
  const device = upsertMdmDevice(state, requestBody, now);
  device.lastMessageType = messageType;
  device.lastSeenAt = now.toISOString();
  mdm.lastCheckInAt = now.toISOString();

  if (messageType === "TokenUpdate") {
    device.status = "enrolled";
    device.pushMagic = String(requestBody.PushMagic || device.pushMagic || "");
    device.topic = String(requestBody.Topic || device.topic || "");
    device.token = dataString(requestBody.Token) || device.token || "";
    device.unlockToken = dataString(requestBody.UnlockToken) || device.unlockToken || "";
    queueIosMdmInventory(state, device.udid, "token-update", now);
    queueIosMdmPolicyRefresh(state, "token-update", now, { udids: [device.udid] });
  } else if (messageType === "CheckOut") {
    device.status = "checked-out";
    device.checkedOutAt = now.toISOString();
    cancelQueuedCommandsForDevice(mdm, device.udid);
  } else if (messageType === "Authenticate") {
    device.status = device.status || "authenticating";
  }

  trimCommands(mdm);
  return {
    ok: true,
    empty: true,
    messageType,
    udid: device.udid
  };
}

export function handleIosMdmConnect(state, requestBody, now = new Date()) {
  const mdm = ensureMdmState(state);
  const device = upsertMdmDevice(state, requestBody, now);
  const status = normalizeStatus(requestBody.Status || "Idle");
  device.status = device.status === "checked-out" ? "enrolled" : (device.status || "enrolled");
  device.lastStatus = status;
  device.lastSeenAt = now.toISOString();
  mdm.lastCheckInAt = now.toISOString();

  if (requestBody.CommandUUID) {
    recordMdmCommandResult(mdm, device, requestBody, status, now);
  }

  const command = nextCommandForDevice(mdm, device.udid, now);
  trimCommands(mdm);
  if (!command) {
    return {
      ok: true,
      empty: true,
      status,
      udid: device.udid
    };
  }

  return {
    ok: true,
    empty: false,
    status,
    udid: device.udid,
    command,
    body: buildQueuedCommandPayload(command)
  };
}

export function queueIosMdmPolicyRefresh(state, reason = "policy-refresh", now = new Date(), options = {}) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { queued: 0, reason: "disabled" };
  const profile = buildIosConfigurationProfile(state, now);
  const profileBase64 = Buffer.from(profile, "utf8").toString("base64");
  const policyHash = iosPolicyHash(state, now);
  return queueIosMdmPolicyProfile(state, reason, now, options, profileBase64, policyHash);
}

export function maybeQueueIosMdmPolicyRefresh(state, reason = "policy-refresh", now = new Date()) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { queued: 0, reason: "disabled" };
  const profile = buildIosConfigurationProfile(state, now);
  const policyHash = iosPolicyHash(state, now);
  if (mdm.lastPolicyHash === policyHash) return { queued: 0, unchanged: true, policyHash };
  mdm.lastPolicyHash = policyHash;
  const profileBase64 = Buffer.from(profile, "utf8").toString("base64");
  return queueIosMdmPolicyProfile(state, reason, now, {}, profileBase64, policyHash);
}

function queueIosMdmPolicyProfile(state, reason, now, options, profileBase64, policyHash) {
  const mdm = ensureMdmState(state);
  const allowedUdids = options.udids ? new Set(options.udids) : null;
  const devices = normalizeMdmDevices(mdm.devices)
    .filter((device) => device.status !== "checked-out")
    .filter((device) => !allowedUdids || allowedUdids.has(device.udid));

  let queued = 0;
  for (const device of devices) {
    const duplicate = mdm.commands.some((command) => (
      command.udid === device.udid
      && command.requestType === "InstallProfile"
      && ["queued", "sent"].includes(command.status)
      && command.policyHash === policyHash
    ));
    if (duplicate) continue;
    mdm.commands.unshift({
      id: randomUUID(),
      commandUuid: randomUUID(),
      udid: device.udid,
      requestType: "InstallProfile",
      reason,
      status: "queued",
      queuedAt: now.toISOString(),
      sentAt: null,
      completedAt: null,
      attempts: 0,
      policyHash,
      profileBase64
    });
    queued += 1;
  }

  mdm.lastPolicyHash = policyHash;
  if (queued) mdm.lastCommandQueuedAt = now.toISOString();
  trimCommands(mdm);
  return { queued, deviceCount: devices.length, policyHash };
}

export function queueIosMdmInventory(state, udid, reason = "inventory", now = new Date()) {
  const mdm = ensureMdmState(state);
  if (!udid) return { queued: 0 };
  const inventoryCommands = [
    {
      requestType: "DeviceInformation",
      command: {
        RequestType: "DeviceInformation",
        Queries: DEVICE_INFO_QUERIES
      }
    },
    {
      requestType: "ProfileList",
      command: { RequestType: "ProfileList" }
    },
    {
      requestType: "InstalledApplicationList",
      command: {
        RequestType: "InstalledApplicationList",
        ManagedAppsOnly: false
      }
    }
  ];

  let queued = 0;
  for (const item of inventoryCommands) {
    const duplicate = mdm.commands.some((command) => (
      command.udid === udid
      && command.requestType === item.requestType
      && ["queued", "sent"].includes(command.status)
    ));
    if (duplicate) continue;
    mdm.commands.unshift({
      id: randomUUID(),
      commandUuid: randomUUID(),
      udid,
      requestType: item.requestType,
      command: item.command,
      reason,
      status: "queued",
      queuedAt: now.toISOString(),
      sentAt: null,
      completedAt: null,
      attempts: 0
    });
    queued += 1;
  }
  if (queued) mdm.lastCommandQueuedAt = now.toISOString();
  trimCommands(mdm);
  return { queued };
}

function currentIosMdmSettings(state) {
  return normalizeIosMdmSettings(state.deviceControls?.ios?.mdm || {}, state.deviceControls?.ios?.mdm || {});
}

function iosPolicyHash(state, now) {
  const ios = state.deviceControls?.ios || {};
  const stablePolicy = {
    enabled: Boolean(ios.enabled),
    mode: ios.mode || "denylist",
    webMode: ios.webMode || "denylist",
    blockApps: ios.blockApps !== false,
    blockWeb: ios.blockWeb !== false,
    hardenRemoval: ios.hardenRemoval !== false,
    restrictInstallAndErase: ios.restrictInstallAndErase !== false,
    blockedAppBundleIds: ios.blockedAppBundleIds || [],
    allowedAppBundleIds: ios.allowedAppBundleIds || [],
    deniedUrls: ios.deniedUrls || [],
    allowedUrls: ios.allowedUrls || [],
    removalPasswordSet: Boolean(ios.removalPassword),
    targets: iosPolicyTargets(state, now)
  };
  return createHash("sha256").update(JSON.stringify(stablePolicy)).digest("hex");
}

function ensureMdmState(state) {
  state.deviceControls ||= {};
  state.deviceControls.ios ||= {};
  state.deviceControls.ios.mdm = normalizeIosMdmSettings(state.deviceControls.ios.mdm || {}, state.deviceControls.ios.mdm || {});
  return state.deviceControls.ios.mdm;
}

function iosMdmReadinessBlockers(mdm) {
  const blockers = [];
  if (!mdm.publicBaseUrl) {
    blockers.push("Set a public HTTPS URL that forwards to this local server.");
  } else if (!mdm.publicBaseUrl.startsWith("https://")) {
    blockers.push("Apple MDM ServerURL and CheckInURL must use HTTPS.");
  }
  if (!/^com\.apple\.mgmt\.[A-Za-z0-9.-]+$/.test(mdm.topic || "")) {
    blockers.push("Set the APNs MDM topic from your Apple MDM push certificate.");
  }
  if (!mdm.identityCertificateUuid) {
    blockers.push("Set the UUID of the device identity certificate or SCEP payload used by the MDM profile.");
  }
  return blockers;
}

function mdmNote(enabled, ready, blockers) {
  if (!enabled) return "MDM server mode is off; static supervised profiles are still available.";
  if (ready) return "MDM enrollment profile and command endpoints are configured.";
  return blockers[0] || "Finish MDM setup before enrolling an iPhone.";
}

function buildQueuedCommandPayload(command) {
  if (command.requestType === "InstallProfile") {
    return {
      CommandUUID: command.commandUuid,
      Command: {
        RequestType: "InstallProfile",
        Payload: plistData(command.profileBase64)
      }
    };
  }

  return {
    CommandUUID: command.commandUuid,
    Command: command.command || { RequestType: command.requestType }
  };
}

function nextCommandForDevice(mdm, udid, now) {
  const command = mdm.commands.find((item) => (
    item.udid === udid
    && ["sent", "queued"].includes(item.status)
  ));
  if (!command) return null;
  if (command.status === "queued") {
    command.status = "sent";
    command.sentAt = now.toISOString();
    command.attempts = (command.attempts || 0) + 1;
  }
  return command;
}

function recordMdmCommandResult(mdm, device, requestBody, status, now) {
  const command = mdm.commands.find((item) => item.commandUuid === requestBody.CommandUUID);
  if (!command) return;

  command.lastResponseAt = now.toISOString();
  command.lastStatus = status;
  if (status === "acknowledged") {
    command.status = "acknowledged";
    command.completedAt = now.toISOString();
  } else if (status === "not-now") {
    command.status = "queued";
    command.notNowAt = now.toISOString();
  } else if (status === "error" || status === "command-format-error") {
    command.status = status === "error" ? "error" : "command-format-error";
    command.completedAt = now.toISOString();
    command.errorChain = requestBody.ErrorChain || [];
  }

  command.resultSummary = summarizeMdmResult(requestBody);
  if (command.requestType === "DeviceInformation" && requestBody.QueryResponses) {
    device.info = requestBody.QueryResponses;
  }
  if (command.requestType === "InstalledApplicationList" && requestBody.InstalledApplicationList) {
    device.installedApplicationCount = requestBody.InstalledApplicationList.length;
    device.installedApplicationsSample = requestBody.InstalledApplicationList.slice(0, 20);
  }
  if (command.requestType === "ProfileList" && requestBody.ProfileList) {
    device.profileCount = requestBody.ProfileList.length;
  }
}

function summarizeMdmResult(body) {
  const keys = Object.keys(body || {}).filter((key) => !["UDID", "CommandUUID", "Status"].includes(key));
  return {
    keys,
    error: Array.isArray(body.ErrorChain) ? body.ErrorChain[0]?.USEnglishDescription || body.ErrorChain[0]?.LocalizedDescription || "" : ""
  };
}

function upsertMdmDevice(state, message, now) {
  const mdm = state.deviceControls?.ios?.mdm || ensureMdmState(state);
  const udid = String(message.UDID || message.EnrollmentID || message.UserID || "unknown-device").trim();
  const existing = mdm.devices.find((device) => device.udid === udid);
  const device = existing || {
    id: randomUUID(),
    udid,
    status: "enrolled",
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString()
  };
  device.udid = udid;
  device.lastSeenAt = now.toISOString();
  if (message.Topic) device.topic = String(message.Topic);
  if (!existing) mdm.devices.unshift(device);
  return device;
}

function cancelQueuedCommandsForDevice(mdm, udid) {
  for (const command of mdm.commands) {
    if (command.udid === udid && ["queued", "sent"].includes(command.status)) {
      command.status = "cancelled";
      command.completedAt = new Date().toISOString();
    }
  }
}

function trimCommands(mdm) {
  mdm.commands = normalizeMdmCommands(mdm.commands).slice(0, MAX_COMMANDS);
}

function commonPayload(type, name, suffix, values = {}) {
  return {
    ...values,
    PayloadDescription: `${name} generated by ${APP_NAME}.`,
    PayloadDisplayName: name,
    PayloadIdentifier: `${MDM_PROFILE_IDENTIFIER}.${suffix}`,
    PayloadType: type,
    PayloadUUID: values.PayloadUUID || randomUUID(),
    PayloadVersion: 1
  };
}

function publicMdmDevice(device) {
  return {
    id: device.id,
    udid: obscure(device.udid),
    status: device.status || "enrolled",
    topic: device.topic || "",
    lastStatus: device.lastStatus || "",
    lastMessageType: device.lastMessageType || "",
    firstSeenAt: device.firstSeenAt || null,
    lastSeenAt: device.lastSeenAt || null,
    checkedOutAt: device.checkedOutAt || null,
    productName: device.info?.ProductName || "",
    osVersion: device.info?.OSVersion || "",
    isSupervised: device.info?.IsSupervised ?? null,
    installedApplicationCount: device.installedApplicationCount || 0,
    profileCount: device.profileCount || 0
  };
}

function publicMdmCommand(command) {
  return {
    id: command.id,
    commandUuid: command.commandUuid,
    udid: obscure(command.udid),
    requestType: command.requestType,
    reason: command.reason || "",
    status: command.status,
    queuedAt: command.queuedAt || null,
    sentAt: command.sentAt || null,
    completedAt: command.completedAt || null,
    attempts: command.attempts || 0,
    lastStatus: command.lastStatus || "",
    error: command.errorChain?.[0]?.USEnglishDescription || command.resultSummary?.error || ""
  };
}

function fullMdmUrl(mdm, path) {
  const base = mdm.publicBaseUrl || `http://127.0.0.1:${PORT}`;
  return `${base}${path}?token=${encodeURIComponent(mdm.enrollmentSecret)}`;
}

function enrollmentPath(mdm) {
  return `/mdm/enroll.mobileconfig?token=${encodeURIComponent(mdm.enrollmentSecret)}`;
}

function normalizeMdmDevices(values) {
  return Array.isArray(values)
    ? values
      .filter((device) => device && typeof device === "object")
      .map((device) => ({
        ...device,
        id: device.id || randomUUID(),
        udid: String(device.udid || "unknown-device"),
        status: String(device.status || "enrolled")
      }))
    : [];
}

function normalizeMdmCommands(values) {
  return Array.isArray(values)
    ? values
      .filter((command) => command && typeof command === "object")
      .map((command) => ({
        ...command,
        id: command.id || randomUUID(),
        commandUuid: command.commandUuid || randomUUID(),
        status: String(command.status || "queued")
      }))
    : [];
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeUuid(value) {
  const raw = String(value || "").trim();
  return /^[0-9A-Fa-f-]{32,36}$/.test(raw) ? raw.toUpperCase() : raw;
}

function normalizeBase64(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeStatus(value) {
  return String(value || "Idle")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function latestDate(values) {
  const times = values
    .map((value) => value ? new Date(value).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function dataString(value) {
  if (!value) return "";
  if (value.__plistData) return value.__plistData;
  return String(value || "");
}

function obscure(value) {
  const text = String(value || "");
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function randomSecret() {
  return randomBytes(24).toString("base64url");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
