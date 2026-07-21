import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { toPlist } from "./plist.js";
import { DATA_DIR } from "./store.js";
import type { UnknownRecord } from "./types.js";

export const CHROME_SAFE_SEARCH_PROFILE_ID = "tech.caseline.vigil.chrome-safe-search";
export const CHROME_SAFE_SEARCH_PAYLOAD_ID = `${CHROME_SAFE_SEARCH_PROFILE_ID}.managed-preferences`;
export const CHROME_SAFE_SEARCH_PROFILE_PATH = join(DATA_DIR, "vigil-chrome-safe-search.mobileconfig");
export const CHROME_PREFERENCE_DOMAIN = "com.google.Chrome";
export const CHROME_PREFERENCE_DOMAINS = Object.freeze([
  CHROME_PREFERENCE_DOMAIN,
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary"
] as const);

type ChromePreferenceDomain = typeof CHROME_PREFERENCE_DOMAINS[number];

const execFileAsync = promisify(execFile);
export const CHROME_SAFE_SEARCH_SIGNATURE = createHash("sha256")
  .update(JSON.stringify({
    version: 2,
    domains: CHROME_PREFERENCE_DOMAINS,
    ForceGoogleSafeSearch: true,
    removalDisallowed: true,
    scope: "System"
  }))
  .digest("hex");
export const CHROME_SAFE_SEARCH_PROFILE_UUID = deterministicUuid(CHROME_SAFE_SEARCH_PROFILE_ID);
export const CHROME_SAFE_SEARCH_PAYLOAD_UUID = deterministicUuid(CHROME_SAFE_SEARCH_PAYLOAD_ID);
const MANAGED_PREFERENCES_ROOT = "/Library/Managed Preferences";
const DEVICE_PROFILE_SECTION_NAMES = new Set([
  "spconfigprofile_section_deviceconfigprofiles",
  "device configuration profiles"
]);

export const CHROME_SAFE_SEARCH_PROFILE_INVENTORY_CACHE_MS = 5 * 60 * 1000;
export const CHROME_SAFE_SEARCH_PROFILE_INVENTORY_MISSING_CACHE_MS = 30 * 1000;
export const CHROME_SAFE_SEARCH_PROFILE_INVENTORY_FAILURE_CACHE_MS = 5 * 1000;

interface ChromeSafeSearchOptions {
  profilePath?: string;
  managedPreferencePath?: string;
  managedPreferencePaths?: Partial<Record<ChromePreferenceDomain, string | readonly string[]>>;
  username?: string;
}

interface ChromePreferenceStatus {
  domain: ChromePreferenceDomain;
  forced: boolean;
  value: boolean;
  path: string;
  checkedPaths: readonly string[];
  error?: string;
}

interface EvaluatedInstalledProfile extends InstalledProfileResult {
  installed: true;
  locked: boolean;
  deviceScoped: boolean;
  removalDisallowed: boolean;
  managedInstall: boolean;
  payloadCurrent: boolean;
  installSource: string;
  validationErrors: readonly string[];
}

export interface InstalledProfileResult {
  installed: boolean;
  signature: string;
  locked?: boolean;
  deviceScoped?: boolean;
  removalDisallowed?: boolean;
  managedInstall?: boolean;
  payloadCurrent?: boolean;
  installSource?: string;
  validationErrors?: readonly string[];
}

interface ProfileInventoryCacheEntry {
  expiresAt: number;
  promise: Promise<InstalledProfileResult>;
  fresh: boolean;
  settled: boolean;
}

interface ProfileInventoryCacheOptions {
  cacheMs?: number;
  missingCacheMs?: number;
  failureCacheMs?: number;
  now?: () => number;
}

export class ChromeSafeSearchProfileInventoryCache {
  private readonly load: () => Promise<InstalledProfileResult>;
  private readonly cacheMs: number;
  private readonly missingCacheMs: number;
  private readonly failureCacheMs: number;
  private readonly now: () => number;
  private entry: ProfileInventoryCacheEntry | null = null;

