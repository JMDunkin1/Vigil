import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http2 from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { APP_NAME, defaultState } from "./defaults.js";
import { buildIosConfigurationProfile, IOS_PROFILE_IDENTIFIER, iosPolicyTargets } from "./iosProfiles.js";
import { parseBoolean } from "./booleans.js";
import { grayscaleDecision } from "./grayscale.js";
import { clampInteger } from "./normalizers.js";
import { plistData, toPlist } from "./plist.js";
import { activePolicy } from "./policy.js";
import type { IosMdmSettings, VigilState, UnknownRecord } from "./types.js";
import type { MdmCommand, MdmDevice, MdmEnrollmentToken, MdmMessage, MdmPushRequest, MdmSettings } from "./iosMdmModel.js";
import { dataHex, dataString, isUnknownRecord, latestDate, normalizeBase64, normalizeBaseUrl, normalizeMdmCommands, normalizeMdmDevices, normalizeMdmEnrollmentTokens, normalizeStatus, normalizeUuid, obscure, publicMdmCommand, publicMdmDevice, randomSecret, tokenHexFromDevice, tokenHexFromStoredToken } from "./iosMdmModel.js";

const MDM_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios.mdm";
const DEFAULT_ACCESS_RIGHTS = 8179;
const MAX_COMMANDS = 500;
const MAX_MDM_DEVICES = 64;
const MAX_ENROLLMENT_TOKENS = 128;
const PENDING_ENROLLMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
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

export type IosMdmStatus = "off" | "setup-needed" | "queue-only" | "ready";
export type IosMdmCapabilityLevel = "static-profile" | "setup-needed" | "command-queue" | "wireless-push";
export type IosMdmDoctorArea = "server" | "identity" | "apns" | "enrollment" | "apple";
export type IosMdmDoctorSeverity = "blocking" | "warning" | "info";

export interface IosMdmDoctorItem {
  code: string;
  area: IosMdmDoctorArea;
  severity: IosMdmDoctorSeverity;
  message: string;
  detail: string;
  fix: string;
  env?: string[];
}

export interface IosMdmReadiness {
  enabled: boolean;
  enrollmentReady: boolean;
  ready: boolean;
  status: IosMdmStatus;
  capabilityLevel: IosMdmCapabilityLevel;
  setupBlockers: string[];
  pushBlockers: string[];
  blockers: string[];
  diagnostics: IosMdmDoctorItem[];
  warnings: IosMdmDoctorItem[];
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
    enrollmentTokens: normalizeMdmEnrollmentTokens(current.enrollmentTokens),
    devices: normalizeMdmDevices(current.devices).slice(0, MAX_MDM_DEVICES),
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
    enrollmentTokens,
    devices,
    commands,
    ...rest
  } = mdm || {};
  const readiness = iosMdmReadiness(mdm);
  return {
    ...rest,
    ready: readiness.ready,
    enrollmentReady: readiness.enrollmentReady,
    status: readiness.status,
    capabilityLevel: readiness.capabilityLevel,
    blockers: readiness.blockers,
    setupBlockers: readiness.setupBlockers,
    pushBlockers: readiness.pushBlockers,
    warnings: readiness.warnings.map(publicDoctorItem),
    enrollmentSecretSet: Boolean(enrollmentSecret),
    identityCertificatePayloadSet: Boolean(identityCertificatePayloadBase64),
    identityCertificatePasswordSet: Boolean(identityCertificatePassword),
    pushCertificatePayloadSet: Boolean(pushCertificatePayloadBase64),
    pushCertificatePasswordSet: Boolean(pushCertificatePassword),
    enrolledDeviceCount: normalizeMdmDevices(devices).filter((device) => device.status !== "checked-out").length,
    pendingCommandCount: normalizeMdmCommands(commands).filter((command) => command.status === "queued").length
  };
}

