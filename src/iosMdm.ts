import { createHash, randomBytes, randomUUID } from "node:crypto";
import http2 from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { APP_NAME, PORT, defaultState } from "./defaults.js";
import { buildIosConfigurationProfile, IOS_PROFILE_IDENTIFIER, iosPolicyTargets } from "./iosProfiles.js";
import { parseBoolean } from "./booleans.js";
import { grayscaleDecision } from "./grayscale.js";
import { plistData, toPlist } from "./plist.js";
import type { IosMdmSettings, SentinelState, UnknownRecord } from "./types.js";

const MDM_PROFILE_IDENTIFIER = "com.local-screen-time.ios.mdm";
const DEFAULT_ACCESS_RIGHTS = 8179;
const MAX_COMMANDS = 500;
const PUSH_COOLDOWN_MS = 30_000;
const APNS_TIMEOUT_MS = 5_000;
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

interface MdmDevice extends UnknownRecord {
  id: string;
  udid: string;
  status: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  checkedOutAt?: string;
  lastMessageType?: string;
  pushMagic?: string;
  topic?: string;
  token?: string;
  tokenHex?: string;
  unlockToken?: string;
  lastStatus?: string;
  lastPushAt?: string;
  lastPushStatus?: string;
  lastPushError?: string;
  info?: UnknownRecord;
  installedApplicationCount?: number;
  installedApplicationsSample?: unknown[];
  profileCount?: number;
}

interface MdmCommand extends UnknownRecord {
  id: string;
  commandUuid: string;
  udid: string;
  requestType: string;
  reason?: string;
  status: string;
  queuedAt?: string;
  sentAt?: string | null;
  completedAt?: string | null;
  attempts?: number;
  policyHash?: string;
  profileBase64?: string;
  profileIdentifier?: string;
  command?: UnknownRecord;
  lastPushAt?: string;
  lastPushStatus?: string;
  lastPushError?: string;
  lastResponseAt?: string;
  lastStatus?: string;
  notNowAt?: string;
  errorChain?: Array<UnknownRecord>;
  resultSummary?: { keys: string[]; error: string };
  grayscaleDesired?: boolean;
  grayscaleHash?: string;
}

interface MdmSettings extends IosMdmSettings {
  devices: MdmDevice[];
  commands: MdmCommand[];
}

type MdmPayload = UnknownRecord & {
  PayloadDescription: string;
  PayloadDisplayName: string;
  PayloadIdentifier: string;
  PayloadType: string;
  PayloadUUID: string;
  PayloadVersion: number;
};

type PushSummary = UnknownRecord & {
  ok: boolean;
  skipped?: string;
  blockers?: string[];
  error?: string;
};

type ApnsTlsOptions = http2.ClientSessionOptions & {
  pfx?: Buffer;
  passphrase?: string;
};

type PlistDataValue = {
  __plistData: string;
};

interface MdmMessage extends UnknownRecord {
  UDID?: unknown;
  EnrollmentID?: unknown;
  UserID?: unknown;
  MessageType?: unknown;
  messageType?: unknown;
  PushMagic?: unknown;
  Topic?: unknown;
  Token?: unknown;
  UnlockToken?: unknown;
  Status?: unknown;
  CommandUUID?: unknown;
  ErrorChain?: Array<UnknownRecord>;
  QueryResponses?: UnknownRecord;
  InstalledApplicationList?: unknown[];
  ProfileList?: unknown[];
}

interface MdmPushRequest {
  endpoint: string;
  path: string;
  headers: http2.OutgoingHttpHeaders;
  payload: string;
}

interface ApnsResult extends UnknownRecord {
  ok: boolean;
  statusCode?: number;
  apnsId?: string;
  body?: string;
  error?: string;
}

interface PushOptions {
  force?: boolean;
  udids?: string[];
}