  constructor(
    load: () => Promise<InstalledProfileResult>,
    options: ProfileInventoryCacheOptions = {}
  ) {
    this.load = load;
    this.cacheMs = options.cacheMs ?? CHROME_SAFE_SEARCH_PROFILE_INVENTORY_CACHE_MS;
    this.missingCacheMs = options.missingCacheMs ?? CHROME_SAFE_SEARCH_PROFILE_INVENTORY_MISSING_CACHE_MS;
    this.failureCacheMs = options.failureCacheMs ?? CHROME_SAFE_SEARCH_PROFILE_INVENTORY_FAILURE_CACHE_MS;
    this.now = options.now || Date.now;
  }

  get(): Promise<InstalledProfileResult> {
    const cached = this.entry;
    if (cached && cached.expiresAt > this.now()) return cached.promise;

    return this.startRefresh(false);
  }

  getFresh(): Promise<InstalledProfileResult> {
    const current = this.entry;
    // Concurrent attestations should share the same fresh inventory read, but
    // a completed result is never fresh enough for a new attestation.
    if (current?.fresh && !current.settled) return current.promise;
    return this.startRefresh(true);
  }

  private startRefresh(fresh: boolean): Promise<InstalledProfileResult> {
    const entry = {
      // Keep concurrent callers on the same promise until the inventory read
      // settles, even when a deliberately tiny test TTL is used.
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve({ installed: false, signature: "" }),
      fresh,
      settled: false
    };
    this.entry = entry;
    entry.promise = this.refresh(entry);
    return entry.promise;
  }

  invalidate(): void {
    this.entry = null;
  }

  private async refresh(entry: ProfileInventoryCacheEntry): Promise<InstalledProfileResult> {
    let value: InstalledProfileResult;
    let maxAge: number;
    try {
      const loaded = await this.load();
      value = {
        ...loaded,
        installed: Boolean(loaded.installed),
        signature: String(loaded.signature || "").toLowerCase()
      };
      // A missing or unprotected profile is the state most likely to change
      // while device management is deploying the current profile, so keep
      // that result short.
      maxAge = value.installed && value.locked !== false ? this.cacheMs : this.missingCacheMs;
    } catch {
      value = { installed: false, signature: "" };
      maxAge = this.failureCacheMs;
    }

    // An invalidation may occur while system_profiler is still running. Do not
    // let that obsolete completion replace the newer refresh.
    if (this.entry === entry) {
      entry.settled = true;
      entry.expiresAt = this.now() + Math.max(0, maxAge);
    }
    return value;
  }
}

const installedProfileInventory = new ChromeSafeSearchProfileInventoryCache(
  loadInstalledChromeSafeSearchProfile
);

export function invalidateChromeSafeSearchProfileInventory(): void {
  installedProfileInventory.invalidate();
}

export function chromeManagedPreferencePath(
  username?: string,
  domain: ChromePreferenceDomain = CHROME_PREFERENCE_DOMAIN
): string {
  return username
    ? join(MANAGED_PREFERENCES_ROOT, username, `${domain}.plist`)
    : join(MANAGED_PREFERENCES_ROOT, `${domain}.plist`);
}

export function chromeManagedPreferencePaths(
  domain: ChromePreferenceDomain = CHROME_PREFERENCE_DOMAIN,
  username = userInfo().username
): readonly string[] {
  // CFPreferences resolves a key from the current user's managed domain
  // before falling back to the machine-wide managed domain. Preserve that
  // key-level precedence here: an explicit per-user false must not be hidden
  // by a machine-wide true, while an absent per-user key can still fall back.
  return [...new Set([
    chromeManagedPreferencePath(username, domain),
    chromeManagedPreferencePath(undefined, domain)
  ])];
}

export function buildChromeSafeSearchProfile(): string {
  const managedPreferences = Object.fromEntries(CHROME_PREFERENCE_DOMAINS.map((domain) => [
    domain,
    {
      Forced: [
        {
          mcx_preference_settings: {
            ForceGoogleSafeSearch: true
          }
        }
      ]
    }
  ]));
  return toPlist({
    PayloadContent: [
      {
        PayloadContent: managedPreferences,
        PayloadDescription: "Forces Google SafeSearch to Filter in every supported Google Chrome channel and prevents users from selecting Blur or Off.",
        PayloadDisplayName: "Vigil Chrome SafeSearch Filter",
        PayloadEnabled: true,
        PayloadIdentifier: CHROME_SAFE_SEARCH_PAYLOAD_ID,
        PayloadType: "com.apple.ManagedClient.preferences",
        PayloadUUID: CHROME_SAFE_SEARCH_PAYLOAD_UUID,
        PayloadVersion: 1
      }
    ],
    PayloadDescription: `Vigil Chrome SafeSearch Filter. VigilPolicySignature:${CHROME_SAFE_SEARCH_SIGNATURE}`,
    PayloadDisplayName: "Vigil Chrome SafeSearch Filter",
    PayloadIdentifier: CHROME_SAFE_SEARCH_PROFILE_ID,
    PayloadOrganization: "Vigil",
    PayloadRemovalDisallowed: true,
    PayloadScope: "System",
    PayloadType: "Configuration",
    PayloadUUID: CHROME_SAFE_SEARCH_PROFILE_UUID,
    PayloadVersion: 1
  });
}