export function iosMdmDeviceUsageCredential(
  state: VigilState,
  identifier: string
): { deviceId: string; token: string } | null {
  const mdm = ensureMdmState(state);
  const device = normalizeMdmDevices(mdm.devices).find((candidate) => (
    candidate.status !== "checked-out"
    && (candidate.id === identifier || candidate.udid === identifier)
  ));
  const secret = String(mdm.enrollmentSecret || "");
  if (!device || !secret) return null;
  return {
    deviceId: device.udid,
    token: createHmac("sha256", secret).update(`usage:${device.udid}`).digest("base64url")
  };
}

export function iosMdmDeviceUsageTokens(state: VigilState): Record<string, string> {
  const mdm = ensureMdmState(state);
  return Object.fromEntries(normalizeMdmDevices(mdm.devices)
    .filter((device) => device.status !== "checked-out")
    .map((device) => {
      const credential = iosMdmDeviceUsageCredential(state, device.udid);
      return credential ? [credential.deviceId, credential.token] : [];
    })
    .filter((entry): entry is [string, string] => entry.length === 2));
}

export function iosMdmReadiness(mdm: Partial<IosMdmSettings> | Partial<MdmSettings> = {}): IosMdmReadiness {
  const settings = { ...defaultState().deviceControls.ios.mdm, ...mdm } as MdmSettings;
  const setupDiagnostics = iosMdmSetupDiagnostics(settings);
  const pushDiagnostics = setupDiagnostics.some((item) => item.severity === "blocking") ? [] : iosMdmPushDiagnostics(settings);
  const diagnostics = [...setupDiagnostics, ...pushDiagnostics];
  const blockingDiagnostics = diagnostics.filter((item) => item.severity === "blocking");
  const setupBlockers = setupDiagnostics.filter((item) => item.severity === "blocking").map((item) => item.message);
  const pushBlockers = pushDiagnostics.filter((item) => item.severity === "blocking").map((item) => item.message);
  const blockers = blockingDiagnostics.map((item) => item.message);
  const warnings = diagnostics.filter((item) => item.severity === "warning");
  const enabled = Boolean(settings.enabled);
  const enrollmentReady = enabled && setupBlockers.length === 0;
  const ready = enabled && blockers.length === 0;
  const status: IosMdmStatus = !enabled ? "off" : (ready ? "ready" : (enrollmentReady ? "queue-only" : "setup-needed"));
  const capabilityLevel: IosMdmCapabilityLevel = !enabled
    ? "static-profile"
    : ready
      ? "wireless-push"
      : enrollmentReady
        ? "command-queue"
        : "setup-needed";
  return {
    enabled,
    enrollmentReady,
    ready,
    status,
    capabilityLevel,
    setupBlockers,
    pushBlockers,
    blockers,
    diagnostics: blockingDiagnostics.map(publicDoctorItem),
    warnings: warnings.map(publicDoctorItem)
  };
}