export function normalizeIosMdmSettings(body: UnknownRecord = {}, existing: Partial<IosMdmSettings> | Partial<MdmSettings> = {}): MdmSettings {
  const current = { ...defaultState().deviceControls.ios.mdm, ...existing };
  const enabled = body.enabled === undefined ? Boolean(current.enabled) : parseBoolean(body.enabled, false);
  return {
    ...current,
    enabled,
    publicBaseUrl: normalizeBaseUrl(body.publicBaseUrl ?? current.publicBaseUrl ?? ""),
    topic: String(body.topic ?? current.topic ?? "").trim(),
    identityCertificateUuid: normalizeUuid(body.identityCertificateUuid ?? current.identityCertificateUuid ?? ""),
    identityCertificatePayloadBase64: normalizeBase64(body.identityCertificatePayloadBase64 ?? current.identityCertificatePayloadBase64 ?? ""),
    identityCertificatePassword: String(body.identityCertificatePassword ?? current.identityCertificatePassword ?? ""),
    pushCertificatePayloadBase64: normalizeBase64(body.pushCertificatePayloadBase64 ?? current.pushCertificatePayloadBase64 ?? ""),
    pushCertificatePassword: String(body.pushCertificatePassword ?? current.pushCertificatePassword ?? ""),
    accessRights: clampInteger(body.accessRights ?? current.accessRights, 1, 8191, DEFAULT_ACCESS_RIGHTS),
    signMessage: body.signMessage === undefined ? Boolean(current.signMessage) : parseBoolean(body.signMessage, false),
    useDevelopmentApns: body.useDevelopmentApns === undefined ? Boolean(current.useDevelopmentApns) : parseBoolean(body.useDevelopmentApns, false),
    checkOutWhenRemoved: body.checkOutWhenRemoved === undefined ? current.checkOutWhenRemoved !== false : parseBoolean(body.checkOutWhenRemoved, true),
    enrollmentSecret: current.enrollmentSecret || randomSecret(),
    devices: normalizeMdmDevices(current.devices),
    commands: normalizeMdmCommands(current.commands),
    lastEnrollmentProfileGeneratedAt: current.lastEnrollmentProfileGeneratedAt || null,
    lastCheckInAt: current.lastCheckInAt || null,
    lastCommandQueuedAt: current.lastCommandQueuedAt || null,
    lastPushAt: current.lastPushAt || null,
    lastPushStatus: current.lastPushStatus || "",
    lastPushError: current.lastPushError || "",
    lastPolicyHash: String(current.lastPolicyHash || ""),
    lastGrayscaleHash: String(current.lastGrayscaleHash || ""),
    lastGrayscaleCommandQueuedAt: current.lastGrayscaleCommandQueuedAt || null
  };
}

export function publicIosMdmSettings(mdm: Partial<IosMdmSettings> | Partial<MdmSettings> = {}) {
  const {
    enrollmentSecret,
    identityCertificatePayloadBase64,
    identityCertificatePassword,
    pushCertificatePayloadBase64,
    pushCertificatePassword,
    devices,
    commands,
    ...rest
  } = mdm || {};
  return {
    ...rest,
    enrollmentSecretSet: Boolean(enrollmentSecret),
    identityCertificatePayloadSet: Boolean(identityCertificatePayloadBase64),
    identityCertificatePasswordSet: Boolean(identityCertificatePassword),
    pushCertificatePayloadSet: Boolean(pushCertificatePayloadBase64),
    pushCertificatePasswordSet: Boolean(pushCertificatePassword),
    enrolledDeviceCount: normalizeMdmDevices(devices).filter((device) => device.status !== "checked-out").length,
    pendingCommandCount: normalizeMdmCommands(commands).filter((command) => command.status === "queued").length
  };
}

export function iosMdmSummary(state: SentinelState, now = new Date()) {
  const mdm = ensureMdmState(state);
  const devices = normalizeMdmDevices(mdm.devices);
  const commands = normalizeMdmCommands(mdm.commands);
  const setupBlockers = iosMdmReadinessBlockers(mdm);
  const pushBlockers = setupBlockers.length ? [] : iosMdmPushBlockers(mdm);
  const blockers = [...setupBlockers, ...pushBlockers];
  const enabled = Boolean(mdm.enabled);
  const enrolled = devices.filter((device) => device.status !== "checked-out");
  const pending = commands.filter((command) => command.status === "queued");
  const sent = commands.filter((command) => command.status === "sent");
  const completed = commands.filter((command) => command.status === "acknowledged");
  const failed = commands.filter((command) => ["error", "command-format-error"].includes(command.status));
  const enrollmentReady = enabled && setupBlockers.length === 0;
  const ready = enabled && blockers.length === 0;
  const grayscale = grayscaleDecision(state, now, { device: "phone" });

  return {
    enabled,
    ready,
    enrollmentReady,
    status: !enabled ? "off" : (ready ? "ready" : (enrollmentReady ? "queue-only" : "setup-needed")),
    note: mdmNote(enabled, ready, enrollmentReady, blockers),
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
    pushSupported: setupBlockers.length === 0 && pushBlockers.length === 0,
    pushNote: setupBlockers.length === 0 && pushBlockers.length === 0
      ? "APNs wakeups are configured; queued commands can wake enrolled iPhones."
      : "APNs wakeups need a push certificate before queued commands can wake iPhones.",
    enrolledDeviceCount: enrolled.length,
    pendingCommandCount: pending.length,
    sentCommandCount: sent.length,
    completedCommandCount: completed.length,
    failedCommandCount: failed.length,
    lastSeenAt: latestDate(devices.map((device) => device.lastSeenAt)),
    lastEnrollmentProfileGeneratedAt: mdm.lastEnrollmentProfileGeneratedAt || null,
    lastCheckInAt: mdm.lastCheckInAt || null,
    lastCommandQueuedAt: mdm.lastCommandQueuedAt || null,
    lastPushAt: mdm.lastPushAt || null,
    lastPushStatus: mdm.lastPushStatus || "",
    lastPushError: mdm.lastPushError || "",
    lastPolicyHash: mdm.lastPolicyHash || "",
    lastGrayscaleHash: mdm.lastGrayscaleHash || "",
    lastGrayscaleCommandQueuedAt: mdm.lastGrayscaleCommandQueuedAt || null,
    grayscale: {
      desired: grayscale.desired,
      reason: grayscale.reason,
      label: grayscale.label,
      source: grayscale.source
    },
    blockers,
    devices: devices.map(publicMdmDevice),
    commands: commands.slice(0, 12).map(publicMdmCommand),
    generatedAt: now.toISOString()
  };
}