export async function writeChromeSafeSearchProfile(options: ChromeSafeSearchOptions = {}) {
  const path = options.profilePath || CHROME_SAFE_SEARCH_PROFILE_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buildChromeSafeSearchProfile(), "utf8");
  return { path, signature: CHROME_SAFE_SEARCH_SIGNATURE };
}

export async function chromeSafeSearchStatus(options: ChromeSafeSearchOptions = {}) {
  return await chromeSafeSearchStatusWithInventory(options, installedProfileInventory.get());
}

export async function attestChromeSafeSearchStatus(options: ChromeSafeSearchOptions = {}) {
  return await chromeSafeSearchStatusWithInventory(options, installedProfileInventory.getFresh());
}

async function chromeSafeSearchStatusWithInventory(
  options: ChromeSafeSearchOptions,
  installedProfile: Promise<InstalledProfileResult>
) {
  const profilePath = options.profilePath || CHROME_SAFE_SEARCH_PROFILE_PATH;
  const preferencePromise = Promise.all(CHROME_PREFERENCE_DOMAINS.map((domain) => (
    chromeSafeSearchPreferenceStatus(domain, managedPreferencePathsForDomain(options, domain))
  )));
  const [generated, installed, preferences] = await Promise.all([
    generatedProfileMatches(profilePath),
    installedProfile,
    preferencePromise
  ]);
  const unforcedDomains = preferences.filter((preference) => !preference.forced).map((preference) => preference.domain);
  const forced = unforcedDomains.length === 0;
  const profileCurrent = Boolean(
    installed.installed
    && installed.locked === true
    && installed.signature === CHROME_SAFE_SEARCH_SIGNATURE
  );
  const stale = Boolean(installed.installed && !profileCurrent);
  const current = Boolean(profileCurrent && forced);
  const stablePreference = preferences[0]!;
  const errors = preferences.flatMap((preference) => preference.error ? [`${preference.domain}: ${preference.error}`] : []);
  return {
    required: true,
    current,
    effectiveCurrent: current,
    installed: installed.installed,
    profileCurrent,
    stale,
    generated,
    locked: installed.locked === true,
    deviceScoped: installed.deviceScoped === true,
    removalDisallowed: installed.removalDisallowed === true,
    managedInstall: installed.managedInstall === true,
    payloadCurrent: installed.payloadCurrent === true,
    installSource: installed.installSource || null,
    forced,
    value: forced,
    forcedDomains: preferences.filter((preference) => preference.forced).map((preference) => preference.domain),
    unforcedDomains,
    path: profilePath,
    managedPreferencePath: stablePreference.path,
    managedPreferencePaths: Object.fromEntries(preferences.map((preference) => [
      preference.domain,
      { path: preference.path, checkedPaths: preference.checkedPaths, forced: preference.forced }
    ])),
    signature: CHROME_SAFE_SEARCH_SIGNATURE,
    installedSignature: installed.signature || null,
    profileValidationErrors: installed.validationErrors || [],
    detail: current
      ? "Google SafeSearch is locked to Filter in Chrome Stable, Beta, Dev, and Canary; Blur and Off cannot be selected."
      : forced && installed.installSource?.toLowerCase().includes("manual")
        ? "Chrome SafeSearch is effective, but the profile was installed manually and a local administrator can remove it. Deploy the generated profile through device management to lock it."
        : forced
          ? "Chrome SafeSearch is effective, but Vigil could not verify a protected, current device-management profile."
          : `Chrome SafeSearch is not locked to Filter in: ${unforcedDomains.join(", ")}. Apply the current Vigil Chrome profile through device management.`,
    ...(errors.length ? { error: errors.join("; ") } : {})
  };
}