export function iosMdmDoctor(state: VigilState, now = new Date()) {
  const mdm = ensureMdmState(state);
  const readiness = iosMdmReadiness(mdm);
  const devices = normalizeMdmDevices(mdm.devices);
  const enrolled = devices.filter((device) => device.status !== "checked-out");
  const pending = normalizeMdmCommands(mdm.commands).filter((command) => command.status === "queued");
  const doctorDiagnostics = [...iosMdmSetupDiagnostics(mdm), ...iosMdmPushDiagnostics(mdm)];
  const doctorBlockers = doctorDiagnostics.filter((item) => item.severity === "blocking").map(publicDoctorItem);
  const doctorWarnings = doctorDiagnostics.filter((item) => item.severity === "warning").map(publicDoctorItem);
  const externalPrerequisites = iosMdmExternalPrerequisites();
  const nextSteps = iosMdmNextSteps(readiness, enrolled.length);

  return {
    generatedAt: now.toISOString(),
    normalDeliveryPath: {
      provider: "manageengine",
      exportCommand: "npm run ios:manageengine:export",
      policyPath: "data/manageengine/vigil-manageengine-policy.mobileconfig",
      note: "ManageEngine is the normal free iPhone MDM delivery path; this doctor only covers advanced self-hosted Vigil MDM."
    },
    status: readiness.status,
    capabilityLevel: readiness.capabilityLevel,
    ready: readiness.ready,
    enrollmentReady: readiness.enrollmentReady,
    staticProfile: {
      status: state.deviceControls?.ios?.status || "",
      active: state.deviceControls?.ios?.status === "supervised-profile-ready",
      note: "Static supervised USB profile status is separate from advanced self-hosted wireless MDM enrollment."
    },
    remoteMdm: {
      enabled: readiness.enabled,
      publicBaseUrl: mdm.publicBaseUrl,
      topic: mdm.topic,
      enrollmentUrl: readiness.enrollmentReady ? "/api/devices/ios/mdm/enrollment.mobileconfig" : "",
      localEnrollmentPath: readiness.enrollmentReady ? "/api/devices/ios/mdm/enrollment.mobileconfig" : "",
      serverConfigured: readiness.enrollmentReady,
      enrolledDeviceCount: enrolled.length,
      pendingCommandCount: pending.length,
      identityCertificatePayloadSet: Boolean(mdm.identityCertificatePayloadBase64),
      pushCertificatePayloadSet: Boolean(mdm.pushCertificatePayloadBase64),
      identityCertificatePasswordSet: Boolean(mdm.identityCertificatePassword),
      pushCertificatePasswordSet: Boolean(mdm.pushCertificatePassword),
      lastEnrollmentProfileGeneratedAt: mdm.lastEnrollmentProfileGeneratedAt || null,
      lastCheckInAt: mdm.lastCheckInAt || null,
      lastPushAt: mdm.lastPushAt || null,
      lastPushStatus: mdm.lastPushStatus || "",
      lastPushError: mdm.lastPushError || ""
    },
    blockers: doctorBlockers,
    warnings: [
      ...doctorWarnings,
      doctorItem(
        "apple-credentials-not-locally-verifiable",
        "apple",
        "Vigil can check local shape, but cannot prove Apple MDM credentials until an iPhone enrolls and APNs accepts a push.",
        "The APNs MDM push certificate must come from Apple's Push Certificates Portal and match the configured com.apple.mgmt.* topic.",
        "Use real Apple-issued MDM APNs material; do not treat development identities or placeholder PKCS#12 files as sufficient.",
        [],
        "warning"
      )
    ].map(publicDoctorItem),
    nextSteps,
    externalPrerequisites
  };
}

export function iosMdmSummary(state: VigilState, now = new Date()) {
  const mdm = ensureMdmState(state);
  const devices = normalizeMdmDevices(mdm.devices);
  const commands = normalizeMdmCommands(mdm.commands);
  const readiness = iosMdmReadiness(mdm);
  const enrolled = devices.filter((device) => device.status !== "checked-out");
  const pending = commands.filter((command) => command.status === "queued");
  const sent = commands.filter((command) => command.status === "sent");
  const completed = commands.filter((command) => command.status === "acknowledged");
  const failed = commands.filter((command) => ["error", "command-format-error"].includes(command.status));
  const grayscale = grayscaleDecision(state, now, { device: "phone" });

  return {
    enabled: readiness.enabled,
    ready: readiness.ready,
    enrollmentReady: readiness.enrollmentReady,
    status: readiness.status,
    capabilityLevel: readiness.capabilityLevel,
    note: mdmNote(readiness.enabled, readiness.ready, readiness.enrollmentReady, readiness.blockers),
    publicBaseUrl: mdm.publicBaseUrl,
    topic: mdm.topic,
    identityCertificateUuid: mdm.identityCertificateUuid,
    accessRights: mdm.accessRights,
    signMessage: Boolean(mdm.signMessage),
    useDevelopmentApns: Boolean(mdm.useDevelopmentApns),
    checkOutWhenRemoved: mdm.checkOutWhenRemoved !== false,
    localEnrollmentPath: readiness.enrollmentReady ? "/api/devices/ios/mdm/enrollment.mobileconfig" : "",
    enrollmentUrl: readiness.enrollmentReady ? "/api/devices/ios/mdm/enrollment.mobileconfig" : "",
    serverConfigured: readiness.enrollmentReady,
    pushSupported: readiness.ready,
    pushNote: readiness.ready
      ? "Advanced self-hosted APNs wakeups are configured; ManageEngine is still the normal free delivery path."
      : "ManageEngine owns APNs in the normal free path; self-hosted wakeups need a separate Apple MDM push certificate.",
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
    blockers: readiness.blockers,
    setupBlockers: readiness.setupBlockers,
    pushBlockers: readiness.pushBlockers,
    devices: devices.map(publicMdmDevice),
    commands: commands.slice(0, 12).map(publicMdmCommand),
    generatedAt: now.toISOString()
  };
}