export function markIosMdmEnrollmentGenerated(state: SentinelState, at = new Date()): void {
  const mdm = ensureMdmState(state);
  mdm.lastEnrollmentProfileGeneratedAt = at.toISOString();
}

export function buildIosMdmEnrollmentProfile(state: SentinelState): string {
  const mdm = ensureMdmState(state);
  const baseUrl = mdm.publicBaseUrl || `https://replace-with-public-mdm-host.example`;
  const mdmPayload = commonPayload("com.apple.mdm", "Sentinel MDM", "mdm", {
    AccessRights: mdm.accessRights || DEFAULT_ACCESS_RIGHTS,
    CheckInURL: `${baseUrl}/mdm/checkin?token=${encodeURIComponent(mdm.enrollmentSecret || "")}`,
    CheckOutWhenRemoved: mdm.checkOutWhenRemoved !== false,
    ServerURL: `${baseUrl}/mdm/connect?token=${encodeURIComponent(mdm.enrollmentSecret || "")}`,
    SignMessage: Boolean(mdm.signMessage),
    Topic: mdm.topic || "com.apple.mgmt.replace-with-apns-topic",
    UseDevelopmentAPNS: Boolean(mdm.useDevelopmentApns)
  });

  if (mdm.identityCertificateUuid && mdm.identityCertificatePayloadBase64) {
    mdmPayload.IdentityCertificateUUID = mdm.identityCertificateUuid;
  }

  const payloads: UnknownRecord[] = [];
  if (mdm.identityCertificatePayloadBase64 && mdm.identityCertificateUuid) {
    payloads.push(commonPayload("com.apple.security.pkcs12", "Sentinel MDM Identity", "identity", {
      PayloadUUID: mdm.identityCertificateUuid,
      PayloadContent: plistData(mdm.identityCertificatePayloadBase64),
      Password: mdm.identityCertificatePassword || ""
    }));
  }
  payloads.push(mdmPayload);

  return toPlist({
    PayloadContent: payloads,
    PayloadDescription: "Enrolls this supervised iPhone with the Sentinel MDM server for desktop-managed app and web restrictions.",
    PayloadDisplayName: "Sentinel iPhone MDM",
    PayloadIdentifier: MDM_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: true,
    PayloadType: "Configuration",
    PayloadUUID: randomUUID(),
    PayloadVersion: 1
  });
}

export function authorizeIosMdmRequest(state: SentinelState, url: URL): boolean {
  const mdm = currentIosMdmSettings(state);
  const token = url.searchParams.get("token") || "";
  return Boolean(mdm.enrollmentSecret && token && token === mdm.enrollmentSecret);
}

