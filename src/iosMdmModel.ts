import { randomBytes, randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http2";
import type { IosMdmSettings, UnknownRecord } from "./types.js";

export interface MdmDevice extends UnknownRecord {
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

export interface MdmCommand extends UnknownRecord {
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

export interface MdmSettings extends IosMdmSettings {
  devices: MdmDevice[];
  commands: MdmCommand[];
}

export interface MdmMessage extends UnknownRecord {
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

export interface MdmPushRequest {
  endpoint: string;
  path: string;
  headers: OutgoingHttpHeaders;
  payload: string;
}

export type PlistDataValue = {
  __plistData: string;
};

export function publicMdmDevice(device: MdmDevice) {
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

export function publicMdmCommand(command: MdmCommand) {
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

export function normalizeMdmDevices(values: unknown): MdmDevice[] {
  return Array.isArray(values)
    ? values
      .filter(isUnknownRecord)
      .map((device) => normalizeMdmDevice(device))
    : [];
}

export function normalizeMdmCommands(values: unknown): MdmCommand[] {
  return Array.isArray(values)
    ? values
      .filter(isUnknownRecord)
      .map((command) => normalizeMdmCommand(command))
    : [];
}

export function normalizeMdmDevice(value: UnknownRecord): MdmDevice {
  const device = value as UnknownRecord;
  return {
    ...device,
    id: String(device.id || randomUUID()),
    udid: String(device.udid || "unknown-device"),
    status: String(device.status || "enrolled")
  };
}

export function normalizeMdmCommand(value: UnknownRecord): MdmCommand {
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

export function normalizeBaseUrl(value: unknown): string {
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

export function normalizeUuid(value: unknown): string {
  const raw = String(value || "").trim();
  return /^[0-9A-Fa-f-]{32,36}$/.test(raw) ? raw.toUpperCase() : raw;
}

export function normalizeBase64(value: unknown): string {
  return String(value || "").replace(/\s+/g, "");
}

export function normalizeStatus(value: unknown): string {
  return String(value || "Idle")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function latestDate(values: unknown[]): string | null {
  const times = values
    .map((value) => value ? new Date(String(value)).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

export function dataString(value: unknown): string {
  if (!value) return "";
  if (isPlistDataRecord(value)) return value.__plistData;
  return String(value || "");
}

export function dataHex(value: unknown): string {
  if (!value) return "";
  if (isPlistDataRecord(value)) return bufferFromBase64(value.__plistData).toString("hex");
  const text = String(value || "").trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return text.toLowerCase();
  return bufferFromBase64(text).toString("hex");
}

export function tokenHexFromDevice(device: Partial<MdmDevice> = {}): string {
  return normalizeTokenHex(device.tokenHex) || tokenHexFromStoredToken(device.token);
}

export function tokenHexFromStoredToken(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return normalizeTokenHex(text) || bufferFromBase64(text).toString("hex");
}

export function normalizeTokenHex(value: unknown): string {
  const text = String(value || "").trim();
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) return "";
  return text.toLowerCase();
}

export function bufferFromBase64(value: unknown): Buffer {
  try {
    return Buffer.from(String(value || "").replace(/\s+/g, ""), "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function obscure(value: unknown): string {
  const text = String(value || "");
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function randomSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function isPlistDataRecord(value: unknown): value is PlistDataValue {
  return Boolean(value && typeof value === "object" && typeof (value as PlistDataValue).__plistData === "string");
}