export function markIosMdmEnrollmentGenerated(state: VigilState, at = new Date()): void {
  const mdm = ensureMdmState(state);
  mdm.lastEnrollmentProfileGeneratedAt = at.toISOString();
}

export function iosMdmEnrollmentReadiness(state: VigilState): IosMdmReadiness {
  return iosMdmReadiness(ensureMdmState(state));
}

export function assertIosMdmEnrollmentReady(state: VigilState): void {
  const readiness = iosMdmEnrollmentReadiness(state);
  if (readiness.enrollmentReady) return;
  throw Object.assign(new Error("Self-hosted Vigil MDM enrollment is not ready."), {
    status: 409,
    blockers: readiness.setupBlockers
  });
}

export function buildIosMdmEnrollmentProfile(state: VigilState): string {
  assertIosMdmEnrollmentReady(state);
  const mdm = ensureMdmState(state);
  const baseUrl = mdm.publicBaseUrl;
  const deviceSecret = createEnrollmentToken(mdm);
  const mdmPayload = commonPayload("com.apple.mdm", "Vigil MDM", "mdm", {
    AccessRights: mdm.accessRights || DEFAULT_ACCESS_RIGHTS,
    CheckInURL: `${baseUrl}/mdm/checkin?token=${encodeURIComponent(deviceSecret)}`,
    CheckOutWhenRemoved: mdm.checkOutWhenRemoved !== false,
    ServerURL: `${baseUrl}/mdm/connect?token=${encodeURIComponent(deviceSecret)}`,
    SignMessage: Boolean(mdm.signMessage),
    Topic: mdm.topic,
    UseDevelopmentAPNS: Boolean(mdm.useDevelopmentApns)
  });

  if (mdm.identityCertificateUuid && mdm.identityCertificatePayloadBase64) {
    mdmPayload.IdentityCertificateUUID = mdm.identityCertificateUuid;
  }

  const payloads: UnknownRecord[] = [];
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
    PayloadDescription: "Enrolls this supervised iPhone with the advanced self-hosted Vigil MDM server for desktop-managed app and web restrictions.",
    PayloadDisplayName: "Vigil iPhone MDM",
    PayloadIdentifier: MDM_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: true,
    PayloadType: "Configuration",
    PayloadUUID: randomUUID(),
    PayloadVersion: 1
  });
}

export function authorizeIosMdmRequest(state: VigilState, url: URL, now = new Date()): boolean {
  const mdm = currentIosMdmSettings(state);
  const token = url.searchParams.get("token") || "";
  if (["/mdm/checkin", "/mdm/connect"].includes(url.pathname) && mdm.enrollmentTokens.length) {
    return Boolean(findEnrollmentToken(mdm, token, now));
  }
  return secretsEqual(String(mdm.enrollmentSecret || ""), token);
}

export function authorizeIosMdmDeviceRequest(state: VigilState, url: URL, requestBody: MdmMessage, now = new Date()): boolean {
  const mdm = ensureMdmState(state);
  const udid = mdmIdentifier(requestBody);
  if (!udid) return false;

  const suppliedToken = url.searchParams.get("token") || "";
  const enrollment = findEnrollmentToken(mdm, suppliedToken, now);
  if (enrollment) {
    if (enrollment.boundUdid && enrollment.boundUdid !== udid) return false;
    enrollment.boundUdid = udid;
    enrollment.lastSeenAt = now.toISOString();
    return true;
  }

  const isLegacyDevice = mdm.devices.some((device) => device.udid === udid && device.status !== "checked-out");
  if (mdm.devices.length) {
    return isLegacyDevice && secretsEqual(String(mdm.enrollmentSecret || ""), suppliedToken);
  }

  const isFirstEnrollmentMigration = mdm.enrollmentTokens.length === 0;
  return isFirstEnrollmentMigration && secretsEqual(String(mdm.enrollmentSecret || ""), suppliedToken);
}