export function chromeSafeSearchStatusFromRecord(record: UnknownRecord, path = chromeManagedPreferencePath()) {
  const present = Object.prototype.hasOwnProperty.call(record, "ForceGoogleSafeSearch");
  const value = record.ForceGoogleSafeSearch;
  const forced = value === true || value === 1;
  return { forced, value: forced, path, present };
}

function managedPreferencePathsForDomain(
  options: ChromeSafeSearchOptions,
  domain: ChromePreferenceDomain
): readonly string[] {
  const configured = options.managedPreferencePaths?.[domain];
  if (configured) {
    const paths = (Array.isArray(configured) ? configured : [configured]).map(String).filter(Boolean);
    if (paths.length) return [...new Set(paths)];
  }
  if (options.managedPreferencePath) {
    return [domain === CHROME_PREFERENCE_DOMAIN
      ? options.managedPreferencePath
      : join(dirname(options.managedPreferencePath), `${domain}.plist`)];
  }
  return chromeManagedPreferencePaths(domain, options.username || userInfo().username);
}

async function chromeSafeSearchPreferenceStatus(
  domain: ChromePreferenceDomain,
  paths: readonly string[]
): Promise<ChromePreferenceStatus> {
  for (const path of paths) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return failedChromeSafeSearchPreferenceStatus(domain, paths, path, error);
    }
    try {
      const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
        timeout: 5000,
        maxBuffer: 1024 * 128
      });
      const record = unknownRecord(JSON.parse(stdout) as unknown);
      if (!record) throw new Error("Managed preference plist root is not a dictionary.");
      const status = chromeSafeSearchStatusFromRecord(record, path);
      if (!status.present) continue;
      return { domain, checkedPaths: paths, ...status };
    } catch (error) {
      return failedChromeSafeSearchPreferenceStatus(domain, paths, path, error);
    }
  }
  return {
    domain,
    forced: false,
    value: false,
    path: paths[0] || chromeManagedPreferencePath(undefined, domain),
    checkedPaths: paths
  };
}

function failedChromeSafeSearchPreferenceStatus(
  domain: ChromePreferenceDomain,
  paths: readonly string[],
  path: string,
  error: unknown
): ChromePreferenceStatus {
  return {
    domain,
    forced: false,
    value: false,
    path,
    checkedPaths: paths,
    error: `${path}: ${simplifyError(error)}`
  };
}

async function generatedProfileMatches(path: string): Promise<boolean> {
  try {
    const text = await readFile(path, "utf8");
    return text.includes(`VigilPolicySignature:${CHROME_SAFE_SEARCH_SIGNATURE}`);
  } catch {
    return false;
  }
}