export function handleIosMdmCheckIn(state: SentinelState, requestBody: MdmMessage, now = new Date()) {
  const mdm = ensureMdmState(state);
  const messageType = String(requestBody.MessageType || requestBody.messageType || "Unknown");
  const device = upsertMdmDevice(mdm, requestBody, now);
  device.lastMessageType = messageType;
  device.lastSeenAt = now.toISOString();
  mdm.lastCheckInAt = now.toISOString();

  if (messageType === "TokenUpdate") {
    device.status = "enrolled";
    device.pushMagic = String(requestBody.PushMagic || device.pushMagic || "");
    device.topic = String(requestBody.Topic || device.topic || "");
    device.token = dataString(requestBody.Token) || device.token || "";
    device.tokenHex = dataHex(requestBody.Token) || tokenHexFromStoredToken(device.token) || device.tokenHex || "";
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

  trimCommands(ensureMdmState(state));
  return {
    ok: true,
    empty: true,
    messageType,
    udid: device.udid
  };
}

export function handleIosMdmConnect(state: SentinelState, requestBody: MdmMessage, now = new Date()) {
  const mdm = ensureMdmState(state);
  const device = upsertMdmDevice(mdm, requestBody, now);
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

export function queueIosMdmPolicyRefresh(state: SentinelState, reason = "policy-refresh", now = new Date(), options: PushOptions = {}) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { queued: 0, reason: "disabled" };
  const policyHash = iosPolicyHash(state, now);
  const profile = queueIosMdmPolicyCommand(state, reason, now, options, policyHash);
  const grayscale = queueIosMdmGrayscaleCommand(state, reason, now, options, iosGrayscaleHash(state, now), { force: true });
  return combinedQueueResult(profile, grayscale);
}

export async function pushIosMdmQueuedCommands(state: SentinelState, reason = "queued-policy", now = new Date(), options: PushOptions = {}) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { ok: false, pushed: 0, skipped: "disabled" };

  const devices = devicesWithQueuedCommands(mdm, now, options);
  if (!devices.length) return { ok: true, pushed: 0, skipped: "no-queued-devices" };

  const blockers = [...iosMdmReadinessBlockers(mdm), ...iosMdmPushBlockers(mdm)];
  if (blockers.length) {
    const result = { ok: false, pushed: 0, skipped: "not-ready", blockers };
    markDevicesPushSkipped(mdm, devices, now, result);
    recordPushSummary(mdm, result, now);
    return result;
  }

  const results: Array<{ udid: string; ok: boolean; statusCode: number; apnsId: string; error: string }> = [];
  for (const device of devices) {
    const result = await sendMdmPush(mdm, device);
    device.lastPushAt = now.toISOString();
    device.lastPushStatus = result.ok ? "sent" : "error";
    device.lastPushError = result.ok ? "" : result.error;
    for (const command of queuedCommandsForDevice(mdm, device.udid)) {
      command.lastPushAt = now.toISOString();
      command.lastPushStatus = device.lastPushStatus;
      command.lastPushError = device.lastPushError;
    }
    results.push({
      udid: device.udid,
      ok: result.ok,
      statusCode: result.statusCode || 0,
      apnsId: result.apnsId || "",
      error: result.error || ""
    });
  }

  const pushed = results.filter((result) => result.ok).length;
  const summary = {
    ok: pushed === results.length,
    pushed,
    failed: results.length - pushed,
    reason,
    results: results.map((result) => ({
      ...result,
      udid: obscure(result.udid)
    }))
  };
  recordPushSummary(mdm, summary, now);
  return summary;
}

export function buildIosMdmPushRequest(mdm: MdmSettings, device: MdmDevice): MdmPushRequest {
  const tokenHex = tokenHexFromDevice(device);
  if (!tokenHex) throw new Error("Missing APNs device token from MDM TokenUpdate.");
  if (!device.pushMagic) throw new Error("Missing PushMagic from MDM TokenUpdate.");
  if (!mdm.topic) throw new Error("Missing APNs MDM topic.");
  return {
    endpoint: mdm.useDevelopmentApns ? "https://api.development.push.apple.com" : "https://api.push.apple.com",
    path: `/3/device/${tokenHex}`,
    headers: {
      ":method": "POST",
      ":path": `/3/device/${tokenHex}`,
      "apns-topic": mdm.topic,
      "apns-push-type": "mdm",
      "apns-priority": "10",
      "content-type": "application/json"
    },
    payload: JSON.stringify({ mdm: device.pushMagic })
  };
}

export function maybeQueueIosMdmPolicyRefresh(state: SentinelState, reason = "policy-refresh", now = new Date()) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { queued: 0, reason: "disabled" };
  const policyHash = iosPolicyHash(state, now);
  const profile = mdm.lastPolicyHash === policyHash
    ? { queued: 0, unchanged: true, policyHash }
    : queueIosMdmPolicyCommand(state, reason, now, {}, policyHash);
  const grayscaleHash = iosGrayscaleHash(state, now);
  const grayscale = mdm.lastGrayscaleHash === grayscaleHash
    ? { queued: 0, unchanged: true, grayscaleHash }
    : queueIosMdmGrayscaleCommand(state, reason, now, {}, grayscaleHash);
  return combinedQueueResult(profile, grayscale);
}

function queueIosMdmPolicyCommand(state: SentinelState, reason: string, now: Date, options: PushOptions, policyHash: string) {
  const mdm = ensureMdmState(state);
  const allowedUdids = options.udids ? new Set(options.udids) : null;
  const commandTemplate = policyCommandTemplate(state, now);
  const devices = normalizeMdmDevices(mdm.devices)
    .filter((device) => device.status !== "checked-out")
    .filter((device) => !allowedUdids || allowedUdids.has(device.udid));

  let queued = 0;
  for (const device of devices) {
    cancelQueuedPolicyCommands(mdm, device.udid, policyHash, now);
    const duplicate = mdm.commands.some((command) => (
      command.udid === device.udid
      && isPolicyCommand(command)
      && ["queued", "sent"].includes(command.status)
      && command.policyHash === policyHash
    ));
    if (duplicate) continue;
    mdm.commands.unshift({
      id: randomUUID(),
      commandUuid: randomUUID(),
      udid: device.udid,
      ...commandTemplate,
      reason,
      status: "queued",
      queuedAt: now.toISOString(),
      sentAt: null,
      completedAt: null,
      attempts: 0,
      policyHash
    });
    queued += 1;
  }

  mdm.lastPolicyHash = policyHash;
  if (queued) mdm.lastCommandQueuedAt = now.toISOString();
  trimCommands(mdm);
  return { queued, deviceCount: devices.length, policyHash };
}

