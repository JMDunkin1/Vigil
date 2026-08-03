import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const IOS_URL_FILTER_HOST_BUNDLE_IDENTIFIER = "tech.caseline.vigil.url-filter";
export const IOS_URL_FILTER_CONTROL_PROVIDER_BUNDLE_IDENTIFIER = "tech.caseline.vigil.url-filter.control";
export const IOS_URL_FILTER_USECASE_NAME = `${IOS_URL_FILTER_HOST_BUNDLE_IDENTIFIER}.url.filtering`;
export const IOS_URL_FILTER_MINIMUM_FETCH_INTERVAL_SECONDS = 45 * 60;

export interface IosUrlFilterServiceConfiguration {
  schemaVersion: 1;
  pirServerURL: string;
  privacyPassIssuerURL: string;
  deploymentManifestURL: string;
  authenticationToken: string;
  hostBundleIdentifier: string;
  controlProviderBundleIdentifier: string;
  usecaseName: string;
  prefilterFetchIntervalSeconds: number;
  prefilterTag: string;
  pirDatabaseRevision: string;
  pirDatabaseSha256: string;
  exactIndexSnapshotHash: string;
}

export function parseIosUrlFilterServiceConfiguration(value: unknown): IosUrlFilterServiceConfiguration {
  const input = requiredRecord(value);
  const configuration: IosUrlFilterServiceConfiguration = {
    schemaVersion: 1,
    pirServerURL: requiredHttpsOrigin(input.pirServerURL, "PIR server URL"),
    privacyPassIssuerURL: requiredHttpsOrigin(input.privacyPassIssuerURL, "Privacy Pass issuer URL"),
    deploymentManifestURL: requiredHttpsOrigin(input.deploymentManifestURL, "deployment manifest URL"),
    authenticationToken: requiredSecret(input.authenticationToken),
    hostBundleIdentifier: requiredBundleIdentifier(input.hostBundleIdentifier, "host bundle identifier"),
    controlProviderBundleIdentifier: requiredBundleIdentifier(input.controlProviderBundleIdentifier, "control-provider bundle identifier"),
    usecaseName: requiredBundleIdentifier(input.usecaseName, "PIR use-case name"),
    prefilterFetchIntervalSeconds: requiredFetchInterval(input.prefilterFetchIntervalSeconds),
    prefilterTag: requiredIdentifier(input.prefilterTag, "prefilter tag"),
    pirDatabaseRevision: requiredIdentifier(input.pirDatabaseRevision, "PIR database revision"),
    pirDatabaseSha256: requiredSha256(input.pirDatabaseSha256, "PIR database hash"),
    exactIndexSnapshotHash: requiredSha256(input.exactIndexSnapshotHash, "exact-index snapshot hash")
  };
  if (input.schemaVersion !== 1) throw new Error("iOS URL Filter service configuration version is unsupported.");
  if (configuration.hostBundleIdentifier !== IOS_URL_FILTER_HOST_BUNDLE_IDENTIFIER
    || configuration.controlProviderBundleIdentifier !== IOS_URL_FILTER_CONTROL_PROVIDER_BUNDLE_IDENTIFIER
    || configuration.usecaseName !== IOS_URL_FILTER_USECASE_NAME) {
    throw new Error("iOS URL Filter service configuration does not match Vigil's signed bundle identifiers.");
  }
  return configuration;
}

export async function readIosUrlFilterServiceConfiguration(path: string): Promise<IosUrlFilterServiceConfiguration> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read iOS URL Filter service configuration at ${path}.`, { cause: error });
  }
  return parseIosUrlFilterServiceConfiguration(value);
}

export function requiredIosUrlFilterProfileOptions(dataDirectory: string): { urlFilter: IosUrlFilterServiceConfiguration } {
  const path = join(dataDirectory, "ios-url-filter", "service.json");
  try {
    return { urlFilter: parseIosUrlFilterServiceConfiguration(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    throw new Error(`The required fail-closed iOS URL Filter configuration is unavailable at ${path}.`, { cause: error });
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("iOS URL Filter service configuration must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredHttpsOrigin(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`iOS URL Filter ${label} is invalid.`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(`iOS URL Filter ${label} must be an HTTPS URL without credentials, query, or fragment.`);
  }
  return url.toString();
}

function requiredSecret(value: unknown): string {
  const token = String(value || "").trim();
  if (token.length < 16 || token.length > 4096 || /[\r\n]/u.test(token)) {
    throw new Error("iOS URL Filter authentication token is missing or invalid.");
  }
  return token;
}

function requiredBundleIdentifier(value: unknown, label: string): string {
  const identifier = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/u.test(identifier) || !identifier.includes(".")) {
    throw new Error(`iOS URL Filter ${label} is invalid.`);
  }
  return identifier;
}

function requiredFetchInterval(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < IOS_URL_FILTER_MINIMUM_FETCH_INTERVAL_SECONDS) {
    throw new Error(`iOS URL Filter prefilter fetch interval must be at least ${IOS_URL_FILTER_MINIMUM_FETCH_INTERVAL_SECONDS} seconds.`);
  }
  return seconds;
}

function requiredIdentifier(value: unknown, label: string): string {
  const identifier = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(identifier)) throw new Error(`iOS URL Filter ${label} is invalid.`);
  return identifier;
}

function requiredSha256(value: unknown, label: string): string {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`iOS URL Filter ${label} is invalid.`);
  return hash;
}