export function handleIosMdmCheckIn(state: VigilState, requestBody: MdmMessage, now = new Date()) {
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

export function handleIosMdmConnect(state: VigilState, requestBody: MdmMessage, now = new Date()) {
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

export function queueIosMdmPolicyRefresh(state: VigilState, reason = "policy-refresh", now = new Date(), options: PushOptions = {}) {
  const mdm = ensureMdmState(state);
  if (!mdm.enabled) return { queued: 0, reason: "disabled" };
  const policyHash = iosPolicyHash(state, now);
  const profile = queueIosMdmPolicyCommand(state, reason, now, options, policyHash);
  const grayscale = queueIosMdmGrayscaleCommand(state, reason, now, options, iosGrayscaleHash(state, now), { force: true });
  return combinedQueueResult(profile, grayscale);
}

export async function pushIosMdmQueuedCommands(state: VigilState, reason = "queued-policy", now = new Date(), options: PushOptions = {}) {
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

export function iosMdmQueuedPushEligible(
  state: VigilState,
  now = new Date(),
  options: PushOptions = {}
): boolean {
  const mdm = currentIosMdmSettings(state);
  return Boolean(mdm.enabled && devicesWithQueuedCommands(mdm, now, options).length);
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

export function maybeQueueIosMdmPolicyRefresh(state: VigilState, reason = "policy-refresh", now = new Date()) {
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

function queueIosMdmPolicyCommand(state: VigilState, reason: string, now: Date, options: PushOptions, policyHash: string) {
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
  state: VigilState,
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

function policyCommandTemplate(state: VigilState, now: Date): Pick<MdmCommand, "requestType"> & UnknownRecord {
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

export function queueIosMdmInventory(state: VigilState, udid: string, reason = "inventory", now = new Date()) {
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

function currentIosMdmSettings(state: VigilState): MdmSettings {
  const current = state.deviceControls?.ios?.mdm || {};
  return normalizeIosMdmSettings(current as unknown as UnknownRecord, current);
}

function iosPolicyHash(state: VigilState, now: Date): string {
  const ios = state.deviceControls?.ios || {};
  const policy = activePolicy(state, now, { device: "phone" });
  const stablePolicy = {
    enabled: Boolean(ios.enabled),
    mode: ios.mode || "denylist",
    webMode: ios.webMode || "denylist",
    blockApps: ios.blockApps !== false,
    blockWeb: ios.blockWeb !== false,
    hardenRemoval: ios.hardenRemoval !== false,
    restrictInstallAndErase: ios.restrictInstallAndErase !== false,
    allowSafariHistoryClearing: ios.allowSafariHistoryClearing !== false,
    blockedAppBundleIds: ios.blockedAppBundleIds || [],
    allowedAppBundleIds: ios.allowedAppBundleIds || [],
    deniedUrls: ios.deniedUrls || [],
    allowedUrls: ios.allowedUrls || [],
    focusedSocial: ios.focusedSocial || null,
    removalPasswordSet: Boolean(ios.removalPassword),
    targets: iosPolicyTargets(state, now),
    policyBoundary: policy ? {
      endsAt: policy.endsAt,
      contributors: policy.contributors || []
    } : null
  };
  return createHash("sha256").update(JSON.stringify(stablePolicy)).digest("hex");
}

function iosGrayscaleHash(state: VigilState, now: Date): string {
  const desired = grayscaleDecision(state, now, { device: "phone" });
  return createHash("sha256").update(JSON.stringify({
    desired: desired.desired
  })).digest("hex");
}

function ensureMdmState(state: VigilState): MdmSettings {
  const current = state.deviceControls.ios.mdm || {};
  state.deviceControls.ios.mdm = normalizeIosMdmSettings(current as unknown as UnknownRecord, current);
  return state.deviceControls.ios.mdm as unknown as MdmSettings;
}

function iosMdmReadinessBlockers(mdm: MdmSettings): string[] {
  return iosMdmSetupDiagnostics(mdm).filter((item) => item.severity === "blocking").map((item) => item.message);
}

function iosMdmPushBlockers(mdm: Partial<MdmSettings> = {}): string[] {
  return iosMdmPushDiagnostics(mdm).filter((item) => item.severity === "blocking").map((item) => item.message);
}

function iosMdmSetupDiagnostics(mdm: Partial<MdmSettings> = {}): IosMdmDoctorItem[] {
  const blockers: IosMdmDoctorItem[] = [];
  if (!mdm.publicBaseUrl) {
    blockers.push(doctorItem(
      "missing-public-base-url",
      "server",
      "Set a public HTTPS URL that forwards to this local server.",
      "Self-hosted MDM enrollment profiles must contain a public HTTPS ServerURL and CheckInURL reachable by the iPhone.",
      "Set VIGIL_MDM_PUBLIC_BASE_URL or configure publicBaseUrl to an HTTPS tunnel/reverse proxy that routes /mdm/* to Vigil.",
      ["VIGIL_MDM_PUBLIC_BASE_URL"]
    ));
  } else if (!mdm.publicBaseUrl.startsWith("https://")) {
    blockers.push(doctorItem(
      "public-base-url-not-https",
      "server",
      "Apple MDM ServerURL and CheckInURL must use HTTPS.",
      "iOS will not accept a self-hosted MDM enrollment profile whose endpoints are plain HTTP.",
      "Use a public HTTPS URL with a valid certificate and route /mdm/* to the local Vigil server.",
      ["VIGIL_MDM_PUBLIC_BASE_URL"]
    ));
  } else if (isLocalMdmHost(mdm.publicBaseUrl)) {
    blockers.push(doctorItem(
      "public-base-url-localhost",
      "server",
      "Self-hosted MDM needs a public HTTPS URL, not localhost or a private loopback host.",
      "The iPhone must reach the self-hosted MDM server over the network after it leaves USB setup.",
      "Put Vigil behind a real HTTPS tunnel/reverse proxy and use that public URL.",
      ["VIGIL_MDM_PUBLIC_BASE_URL"]
    ));
  }
  if (!validMdmTopic(mdm.topic || "")) {
    blockers.push(doctorItem(
      "invalid-apns-topic",
      "apns",
      "Set the APNs MDM topic from your Apple MDM push certificate.",
      "The topic should look like com.apple.mgmt.<customer-or-vendor-id>; Apple development signing identities are not MDM push topics.",
      "Copy the topic associated with the Apple MDM APNs push certificate.",
      ["VIGIL_MDM_TOPIC"]
    ));
  }
  if (!mdm.identityCertificateUuid) {
    blockers.push(doctorItem(
      "missing-identity-certificate-uuid",
      "identity",
      "Set the UUID of the device identity certificate payload used by the MDM profile.",
      "The MDM payload references this UUID so iOS can attach the device identity payload during enrollment.",
      "Set VIGIL_MDM_IDENTITY_UUID to the PayloadUUID for the PKCS#12 identity payload.",
      ["VIGIL_MDM_IDENTITY_UUID"]
    ));
  }
  const identityStatus = certificatePayloadStatus(mdm.identityCertificatePayloadBase64 || "");
  if (!mdm.identityCertificatePayloadBase64) {
    blockers.push(doctorItem(
      "missing-identity-certificate-payload",
      "identity",
      "Paste the PKCS#12 identity certificate payload so the MDM profile can include the referenced UUID.",
      "A placeholder string is not enough; iOS needs a real identity payload or a real SCEP design that Vigil does not yet implement.",
      "Set VIGIL_MDM_IDENTITY_P12 to a real identity .p12 file.",
      ["VIGIL_MDM_IDENTITY_P12", "VIGIL_MDM_IDENTITY_P12_PASSWORD"]
    ));
  } else if (!identityStatus.ok) {
    blockers.push(doctorItem(
      "invalid-identity-certificate-payload",
      "identity",
      identityStatus.message,
      "Vigil only stores the base64 PKCS#12 bytes; fake text or malformed base64 will produce an enrollment profile that cannot work.",
      "Export a real identity certificate as PKCS#12 and pass it with VIGIL_MDM_IDENTITY_P12.",
      ["VIGIL_MDM_IDENTITY_P12", "VIGIL_MDM_IDENTITY_P12_PASSWORD"]
    ));
  }
  return blockers;
}

function iosMdmPushDiagnostics(mdm: Partial<MdmSettings> = {}): IosMdmDoctorItem[] {
  const blockers: IosMdmDoctorItem[] = [];
  if (!mdm.pushCertificatePayloadBase64) {
    blockers.push(doctorItem(
      "missing-push-certificate-payload",
      "apns",
      "Paste the APNs MDM push certificate PKCS#12 so queued commands can wake enrolled iPhones.",
      "Self-hosted MDM commands are delivered when APNs wakes the iPhone; a normal Apple Development certificate cannot do this.",
      "Create/download a real Apple MDM APNs push certificate, export it as .p12, and set VIGIL_MDM_PUSH_P12.",
      ["VIGIL_MDM_PUSH_P12", "VIGIL_MDM_PUSH_P12_PASSWORD"]
    ));
  } else {
    const pushStatus = certificatePayloadStatus(mdm.pushCertificatePayloadBase64);
    if (!pushStatus.ok) {
      blockers.push(doctorItem(
        "invalid-push-certificate-payload",
        "apns",
        pushStatus.message,
        "Vigil can only push through APNs with a real MDM push certificate exported as PKCS#12.",
        "Use the Apple Push Certificates Portal MDM certificate, not a development signing identity or placeholder string.",
        ["VIGIL_MDM_PUSH_P12", "VIGIL_MDM_PUSH_P12_PASSWORD"]
      ));
    }
  }
  return blockers;
}

function iosMdmExternalPrerequisites(): string[] {
  return [
    "Use ManageEngine for the normal free path; these prerequisites apply only when replacing it with a self-hosted Vigil MDM server.",
    "A supervised iPhone that will install the self-hosted MDM enrollment profile.",
    "A public HTTPS base URL with a valid TLS certificate routing /mdm/* to Vigil.",
    "An Apple MDM APNs push certificate from the Apple Push Certificates Portal, exported as PKCS#12.",
    "The APNs MDM topic from that push certificate, usually com.apple.mgmt.<id>.",
    "A real device identity PKCS#12 payload, or a future SCEP implementation; placeholder identity bytes are not sufficient.",
    "Manual installation or automated delivery of the generated enrollment mobileconfig to the supervised iPhone."
  ];
}

function iosMdmNextSteps(readiness: IosMdmReadiness, enrolledDeviceCount: number): string[] {
  if (!readiness.enabled) return ["Use `npm run ios:manageengine:export` and assign the generated profile in ManageEngine; enable this advanced server only if you are replacing ManageEngine."];
  if (readiness.blockers.length) return readiness.diagnostics.map((item) => item.fix);
  if (!enrolledDeviceCount) return ["Install the generated self-hosted MDM enrollment profile only for an advanced non-ManageEngine test."];
  return ["Queue a policy refresh for the advanced self-hosted path; ManageEngine assignment remains the normal free route."];
}

function certificatePayloadStatus(base64: string): { ok: boolean; message: string } {
  const normalized = normalizeBase64(base64);
  if (!normalized) return { ok: false, message: "Missing PKCS#12 certificate payload." };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return { ok: false, message: "Certificate payload must be standard base64-encoded PKCS#12 bytes." };
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.toString("base64") !== normalized) {
    return { ok: false, message: "Certificate payload must decode cleanly from base64." };
  }
  if (bytes.length < 128 || bytes[0] !== 0x30) {
    return { ok: false, message: "Certificate payload does not look like a DER PKCS#12 file." };
  }
  return { ok: true, message: "Certificate payload has a plausible PKCS#12 shape." };
}

function validMdmTopic(topic: string): boolean {
  return /^com\.apple\.mgmt\.[A-Za-z0-9.-]+$/.test(topic) && !/replace|example|placeholder/i.test(topic);
}

function isLocalMdmHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function doctorItem(
  code: string,
  area: IosMdmDoctorArea,
  message: string,
  detail: string,
  fix: string,
  env: string[] = [],
  severity: IosMdmDoctorSeverity = "blocking"
): IosMdmDoctorItem {
  return { code, area, severity, message, detail, fix, env };
}

function publicDoctorItem(item: IosMdmDoctorItem): IosMdmDoctorItem {
  return {
    code: item.code,
    area: item.area,
    severity: item.severity,
    message: item.message,
    detail: item.detail,
    fix: item.fix,
    ...(item.env?.length ? { env: item.env } : {})
  };
}

function mdmNote(enabled: boolean, ready: boolean, enrollmentReady: boolean, blockers: string[]): string {
  if (!enabled) return "ManageEngine is the normal free path; Vigil's self-hosted MDM server is off.";
  if (ready) return "Advanced self-hosted MDM endpoints and APNs wakeups are configured.";
  if (enrollmentReady) return blockers[0] || "Advanced self-hosted enrollment is configured, but wireless wakeups are not ready.";
  return blockers[0] || "Finish advanced self-hosted MDM setup before enrolling an iPhone outside ManageEngine.";
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
  const command = mdm.commands.find((item) => item.commandUuid === requestBody.CommandUUID && item.udid === device.udid);
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
  const udid = mdmIdentifier(message);
  if (!udid) throw Object.assign(new Error("MDM device identifier is missing or invalid."), { status: 400 });
  const existing = mdm.devices.find((device) => device.udid === udid);
  if (!existing && mdm.devices.length >= MAX_MDM_DEVICES) {
    throw Object.assign(new Error("Vigil has reached the enrolled-device limit."), { status: 409 });
  }
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

function mdmIdentifier(message: MdmMessage): string | null {
  const value = String(message.UDID || message.EnrollmentID || message.UserID || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function createEnrollmentToken(mdm: MdmSettings, now = new Date()): string {
  const secret = randomSecret();
  const cutoff = now.getTime() - PENDING_ENROLLMENT_TOKEN_TTL_MS;
  const retained = normalizeMdmEnrollmentTokens(mdm.enrollmentTokens).filter((token) => {
    return Boolean(token.boundUdid) || Date.parse(token.createdAt) >= cutoff;
  });
  mdm.enrollmentTokens = [{ hash: secretHash(secret), createdAt: now.toISOString() }, ...retained]
    .slice(0, MAX_ENROLLMENT_TOKENS);
  return secret;
}

function findEnrollmentToken(mdm: MdmSettings, supplied: string, now = new Date()): MdmEnrollmentToken | null {
  if (!supplied) return null;
  const pendingCutoff = now.getTime() - PENDING_ENROLLMENT_TOKEN_TTL_MS;
  const suppliedHash = Buffer.from(secretHash(supplied), "hex");
  return mdm.enrollmentTokens.find((token) => {
    const createdAt = Date.parse(token.createdAt);
    if (!token.boundUdid && (!Number.isFinite(createdAt) || createdAt < pendingCutoff)) return false;
    const expectedHash = Buffer.from(token.hash, "hex");
    return expectedHash.length === suppliedHash.length && timingSafeEqual(expectedHash, suppliedHash);
  }) || null;
}

function secretsEqual(expectedValue: string, suppliedValue: string): boolean {
  const expected = Buffer.from(expectedValue);
  const supplied = Buffer.from(suppliedValue);
  return expected.length > 0 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function simplifyPushError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "APNs push failed.");
}