function queueIosMdmGrayscaleCommand(
  state: SentinelState,
  reason: string,
  now: Date,
  options: PushOptions,
  grayscaleHash: string,
  queueOptions: { force?: boolean } = {}
) {
  const mdm = ensureMdmState(state);
  const desired = grayscaleDecision(state, now, { device: "phone" });
  const allowedUdids = options.udids ? new Set(options.udids) : null;
  const devices = normalizeMdmDevices(mdm.devices)
    .filter((device) => device.status !== "checked-out")
    .filter((device) => !allowedUdids || allowedUdids.has(device.udid));

  let queued = 0;
  for (const device of devices) {
    cancelQueuedGrayscaleCommands(mdm, device.udid, grayscaleHash, now);
    const duplicate = mdm.commands.some((command) => (
      command.udid === device.udid
      && isGrayscaleSettingsCommand(command)
      && ["queued", "sent"].includes(command.status)
      && command.grayscaleHash === grayscaleHash
    ));
    if (duplicate) continue;
    if (!queueOptions.force && mdm.lastGrayscaleHash === grayscaleHash) continue;
    mdm.commands.unshift({
      id: randomUUID(),
      commandUuid: randomUUID(),
      udid: device.udid,
      requestType: "Settings",
      command: buildIosGrayscaleSettingsCommand(desired.desired),
      reason,
      status: "queued",
      queuedAt: now.toISOString(),
      sentAt: null,
      completedAt: null,
      attempts: 0,
      grayscaleDesired: desired.desired,
      grayscaleHash
    });
    queued += 1;
  }

  mdm.lastGrayscaleHash = grayscaleHash;
  if (queued) {
    mdm.lastCommandQueuedAt = now.toISOString();
    mdm.lastGrayscaleCommandQueuedAt = now.toISOString();
  }
  trimCommands(mdm);
  return { queued, deviceCount: devices.length, grayscaleHash, grayscaleDesired: desired.desired };
}

export function buildIosGrayscaleSettingsCommand(enabled: boolean): UnknownRecord {
  return {
    RequestType: "Settings",
    Settings: [
      {
        Item: "AccessibilitySettings",
        GrayscaleEnabled: Boolean(enabled)
      }
    ]
  };
}

function policyCommandTemplate(state: SentinelState, now: Date): Pick<MdmCommand, "requestType"> & UnknownRecord {
  if (!state.deviceControls?.ios?.enabled) {
    return {
      requestType: "RemoveProfile",
      profileIdentifier: IOS_PROFILE_IDENTIFIER
    };
  }

  const profile = buildIosConfigurationProfile(state, now);
  return {
    requestType: "InstallProfile",
    profileBase64: Buffer.from(profile, "utf8").toString("base64")
  };
}

function cancelQueuedPolicyCommands(mdm: MdmSettings, udid: string, policyHash: string, now: Date): void {
  for (const command of mdm.commands) {
    if (
      command.udid === udid
      && isPolicyCommand(command)
      && command.status === "queued"
      && command.policyHash !== policyHash
    ) {
      command.status = "cancelled";
      command.completedAt = now.toISOString();
    }
  }
}

function cancelQueuedGrayscaleCommands(mdm: MdmSettings, udid: string, grayscaleHash: string, now: Date): void {
  for (const command of mdm.commands) {
    if (
      command.udid === udid
      && isGrayscaleSettingsCommand(command)
      && command.status === "queued"
      && command.grayscaleHash !== grayscaleHash
    ) {
      command.status = "cancelled";
      command.completedAt = now.toISOString();
    }
  }
}

function isPolicyCommand(command: MdmCommand | null | undefined): boolean {
  return ["InstallProfile", "RemoveProfile"].includes(command?.requestType || "");
}

function isGrayscaleSettingsCommand(command: MdmCommand | null | undefined): boolean {
  return command?.requestType === "Settings" && typeof command.grayscaleHash === "string" && command.grayscaleHash.length > 0;
}