async function loadInstalledChromeSafeSearchProfile(): Promise<InstalledProfileResult> {
  // `profiles show` only reports profiles at the current user scope. The JSON
  // system-profiler inventory preserves the containing user/device record and
  // each payload, so the signature cannot be borrowed from an unrelated row.
  const { stdout } = await execFileAsync("/usr/sbin/system_profiler", ["SPConfigurationProfileDataType", "-json"], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return parseInstalledChromeSafeSearchProfileInventory(JSON.parse(stdout) as unknown);
}

export function parseInstalledChromeSafeSearchProfileInventory(inventory: unknown): InstalledProfileResult {
  const root = unknownRecord(inventory);
  const sections = root?.SPConfigurationProfileDataType;
  if (!Array.isArray(sections)) throw new Error("System profile inventory is missing SPConfigurationProfileDataType.");

  const candidates: EvaluatedInstalledProfile[] = [];
  for (const sectionValue of sections) {
    const section = unknownRecord(sectionValue);
    if (!section) continue;
    const sectionName = stringField(section, "_name").trim().toLowerCase();
    const deviceSection = DEVICE_PROFILE_SECTION_NAMES.has(sectionName)
      || /\bdevice\b.*\bconfiguration profiles\b/u.test(sectionName);
    const profiles = Array.isArray(section._items) ? section._items : [];
    for (const profileValue of profiles) {
      const profile = unknownRecord(profileValue);
      if (!profile || stringField(profile, "spconfigprofile_profile_identifier") !== CHROME_SAFE_SEARCH_PROFILE_ID) continue;
      candidates.push(evaluateInstalledProfile(profile, deviceSection));
    }
  }

  if (!candidates.length) {
    return {
      installed: false,
      signature: "",
      locked: false,
      deviceScoped: false,
      removalDisallowed: false,
      managedInstall: false,
      payloadCurrent: false,
      validationErrors: ["profile-not-installed"]
    };
  }

  return [...candidates].sort((left, right) => profileValidationScore(right) - profileValidationScore(left))[0]!;
}

function evaluateInstalledProfile(profile: UnknownRecord, deviceSection: boolean): EvaluatedInstalledProfile {
  const description = stringField(profile, "spconfigprofile_description").trim();
  const signature = description.match(/^Vigil Chrome SafeSearch Filter\. VigilPolicySignature:([a-f0-9]{64})$/iu)?.[1]?.toLowerCase() || "";
  const installSource = stringField(profile, "spconfigprofile_install_source").trim();
  const explicitScope = stringField(profile, "spconfigprofile_scope").trim().toLowerCase();
  const deviceScoped = deviceSection || explicitScope === "system" || explicitScope === "device";
  const removalDisallowed = booleanLike(
    profile.spconfigprofile_RemovalDisallowed ?? profile.spconfigprofile_removal_disallowed
  );
  const managedInstall = isManagedProfileInstallSource(installSource);
  const profileMetadataCurrent = (
    stringField(profile, "_name") === "Vigil Chrome SafeSearch Filter"
    && stringField(profile, "spconfigprofile_organization") === "Vigil"
    && stringField(profile, "spconfigprofile_profile_uuid").toUpperCase() === CHROME_SAFE_SEARCH_PROFILE_UUID
    && numberLike(profile.spconfigprofile_version) === 1
  );
  const payloads = Array.isArray(profile._items) ? profile._items : [];
  const payload = payloads
    .map(unknownRecord)
    .find((item) => item?.spconfigprofile_payload_identifier === CHROME_SAFE_SEARCH_PAYLOAD_ID);
  const payloadCurrent = Boolean(payload && (
    stringField(payload, "_name") === "com.apple.ManagedClient.preferences"
    && stringField(payload, "spconfigprofile_payload_display_name") === "Vigil Chrome SafeSearch Filter"
    && stringField(payload, "spconfigprofile_payload_uuid").toUpperCase() === CHROME_SAFE_SEARCH_PAYLOAD_UUID
    && numberLike(payload.spconfigprofile_payload_version) === 1
    && payloadDataForcesAllChromeDomains(stringField(payload, "spconfigprofile_payload_data"))
  ));
  const signatureCurrent = signature === CHROME_SAFE_SEARCH_SIGNATURE;
  const validationErrors = [
    ...(!deviceScoped ? ["profile-not-device-scoped"] : []),
    ...(!removalDisallowed ? ["profile-removal-allowed"] : []),
    ...(!managedInstall ? [installSource.toLowerCase().includes("manual") ? "profile-manually-installed" : "profile-not-device-managed"] : []),
    ...(!profileMetadataCurrent ? ["profile-metadata-mismatch"] : []),
    ...(!payloadCurrent ? ["managed-preferences-payload-mismatch"] : []),
    ...(!signatureCurrent ? ["profile-signature-mismatch"] : [])
  ];
  return {
    installed: true,
    signature,
    locked: validationErrors.length === 0,
    deviceScoped,
    removalDisallowed,
    managedInstall,
    payloadCurrent,
    installSource,
    validationErrors
  };
}

function profileValidationScore(profile: EvaluatedInstalledProfile): number {
  return (profile.locked ? 100 : 0)
    + (profile.deviceScoped ? 16 : 0)
    + (profile.removalDisallowed ? 8 : 0)
    + (profile.managedInstall ? 8 : 0)
    + (profile.payloadCurrent ? 4 : 0)
    + (profile.signature === CHROME_SAFE_SEARCH_SIGNATURE ? 2 : 0);
}

function payloadDataForcesAllChromeDomains(data: string): boolean {
  const root = parseOpenStepValue(data);
  if (!root || root.kind !== "dictionary") return false;
  const payloadContent = exactDictionaryEntry(root, "PayloadContent");
  if (!payloadContent) return false;

  return CHROME_PREFERENCE_DOMAINS.every((domain) => {
    const domainPreferences = exactDictionaryEntry(payloadContent, domain);
    if (!domainPreferences) return false;
    const forced = exactEntry(domainPreferences, "Forced");
    if (!forced || forced.kind !== "array" || forced.values.length !== 1) return false;
    const forcedPreferences = forced.values[0];
    if (!forcedPreferences || forcedPreferences.kind !== "dictionary") return false;
    const settings = exactDictionaryEntry(forcedPreferences, "mcx_preference_settings");
    if (!settings) return false;
    const safeSearch = exactEntry(settings, "ForceGoogleSafeSearch");
    return safeSearch?.kind === "scalar" && ["1", "true"].includes(safeSearch.value.toLowerCase());
  });
}

type OpenStepValue = OpenStepDictionary | OpenStepArray | OpenStepScalar;

interface OpenStepDictionary {
  kind: "dictionary";
  entries: Array<{ key: string; value: OpenStepValue }>;
}

interface OpenStepArray {
  kind: "array";
  values: OpenStepValue[];
}

interface OpenStepScalar {
  kind: "scalar";
  value: string;
}

class OpenStepParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): OpenStepValue | null {
    try {
      const value = this.value();
      this.skipWhitespace();
      return this.position === this.source.length ? value : null;
    } catch {
      return null;
    }
  }

  private value(): OpenStepValue {
    this.skipWhitespace();
    const character = this.source[this.position];
    if (character === "{") return this.dictionary();
    if (character === "(") return this.array();
    return { kind: "scalar", value: this.token(false) };
  }

  private dictionary(): OpenStepDictionary {
    this.expect("{");
    const entries: OpenStepDictionary["entries"] = [];
    while (true) {
      this.skipWhitespace();
      if (this.take("}")) return { kind: "dictionary", entries };
      const key = this.token(true);
      this.skipWhitespace();
      this.expect("=");
      const value = this.value();
      this.skipWhitespace();
      this.expect(";");
      entries.push({ key, value });
    }
  }

  private array(): OpenStepArray {
    this.expect("(");
    const values: OpenStepValue[] = [];
    while (true) {
      this.skipWhitespace();
      if (this.take(")")) return { kind: "array", values };
      values.push(this.value());
      this.skipWhitespace();
      if (this.take(")")) return { kind: "array", values };
      this.expect(",");
    }
  }

  private token(key: boolean): string {
    this.skipWhitespace();
    const quote = this.source[this.position];
    if (quote === "\"" || quote === "'") return this.quotedToken(quote);
    const start = this.position;
    const delimiter = key ? /[\s=;,{}()]/u : /[\s;,{}()]/u;
    while (this.position < this.source.length && !delimiter.test(this.source[this.position]!)) {
      this.position += 1;
    }
    if (this.position === start) throw new Error("Expected OpenStep token.");
    return this.source.slice(start, this.position);
  }

  private quotedToken(quote: string): string {
    this.position += 1;
    let value = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position++]!;
      if (character === quote) return value;
      if (character === "\\") {
        if (this.position >= this.source.length) throw new Error("Unterminated OpenStep escape.");
        value += this.source[this.position++]!;
      } else {
        value += character;
      }
    }
    throw new Error("Unterminated OpenStep string.");
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.position] || "")) this.position += 1;
  }

  private take(character: string): boolean {
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.take(character)) throw new Error(`Expected ${character}.`);
  }
}

function parseOpenStepValue(source: string): OpenStepValue | null {
  return new OpenStepParser(source).parse();
}

function exactEntry(dictionary: OpenStepDictionary, key: string): OpenStepValue | null {
  const matches = dictionary.entries.filter((entry) => entry.key === key);
  return matches.length === 1 ? matches[0]!.value : null;
}

function exactDictionaryEntry(dictionary: OpenStepDictionary, key: string): OpenStepDictionary | null {
  const value = exactEntry(dictionary, key);
  return value?.kind === "dictionary" ? value : null;
}

function isManagedProfileInstallSource(value: string): boolean {
  const source = value.trim().toLowerCase();
  if (!source || source.includes("manual")) return false;
  return /\bmdm\b|mobile device management|profile manager|device enrollment|automated device enrollment|declarative device management/u.test(source);
}

function unknownRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringField(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function booleanLike(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ["yes", "true", "1"].includes(String(value || "").trim().toLowerCase());
}

function numberLike(value: unknown): number {
  return typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] || "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`.toUpperCase();
}

function simplifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}