export function queueIosMdmInventory(state: SentinelState, udid: string, reason = "inventory", now = new Date()) {
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

function currentIosMdmSettings(state: SentinelState): MdmSettings {
  const current = state.deviceControls?.ios?.mdm || {};
  return normalizeIosMdmSettings(current as unknown as UnknownRecord, current);
}

function iosPolicyHash(state: SentinelState, now: Date): string {
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

function iosGrayscaleHash(state: SentinelState, now: Date): string {
  const desired = grayscaleDecision(state, now, { device: "phone" });
  return createHash("sha256").update(JSON.stringify({
    desired: desired.desired
  })).digest("hex");
}

function ensureMdmState(state: SentinelState): MdmSettings {
  const current = state.deviceControls.ios.mdm || {};
  state.deviceControls.ios.mdm = normalizeIosMdmSettings(current as unknown as UnknownRecord, current);
  return state.deviceControls.ios.mdm as unknown as MdmSettings;
}

function iosMdmReadinessBlockers(mdm: MdmSettings): string[] {
  const blockers: string[] = [];
  if (!mdm.publicBaseUrl) {
    blockers.push("Set a public HTTPS URL that forwards to this local server.");
  } else if (!mdm.publicBaseUrl.startsWith("https://")) {
    blockers.push("Apple MDM ServerURL and CheckInURL must use HTTPS.");
  }
  if (!/^com\.apple\.mgmt\.[A-Za-z0-9.-]+$/.test(mdm.topic || "")) {
    blockers.push("Set the APNs MDM topic from your Apple MDM push certificate.");
  }
  if (!mdm.identityCertificateUuid) {
    blockers.push("Set the UUID of the device identity certificate payload used by the MDM profile.");
  } else if (!mdm.identityCertificatePayloadBase64) {
    blockers.push("Paste the PKCS#12 identity certificate payload so the MDM profile can include the referenced UUID.");
  }
  return blockers;
}

function iosMdmPushBlockers(mdm: Partial<MdmSettings> = {}): string[] {
  const blockers: string[] = [];
  if (!mdm.pushCertificatePayloadBase64) {
    blockers.push("Paste the APNs MDM push certificate PKCS#12 so queued commands can wake enrolled iPhones.");
  }
  return blockers;
}

function mdmNote(enabled: boolean, ready: boolean, enrollmentReady: boolean, blockers: string[]): string {
  if (!enabled) return "MDM server mode is off; static supervised profiles are still available.";
  if (ready) return "MDM enrollment profile and command endpoints are configured.";
  if (enrollmentReady) return blockers[0] || "Enrollment is configured, but wireless MDM wakeups are not ready.";
  return blockers[0] || "Finish MDM setup before enrolling an iPhone.";
}

function combinedQueueResult(
  profile: UnknownRecord & { queued?: number; policyHash?: string; unchanged?: boolean },
  grayscale: UnknownRecord & { queued?: number; grayscaleHash?: string; grayscaleDesired?: boolean; unchanged?: boolean }
) {
  return {
    queued: Number(profile.queued || 0) + Number(grayscale.queued || 0),
    profileQueued: Number(profile.queued || 0),
    grayscaleQueued: Number(grayscale.queued || 0),
    profileUnchanged: Boolean(profile.unchanged),
    grayscaleUnchanged: Boolean(grayscale.unchanged),
    policyHash: String(profile.policyHash || ""),
    grayscaleHash: String(grayscale.grayscaleHash || ""),
    grayscaleDesired: Boolean(grayscale.grayscaleDesired)
  };
}

function buildQueuedCommandPayload(command: MdmCommand): UnknownRecord {
  if (command.requestType === "InstallProfile") {
    return {
      CommandUUID: command.commandUuid,
      Command: {
        RequestType: "InstallProfile",
        Payload: plistData(command.profileBase64)
      }
    };
  }

  if (command.requestType === "RemoveProfile") {
    return {
      CommandUUID: command.commandUuid,
      Command: {
        RequestType: "RemoveProfile",
        Identifier: command.profileIdentifier || IOS_PROFILE_IDENTIFIER
      }
    };
  }

  return {
    CommandUUID: command.commandUuid,
    Command: command.command || { RequestType: command.requestType }
  };
}

function nextCommandForDevice(mdm: MdmSettings, udid: string, now: Date): MdmCommand | null {
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

function devicesWithQueuedCommands(mdm: MdmSettings, now: Date, options: PushOptions = {}): MdmDevice[] {
  const allowedUdids = options.udids ? new Set(options.udids) : null;
  return (mdm.devices || [])
    .filter((device) => device.status !== "checked-out")
    .filter((device) => !allowedUdids || allowedUdids.has(device.udid))
    .filter((device) => queuedCommandsForDevice(mdm, device.udid).length)
    .filter((device) => {
      if (options.force) return true;
      const lastPush = device.lastPushAt ? new Date(device.lastPushAt).getTime() : 0;
      return !lastPush || now.getTime() - lastPush >= PUSH_COOLDOWN_MS;
    });
}

function queuedCommandsForDevice(mdm: MdmSettings, udid: string): MdmCommand[] {
  return (mdm.commands || []).filter((command) => (
    command.udid === udid
    && command.status === "queued"
  ));
}

async function sendMdmPush(mdm: MdmSettings, device: MdmDevice): Promise<ApnsResult> {
  try {
    const request = buildIosMdmPushRequest(mdm, device);
    const pfx = Buffer.from(mdm.pushCertificatePayloadBase64, "base64");
    return sendApnsRequest(request, {
      pfx,
      passphrase: mdm.pushCertificatePassword || undefined
    });
  } catch (error) {
    return { ok: false, error: simplifyPushError(error) };
  }
}

function sendApnsRequest(pushRequest: MdmPushRequest, tlsOptions: ApnsTlsOptions): Promise<ApnsResult> {
  return new Promise<ApnsResult>((resolve) => {
    let settled = false;
    let client: ClientHttp2Session | null = null;
    let request: (ClientHttp2Stream & { responseHeaders?: IncomingHttpHeaders }) | null = null;
    const chunks: string[] = [];
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        request?.close();
      } catch {
        // Ignore close errors on already-finished streams.
      }
      try {
        client?.close();
      } catch {
        // Ignore close errors on already-finished sessions.
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "APNs request timed out." });
    }, APNS_TIMEOUT_MS);

    try {
      client = http2.connect(pushRequest.endpoint, tlsOptions);
      client.on("error", (error) => finish({ ok: false, error: simplifyPushError(error) }));
      request = client.request(pushRequest.headers);
      const currentRequest = request;
      currentRequest.setEncoding("utf8");
      currentRequest.on("response", (headers: IncomingHttpHeaders) => {
        currentRequest.responseHeaders = headers;
      });
      currentRequest.on("data", (chunk: string) => chunks.push(chunk));
      currentRequest.on("error", (error) => finish({ ok: false, error: simplifyPushError(error) }));
      currentRequest.on("end", () => {
        const headers = currentRequest.responseHeaders || {};
        const statusCode = Number(headers[":status"] || 0);
        const body = chunks.join("");
        const apnsId = String(headers["apns-id"] || "");
        finish({
          ok: statusCode >= 200 && statusCode < 300,
          statusCode,
          apnsId,
          body,
          error: statusCode >= 200 && statusCode < 300 ? "" : apnsError(body, statusCode)
        });
      });
      currentRequest.end(pushRequest.payload);
    } catch (error) {
      finish({ ok: false, error: simplifyPushError(error) });
    }
  });
}

function recordPushSummary(mdm: MdmSettings, summary: PushSummary, now: Date): void {
  mdm.lastPushAt = now.toISOString();
  mdm.lastPushStatus = summary.ok ? "sent" : (summary.skipped || "error");
  mdm.lastPushError = summary.ok ? "" : (summary.blockers?.[0] || summary.error || summary.skipped || "");
}

function markDevicesPushSkipped(mdm: MdmSettings, devices: MdmDevice[], now: Date, summary: PushSummary): void {
  const error = summary.blockers?.[0] || summary.skipped || "";
  for (const device of devices) {
    device.lastPushAt = now.toISOString();
    device.lastPushStatus = summary.skipped || "skipped";
    device.lastPushError = error;
    for (const command of queuedCommandsForDevice(mdm, device.udid)) {
      command.lastPushAt = now.toISOString();
      command.lastPushStatus = device.lastPushStatus;
      command.lastPushError = error;
    }
  }
}

function recordMdmCommandResult(mdm: MdmSettings, device: MdmDevice, requestBody: MdmMessage, status: string, now: Date): void {
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

function summarizeMdmResult(body: MdmMessage): { keys: string[]; error: string } {
  const keys = Object.keys(body || {}).filter((key) => !["UDID", "CommandUUID", "Status"].includes(key));
  return {
    keys,
    error: Array.isArray(body.ErrorChain) ? String(body.ErrorChain[0]?.USEnglishDescription || body.ErrorChain[0]?.LocalizedDescription || "") : ""
  };
}

function upsertMdmDevice(mdm: MdmSettings, message: MdmMessage, now: Date): MdmDevice {
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

function cancelQueuedCommandsForDevice(mdm: MdmSettings, udid: string): void {
  for (const command of mdm.commands) {
    if (command.udid === udid && ["queued", "sent"].includes(command.status)) {
      command.status = "cancelled";
      command.completedAt = new Date().toISOString();
    }
  }
}

function trimCommands(mdm: MdmSettings): void {
  mdm.commands = normalizeMdmCommands(mdm.commands).slice(0, MAX_COMMANDS);
}

function commonPayload(type: string, name: string, suffix: string, values: UnknownRecord = {}): MdmPayload {
  return {
    ...values,
    PayloadDescription: `${name} generated by ${APP_NAME}.`,
    PayloadDisplayName: name,
    PayloadIdentifier: `${MDM_PROFILE_IDENTIFIER}.${suffix}`,
    PayloadType: type,
    PayloadUUID: String(values.PayloadUUID || randomUUID()),
    PayloadVersion: 1
  };
}

function publicMdmDevice(device: MdmDevice) {
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

function publicMdmCommand(command: MdmCommand) {
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
    grayscaleDesired: command.grayscaleDesired ?? null,
    error: command.errorChain?.[0]?.USEnglishDescription || command.resultSummary?.error || ""
  };
}

function fullMdmUrl(mdm: MdmSettings, path: string): string {
  const base = mdm.publicBaseUrl || `http://127.0.0.1:${PORT}`;
  return `${base}${path}?token=${encodeURIComponent(mdm.enrollmentSecret || "")}`;
}

function enrollmentPath(mdm: MdmSettings): string {
  return `/mdm/enroll.mobileconfig?token=${encodeURIComponent(mdm.enrollmentSecret || "")}`;
}

function normalizeMdmDevices(values: unknown): MdmDevice[] {
  return Array.isArray(values)
    ? values
      .filter(isUnknownRecord)
      .map((device) => normalizeMdmDevice(device))
    : [];
}

function normalizeMdmCommands(values: unknown): MdmCommand[] {
  return Array.isArray(values)
    ? values
      .filter(isUnknownRecord)
      .map((command) => normalizeMdmCommand(command))
    : [];
}

function normalizeMdmDevice(value: UnknownRecord): MdmDevice {
  const device = value as UnknownRecord;
  return {
    ...device,
    id: String(device.id || randomUUID()),
    udid: String(device.udid || "unknown-device"),
    status: String(device.status || "enrolled")
  };
}

function normalizeMdmCommand(value: UnknownRecord): MdmCommand {
  const command = value as UnknownRecord;
  const nestedCommand = command.command && typeof command.command === "object" ? command.command as UnknownRecord : {};
  const requestType = String(command.requestType || command.RequestType || nestedCommand.RequestType || "Unknown");
  return {
    ...command,
    id: String(command.id || randomUUID()),
    commandUuid: String(command.commandUuid || command.CommandUUID || randomUUID()),
    udid: String(command.udid || command.UDID || ""),
    requestType,
    status: String(command.status || "queued")
  };
}

function normalizeBaseUrl(value: unknown): string {
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

function normalizeUuid(value: unknown): string {
  const raw = String(value || "").trim();
  return /^[0-9A-Fa-f-]{32,36}$/.test(raw) ? raw.toUpperCase() : raw;
}

function normalizeBase64(value: unknown): string {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeStatus(value: unknown): string {
  return String(value || "Idle")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function latestDate(values: unknown[]): string | null {
  const times = values
    .map((value) => value ? new Date(String(value)).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function dataString(value: unknown): string {
  if (!value) return "";
  if (isPlistDataRecord(value)) return value.__plistData;
  return String(value || "");
}

function dataHex(value: unknown): string {
  if (!value) return "";
  if (isPlistDataRecord(value)) return bufferFromBase64(value.__plistData).toString("hex");
  const text = String(value || "").trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return text.toLowerCase();
  return bufferFromBase64(text).toString("hex");
}

function tokenHexFromDevice(device: Partial<MdmDevice> = {}): string {
  return normalizeTokenHex(device.tokenHex) || tokenHexFromStoredToken(device.token);
}

function tokenHexFromStoredToken(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return normalizeTokenHex(text) || bufferFromBase64(text).toString("hex");
}

function normalizeTokenHex(value: unknown): string {
  const text = String(value || "").trim();
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) return "";
  return text.toLowerCase();
}

function bufferFromBase64(value: unknown): Buffer {
  try {
    return Buffer.from(String(value || "").replace(/\s+/g, ""), "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function apnsError(body: string, statusCode: number): string {
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    const record = isUnknownRecord(parsed) ? parsed : {};
    if (record.reason) return `APNs ${statusCode}: ${String(record.reason)}`;
  } catch {
    // Fall through to generic APNs error.
  }
  return `APNs request failed with status ${statusCode || "unknown"}.`;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function simplifyPushError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "APNs push failed.");
}

function obscure(value: unknown): string {
  const text = String(value || "");
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function randomSecret(): string {
  return randomBytes(24).toString("base64url");
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function isPlistDataRecord(value: unknown): value is PlistDataValue {
  return Boolean(value && typeof value === "object" && typeof (value as PlistDataValue).__plistData === "string");
}
