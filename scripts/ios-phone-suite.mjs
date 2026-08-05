#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPLY_USB_PROFILE_SCRIPT = join(ROOT, "scripts", "apply-ios-usb-profile.mjs");
const RELEASE_PATH = join(ROOT, "ios", "phone-release.json");
const DEFAULT_SERVER = "http://127.0.0.1:8787";
const IOS_PHONE_EDITION_FILENAME = "ios-phone-edition.json";
const PHONE_EDITIONS = new Set(["personal", "enhanced"]);
const PHONE_BLOCKLIST_RESOURCE = "adult-blocklist.sdi";
const URL_FILTER_PREFILTER_RESOURCE = "url-filter-prefilter.vuf";
const URL_FILTER_SERVICE_RESOURCE = "service.json";
const URL_FILTER_MAGIC = Buffer.from("VIGILUF1", "ascii");
const URL_FILTER_HEADER_BYTES = URL_FILTER_MAGIC.byteLength + 4;
const URL_FILTER_APP = {
  id: "url-filter",
  name: "Vigil URL Filter",
  bundleId: "tech.caseline.vigil.url-filter",
  controlProviderBundleId: "tech.caseline.vigil.url-filter.control"
};
const EXPLICIT_CONTENT_POLICY_RESOURCE = "ExplicitContentPolicy.json";
const EXPLICIT_CONTENT_POLICY_PATH = join(ROOT, "ios", "VigilSocial", "VigilSocial", EXPLICIT_CONTENT_POLICY_RESOURCE);
const YOUTUBE_INTERACTION_EXTENSION = {
  productName: "VigilYouTubeInteractionExtension.appex",
  bundleIdentifierSuffix: ".youtube-controls",
  manifestName: "manifest.json",
  scriptName: "youtube-parity.js"
};
const PHONE_BLOCKLIST_MAGIC = Buffer.from("SNTLIDX1", "ascii");
const PHONE_BLOCKLIST_HEADER_BYTES = PHONE_BLOCKLIST_MAGIC.byteLength + 4;
const MAX_PHONE_BLOCKLIST_BYTES = 32 * 1024 * 1024;
const DEFAULT_ADULT_BLOCKLIST_SOURCE_ID = "blocklistproject-porn";
const MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS = 600_000;
const MINIMUM_CUSTOM_ADULT_BLOCKLIST_DOMAINS = 1_000;
const PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
const LAUNCHER_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-social-launchers";
// Retained only for explicit migration from the former full-screen Web Clip.
// Keep this byte-identical to IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER.
const YOUTUBE_WEB_CLIP_PROFILE_IDENTIFIER = "tech.caseline.vigil.youtube-webclip-experiment";
const OBSOLETE_CONFIGURATION_PROFILE_IDENTIFIERS = new Set([
  LAUNCHER_PROFILE_IDENTIFIER,
  YOUTUBE_WEB_CLIP_PROFILE_IDENTIFIER
]);
const LEGACY_BUNDLE_PREFIX = "tech.caseline.sentinel.";
const OBSOLETE_VIGIL_PHONE_BUNDLE_IDS = new Set([
  "tech.caseline.vigil.browser",
  "tech.caseline.vigil.social",
  "tech.caseline.vigil.snapchat"
]);
const OBSOLETE_APPS_PROBLEM_PREFIX = "Obsolete phone apps remain installed:";
const OBSOLETE_LAUNCHER_PROFILE_PROBLEM = "The obsolete Vigil social-launcher profile remains installed; use --replace-legacy to remove its duplicate Home Screen icons.";
const OBSOLETE_YOUTUBE_WEB_CLIP_PROFILE_PROBLEM = "The obsolete Vigil YouTube Web Clip profile remains installed; use --replace-legacy to remove its duplicate YouTube icon and Safari-opening surface.";
const PHONE_SOURCE_FILES = [
  "scripts/apply-ios-usb-profile.mjs",
  "scripts/build-ios-social-app.mts",
  "scripts/generate-ios-content-policy.mts",
  "scripts/ios-phone-suite.mjs",
  "scripts/watch-ios-usb-profile.mjs",
  "src/adultBlocklist.ts",
  "src/adultBlocklistPhoneArtifact.ts",
  "src/contentFilters.ts",
  "src/defaults.ts",
  "src/explicitContentPolicy.ts",
  "src/grayscale.ts",
  "src/iosMdm.ts",
  "src/iosMdmModel.ts",
  "src/iosProfiles.ts",
  "src/iosUrlFilterPrefilter.ts",
  "src/iosUrlFilterServiceConfiguration.ts",
  "src/limits.ts",
  "src/manageEngineExport.ts",
  "src/policy.ts",
  "src/presets.ts",
  "src/socialFeatureFilters.ts",
  "src/socialIconAssets.ts",
  "src/store.ts",
  "src/types.ts"
];
const REQUIRED_SOCIAL_APPS = [
  { id: "instagram", service: "instagram", name: "Instagram", bundleId: "tech.caseline.vigil.instagram", appIconSet: "InstagramAppIcon", scheme: "vigil-instagram", buildScheme: "VigilInstagram" },
  { id: "youtube", service: "youtube", name: "YouTube", bundleId: "tech.caseline.vigil.youtube", appIconSet: "YouTubeAppIcon", scheme: "vigil-youtube", buildScheme: "VigilSocial" }
];
const SOCIAL_APP_IDS = new Set(REQUIRED_SOCIAL_APPS.map((app) => app.id));
const appsForEdition = (edition) => edition === "enhanced"
  ? [...REQUIRED_SOCIAL_APPS, URL_FILTER_APP]
  : [...REQUIRED_SOCIAL_APPS];

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArguments(process.argv.slice(2));
  await main(command, options);
}

async function main(selectedCommand, selectedOptions) {
  if (selectedCommand === "help") return printHelp();
  await configureRuntimeDataDirectory();
  const edition = await selectedPhoneEdition(selectedOptions.edition);
  if (selectedCommand === "fingerprint") {
    const fingerprint = await implementationFingerprint(edition);
    console.log(selectedOptions.json ? JSON.stringify(fingerprint, null, 2) : fingerprint.hash);
    return;
  }
  if (selectedCommand === "bump") {
    const blocklist = await requireReadyPhoneBlocklist("create a phone release");
    if (edition === "enhanced") await requireReadyIosUrlFilter(blocklist, "create an Enhanced phone release");
    const release = await bumpRelease(selectedOptions.bump, selectedOptions.force, edition);
    console.log(`Vigil ${editionLabel(edition)} phone release is ${release.version} (${release.build}).`);
    return;
  }
  if (selectedCommand === "audit") {
    const blocklist = await requireReadyPhoneBlocklist("complete the phone audit");
    const urlFilter = edition === "enhanced"
      ? await requireReadyIosUrlFilter(blocklist, "complete the Enhanced phone audit")
      : await iosUrlFilterReadiness(blocklist);
    const { developerDir, toolEnvironment } = await prepareAuditToolchain();
    console.log(`Apple toolchain: ${developerDir}`);
    await buildRuntime();
    const audit = await auditFourPolicies(toolEnvironment, edition === "enhanced" ? urlFilter.service : null);
    printPolicyAudit(audit, edition);
    printBlocklistReadiness(blocklist);
    return;
  }
  if (selectedCommand === "update") {
    await updatePhone({ ...selectedOptions, edition });
    return;
  }
  if (selectedCommand === "develop") {
    if (edition !== "personal") {
      throw new Error("YouTube development updates require the Personal edition because Enhanced app and URL Filter updates must be deployed together.");
    }
    // The native YouTube companion depends on exact BuiltIn web-filter auth
    // routes. Keep its app and supervised policy in one verified transaction.
    await updatePhone({ ...selectedOptions, edition, noPolicy: false });
    return;
  }
  if (!["status", "check"].includes(selectedCommand)) throw new Error(`Unknown command: ${selectedCommand}`);
  const { device, toolEnvironment } = await preparePhoneToolchain(selectedOptions.device);
  const report = await phoneStatus(selectedOptions, device, toolEnvironment, edition);
  printStatus(report);
  if (selectedCommand === "check" && report.problems.length) process.exitCode = 1;
}

async function configureRuntimeDataDirectory() {
  if (process.env.VIGIL_DATA_DIR) return;
  const blocklistPath = await currentBlocklistPath();
  if (blocklistPath) process.env.VIGIL_DATA_DIR = dirname(blocklistPath);
}

async function selectedPhoneEdition(requested = "") {
  if (requested) return requested;
  const path = phoneEditionPath();
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || !PHONE_EDITIONS.has(value?.edition)) {
      throw new Error(`iPhone edition configuration is invalid: ${path}`);
    }
    return value.edition;
  } catch (error) {
    if (error?.code === "ENOENT") return "personal";
    throw error;
  }
}

async function persistPhoneEdition(edition) {
  if (!PHONE_EDITIONS.has(edition)) throw new Error(`Unknown phone edition: ${edition}`);
  await atomicJsonWrite(phoneEditionPath(), { schemaVersion: 1, edition });
}

function phoneEditionPath() {
  return join(process.env.VIGIL_DATA_DIR || join(ROOT, "data"), IOS_PHONE_EDITION_FILENAME);
}

function editionLabel(edition) {
  return edition === "enhanced" ? "Enhanced" : "Personal";
}

export function parseArguments(args) {
  const values = [...args];
  const first = values[0] && !values[0].startsWith("-") ? values.shift() : "status";
  const command = ["--help", "-h"].includes(first) ? "help" : first;
  const options = {
    bump: "patch",
    device: "",
    edition: "",
    force: false,
    json: false,
    allowEditionDowngrade: false,
    noPolicy: false,
    replaceLegacy: false,
    server: DEFAULT_SERVER
  };
  if (command === "bump" && values[0] && !values[0].startsWith("-")) options.bump = values.shift();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--device") options.device = requiredValue(values, ++index, value);
    else if (value.startsWith("--device=")) options.device = value.slice("--device=".length);
    else if (value === "--edition") options.edition = requiredValue(values, ++index, value);
    else if (value.startsWith("--edition=")) options.edition = value.slice("--edition=".length);
    else if (value === "--server") options.server = requiredValue(values, ++index, value).replace(/\/+$/, "");
    else if (value.startsWith("--server=")) options.server = value.slice("--server=".length).replace(/\/+$/, "");
    else if (value === "--no-policy") options.noPolicy = true;
    else if (value === "--replace-legacy") options.replaceLegacy = true;
    else if (value === "--allow-edition-downgrade") options.allowEditionDowngrade = true;
    else if (value === "--force") options.force = true;
    else if (value === "--json") options.json = true;
    else if (["--help", "-h"].includes(value)) return { command: "help", options };
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!/^(patch|minor|major)$/.test(options.bump)) throw new Error(`Unknown release bump: ${options.bump}`);
  if (options.edition && !PHONE_EDITIONS.has(options.edition)) throw new Error(`Unknown phone edition: ${options.edition}`);
  return { command, options };
}

function requiredValue(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

export async function implementationFingerprint(edition = "personal") {
  if (!PHONE_EDITIONS.has(edition)) throw new Error(`Unknown phone edition: ${edition}`);
  const files = [];
  for (const path of PHONE_SOURCE_FILES) files.push(resolve(ROOT, path));
  files.push(...await filesBelow(join(ROOT, "ios"), isPhoneImplementationFile));
  const blocklistPath = await currentBlocklistPath();
  if (blocklistPath) files.push(blocklistPath);
  if (edition === "enhanced") {
    const filterDirectory = urlFilterDirectory();
    for (const path of [
      join(filterDirectory, "manifest.json"),
      join(filterDirectory, URL_FILTER_PREFILTER_RESOURCE),
      join(filterDirectory, URL_FILTER_SERVICE_RESOURCE),
      join(filterDirectory, "pir", "input.txtpb"),
      join(filterDirectory, "pir", "url-config.json"),
      join(filterDirectory, "pir", "service-config.json"),
      join(filterDirectory, "pir", "deployment-manifest.json")
    ]) {
      if (await isFile(path)) files.push(path);
    }
    const pirDirectory = join(filterDirectory, "pir");
    if (await isFile(join(pirDirectory, "processed-manifest.json"))) {
      files.push(join(pirDirectory, "processed-manifest.json"));
      for (const entry of await readdir(pirDirectory)) {
        if (/^url-\d+\.(?:bin|params\.txtpb)$/u.test(entry)) files.push(join(pirDirectory, entry));
      }
    }
  }
  const unique = [...new Set(files)].sort();
  const digest = createHash("sha256");
  digest.update(`edition:${edition}\n`);
  const entries = [];
  for (const path of unique) {
    const bytes = await readFile(path);
    const name = path.startsWith(ROOT) ? relative(ROOT, path) : "runtime/adult-blocklist.sdi";
    const hash = sha256(bytes);
    entries.push({ path: name, bytes: bytes.byteLength, sha256: hash });
    digest.update(name).update("\0").update(hash).update("\n");
  }
  return { hash: digest.digest("hex"), edition, files: entries, blocklistPath };
}

export async function socialAppImplementationFingerprint(appId) {
  if (!SOCIAL_APP_IDS.has(appId)) throw new Error(`Unknown social app: ${appId}`);
  const socialRoot = join(ROOT, "ios", "VigilSocial");
  const files = await filesBelow(socialRoot, (path) => isSocialAppImplementationFile(path, appId));
  files.push(join(ROOT, "ios", "Shared", "PersonalTeam.entitlements"));
  const unique = [...new Set(files)].sort();
  const digest = createHash("sha256");
  digest.update(`app:${appId}\n`);
  const entries = [];
  for (const path of unique) {
    const bytes = await readFile(path);
    const name = relative(ROOT, path);
    const hash = sha256(bytes);
    entries.push({ path: name, bytes: bytes.byteLength, sha256: hash });
    digest.update(name).update("\0").update(hash).update("\n");
  }
  return { hash: digest.digest("hex"), appId, files: entries };
}

export function isSocialAppImplementationFile(path, appId) {
  const normalized = String(path).replaceAll("\\", "/");
  if (normalized.endsWith(".md") || normalized.includes("/VigilSocialTests/")) return false;
  if (normalized.includes("/xcuserdata/") || normalized.endsWith("/.DS_Store")) return false;
  if (appId === "youtube" && normalized.includes("/VigilYouTubeInteractionExtension/")) {
    return normalized.endsWith(`/Resources/${YOUTUBE_INTERACTION_EXTENSION.scriptName}`);
  }
  return true;
}

export function isPhoneImplementationFile(path) {
  const iosRelativePath = relative(join(ROOT, "ios"), path);
  if (basename(path) === "phone-release.json" || path.endsWith(".md")) return false;
  if (String(path).replaceAll("\\", "/").includes("/ios/VigilBrowser/")) return false;
  return !iosRelativePath.split("/").some((part) => part.endsWith("Tests"));
}

async function filesBelow(root, include) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["DerivedData", "xcuserdata", ".DS_Store"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path, include));
    else if (entry.isFile() && include(path)) output.push(path);
  }
  return output;
}

async function currentBlocklistPath() {
  const candidates = [
    process.env.VIGIL_PHONE_BLOCKLIST,
    join(homedir(), "Library", "Application Support", "Vigil", "adult-blocklist.sdi"),
    join(ROOT, "data", "adult-blocklist.sdi")
  ].filter(Boolean);
  for (const path of candidates) if (await isFile(path)) return resolve(path);
  return "";
}

export function inspectPhoneBlocklistBytes(value, path = "") {
  const bytes = Buffer.from(value);
  const failed = (error) => ({
    ready: false,
    path,
    domainCount: 0,
    snapshotHash: "",
    payloadSha256: "",
    artifactSha256: sha256(bytes),
    bytes: bytes.byteLength,
    generatedAt: "",
    source: null,
    error
  });
  if (bytes.byteLength > MAX_PHONE_BLOCKLIST_BYTES) return failed("artifact exceeds the 32 MiB phone limit");
  if (bytes.byteLength < PHONE_BLOCKLIST_HEADER_BYTES
    || !bytes.subarray(0, PHONE_BLOCKLIST_MAGIC.byteLength).equals(PHONE_BLOCKLIST_MAGIC)) {
    return failed("artifact has an invalid format signature");
  }
  const metadataLength = bytes.readUInt32LE(PHONE_BLOCKLIST_MAGIC.byteLength);
  const bodyOffset = PHONE_BLOCKLIST_HEADER_BYTES + metadataLength;
  if (metadataLength < 1 || bodyOffset > bytes.byteLength) return failed("artifact metadata is truncated");
  let metadata;
  try {
    metadata = JSON.parse(bytes.subarray(PHONE_BLOCKLIST_HEADER_BYTES, bodyOffset).toString("utf8"));
  } catch {
    return failed("artifact metadata is invalid JSON");
  }
  const indexBytes = metadata?.formatVersion === 2 ? Number(metadata?.indexBytes) : 0;
  const payloadOffset = bodyOffset + indexBytes;
  if (!Number.isSafeInteger(indexBytes) || indexBytes < 0 || payloadOffset > bytes.byteLength) {
    return failed("artifact sparse index is truncated");
  }
  const index = bytes.subarray(bodyOffset, payloadOffset);
  const payload = bytes.subarray(payloadOffset);
  const sourceId = String(metadata?.source?.id || "");
  const minimumDomains = sourceId === DEFAULT_ADULT_BLOCKLIST_SOURCE_ID
    ? MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS
    : MINIMUM_CUSTOM_ADULT_BLOCKLIST_DOMAINS;
  const versionOne = metadata?.formatVersion === 1
    && metadata?.encoding === "blocked-reversed-domain-front-coding-v1";
  const versionTwo = metadata?.formatVersion === 2
    && metadata?.encoding === "blocked-reversed-domain-front-coding-v2";
  const expectedIndexBytes = Math.ceil(Number(metadata?.domainCount || 0) / 64) * 4;
  const sourceDomainCount = Number(metadata?.sourceDomainCount ?? metadata?.domainCount);
  const metadataValid = (versionOne || versionTwo)
    && metadata?.blockSize === 64
    && Number.isInteger(metadata?.domainCount)
    && metadata.domainCount >= minimumDomains
    && metadata.domainCount <= 2_000_000
    && Number.isSafeInteger(sourceDomainCount)
    && sourceDomainCount >= metadata.domainCount
    && sourceDomainCount <= 2_000_000
    && metadata?.payloadBytes === payload.byteLength
    && (!versionOne || index.byteLength === 0)
    && (!versionTwo || (index.byteLength === expectedIndexBytes
      && metadata?.indexBytes === expectedIndexBytes
      && /^[a-f0-9]{64}$/u.test(String(metadata?.indexSha256 || ""))
      && sha256(index) === String(metadata.indexSha256).toLowerCase()))
    && sourceId.length > 0
    && String(metadata?.source?.label || "").length > 0
    && String(metadata?.source?.license || "").length > 0
    && Number.isFinite(Date.parse(String(metadata?.generatedAt || "")))
    && /^[a-f0-9]{64}$/u.test(String(metadata?.snapshotHash || ""))
    && /^[a-f0-9]{64}$/u.test(String(metadata?.payloadSha256 || ""));
  if (!metadataValid) {
    const countDetail = Number.isInteger(metadata?.domainCount) && metadata.domainCount < minimumDomains
      ? `; ${minimumDomains} domains are required for ${sourceId || "the configured source"}`
      : "";
    return failed(`artifact metadata does not satisfy the phone format contract${countDetail}`);
  }
  const payloadSha256 = sha256(payload);
  if (payloadSha256 !== String(metadata.payloadSha256).toLowerCase()) return failed("artifact payload hash does not match its metadata");
  if (!validatePhoneBlocklistPayload(payload, metadata.domainCount, metadata.blockSize)) {
    return failed("artifact payload rows do not match the declared domain count and ordering");
  }
  if (versionTwo && !validatePhoneBlocklistOffsets(index, payload, metadata.domainCount, metadata.blockSize)) {
    return failed("artifact sparse index does not match its payload");
  }
  return {
    ready: true,
    path,
    domainCount: metadata.domainCount,
    snapshotHash: String(metadata.snapshotHash).toLowerCase(),
    payloadSha256,
    artifactSha256: sha256(bytes),
    bytes: bytes.byteLength,
    generatedAt: String(metadata.generatedAt || ""),
    source: metadata.source && typeof metadata.source === "object" ? metadata.source : null,
    error: ""
  };
}

function validatePhoneBlocklistOffsets(index, payload, expectedCount, blockSize) {
  let cursor = 0;
  let count = 0;
  let block = 0;
  while (cursor < payload.byteLength && count < expectedCount) {
    if (count % blockSize === 0) {
      if (block * 4 + 4 > index.byteLength || index.readUInt32LE(block * 4) !== cursor) return false;
      block += 1;
    }
    if (cursor + 2 > payload.byteLength) return false;
    cursor += 2 + payload[cursor + 1];
    if (cursor > payload.byteLength) return false;
    count += 1;
  }
  return cursor === payload.byteLength && count === expectedCount && block * 4 === index.byteLength;
}

function validatePhoneBlocklistPayload(payload, expectedCount, blockSize) {
  let cursor = 0;
  let count = 0;
  let previous = "";
  let globallyPrevious = "";
  while (cursor < payload.byteLength) {
    if (cursor + 2 > payload.byteLength) return false;
    const prefixLength = payload[cursor];
    const suffixLength = payload[cursor + 1];
    cursor += 2;
    if (count % blockSize === 0) previous = "";
    if ((count % blockSize === 0 && prefixLength !== 0)
      || prefixLength > previous.length
      || cursor + suffixLength > payload.byteLength) return false;
    const domain = previous.slice(0, prefixLength) + payload.subarray(cursor, cursor + suffixLength).toString("ascii");
    if (!/^[a-z0-9.-]+$/u.test(domain) || (globallyPrevious && globallyPrevious >= domain)) return false;
    cursor += suffixLength;
    count += 1;
    previous = domain;
    globallyPrevious = domain;
    if (count > expectedCount) return false;
  }
  return cursor === payload.byteLength && count === expectedCount;
}

export async function phoneBlocklistReadiness(explicitPath = "") {
  const path = explicitPath ? resolve(explicitPath) : await currentBlocklistPath();
  if (!path) {
    return {
      ready: false,
      path: "",
      domainCount: 0,
      snapshotHash: "",
      payloadSha256: "",
      artifactSha256: "",
      bytes: 0,
      generatedAt: "",
      source: null,
      error: "no current adult-blocklist.sdi artifact exists"
    };
  }
  try {
    return inspectPhoneBlocklistBytes(await readFile(path), path);
  } catch (error) {
    return {
      ready: false,
      path,
      domainCount: 0,
      snapshotHash: "",
      payloadSha256: "",
      artifactSha256: "",
      bytes: 0,
      generatedAt: "",
      source: null,
      error: `artifact could not be read: ${error?.message || error}`
    };
  }
}

function urlFilterDirectory() {
  const dataDirectory = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
  return resolve(process.env.VIGIL_IOS_URL_FILTER_DIR || join(dataDirectory, "ios-url-filter"));
}

export async function iosUrlFilterReadiness(blocklist, explicitDirectory = "") {
  const directory = resolve(explicitDirectory || urlFilterDirectory());
  const failed = (error) => ({ ready: false, directory, error, service: null, prefilter: null });
  try {
    if (!blocklist?.ready) return failed("the exact phone blocklist is not ready");
    const prefilterBytes = await readFile(join(directory, URL_FILTER_PREFILTER_RESOURCE));
    if (prefilterBytes.byteLength < URL_FILTER_HEADER_BYTES
      || !prefilterBytes.subarray(0, URL_FILTER_MAGIC.byteLength).equals(URL_FILTER_MAGIC)) {
      return failed("the Bloom prefilter has an invalid format signature");
    }
    const metadataLength = prefilterBytes.readUInt32LE(URL_FILTER_MAGIC.byteLength);
    const bitsetOffset = URL_FILTER_HEADER_BYTES + metadataLength;
    if (metadataLength < 1 || bitsetOffset > prefilterBytes.byteLength) return failed("the Bloom prefilter metadata is truncated");
    const metadata = JSON.parse(prefilterBytes.subarray(URL_FILTER_HEADER_BYTES, bitsetOffset).toString("utf8"));
    const bitset = prefilterBytes.subarray(bitsetOffset);
    if (metadata?.formatVersion !== 1
      || metadata?.encoding !== "apple-neurlfilter-prefilter-bloom-v1"
      || metadata?.snapshotHash !== blocklist.snapshotHash
      || metadata?.exactIndexPayloadSha256 !== blocklist.payloadSha256
      || metadata?.exactDomainCount !== blocklist.domainCount
      || metadata?.bitsetBytes !== bitset.byteLength
      || metadata?.bitsetSha256 !== sha256(bitset)) {
      return failed("the Bloom prefilter is invalid or does not match the exact phone blocklist");
    }
    const service = JSON.parse(await readFile(join(directory, URL_FILTER_SERVICE_RESOURCE), "utf8"));
    const urls = [service?.pirServerURL, service?.privacyPassIssuerURL, service?.deploymentManifestURL]
      .map((value) => new URL(String(value || "")));
    const serviceValid = service?.schemaVersion === 1
      && urls.every((url) => url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.search && !url.hash)
      && typeof service?.authenticationToken === "string" && service.authenticationToken.trim().length >= 16
      && service?.hostBundleIdentifier === URL_FILTER_APP.bundleId
      && service?.controlProviderBundleIdentifier === URL_FILTER_APP.controlProviderBundleId
      && service?.usecaseName === `${URL_FILTER_APP.bundleId}.url.filtering`
      && Number.isSafeInteger(service?.prefilterFetchIntervalSeconds)
      && service.prefilterFetchIntervalSeconds >= 45 * 60
      && service?.prefilterTag === metadata.tag
      && service?.pirDatabaseRevision === metadata.pirDatabaseRevision
      && service?.exactIndexSnapshotHash === metadata.snapshotHash
      && /^[a-f0-9]{64}$/u.test(String(service?.pirDatabaseSha256 || ""));
    if (!serviceValid) return failed("service.json is invalid or does not match the generated Bloom/PIR revision");
    const pirDatabase = await readFile(join(directory, "pir", "input.txtpb"));
    if (sha256(pirDatabase) !== service.pirDatabaseSha256) {
      return failed("the local PIR database does not match service.json");
    }
    const processed = JSON.parse(await readFile(join(directory, "pir", "processed-manifest.json"), "utf8"));
    const sourceManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    if (processed?.schemaVersion !== 1
      || processed?.exactIndexSnapshotHash !== metadata.snapshotHash
      || processed?.pirDatabaseRevision !== metadata.pirDatabaseRevision
      || processed?.pirDatabaseSha256 !== service.pirDatabaseSha256
      || processed?.shardCount !== sourceManifest?.shardCount
      || !Array.isArray(processed?.shards)
      || processed.shards.length !== processed.shardCount) {
      return failed("the processed PIR shard manifest is missing, stale, or mismatched");
    }
    for (const [index, shard] of processed.shards.entries()) {
      if (shard?.id !== index) return failed("the processed PIR shard manifest is not contiguous");
      for (const key of ["database", "parameters"]) {
        const entry = shard?.[key];
        if (!entry || typeof entry.file !== "string" || !/^[A-Za-z0-9._-]+$/u.test(entry.file)) {
          return failed("the processed PIR shard manifest contains an invalid filename");
        }
        const bytes = await readFile(join(directory, "pir", entry.file));
        if (entry.bytes !== bytes.byteLength || entry.sha256 !== sha256(bytes)) {
          return failed(`processed PIR shard ${entry.file} failed its integrity check`);
        }
      }
    }
    const deploymentManifest = JSON.parse(await readFile(join(directory, "pir", "deployment-manifest.json"), "utf8"));
    if (deploymentManifest?.schemaVersion !== 1
      || deploymentManifest?.exactIndexSnapshotHash !== metadata.snapshotHash
      || deploymentManifest?.prefilterTag !== metadata.tag
      || deploymentManifest?.pirDatabaseRevision !== metadata.pirDatabaseRevision
      || deploymentManifest?.pirDatabaseSha256 !== service.pirDatabaseSha256
      || deploymentManifest?.shardCount !== processed.shardCount
      || !Array.isArray(deploymentManifest?.shards)
      || JSON.stringify(deploymentManifest.shards) !== JSON.stringify(processed.shards)) {
      return failed("the public deployment manifest is stale or does not match the processed PIR shards");
    }
    return {
      ready: true,
      directory,
      error: "",
      service,
      deploymentManifest,
      prefilter: {
        path: join(directory, URL_FILTER_PREFILTER_RESOURCE),
        sha256: sha256(prefilterBytes),
        bytes: prefilterBytes.byteLength,
        tag: metadata.tag,
        pirDatabaseRevision: metadata.pirDatabaseRevision,
        pirDatabaseSha256: service.pirDatabaseSha256,
        domainCount: metadata.exactDomainCount
      }
    };
  } catch (error) {
    return failed(error?.message || String(error));
  }
}

async function requireReadyIosUrlFilter(blocklist, purpose) {
  const readiness = await iosUrlFilterReadiness(blocklist);
  if (!readiness.ready) {
    throw new Error(`Cannot ${purpose}: the required fail-closed iOS URL Filter is not deployable (${readiness.error}). Run npm run ios:url-filter:prepare with the production PIR and Privacy Pass HTTPS endpoints.`);
  }
  let published;
  try {
    const response = await fetch(readiness.service.deploymentManifestURL, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    published = await response.json();
  } catch (error) {
    throw new Error(`Cannot ${purpose}: the published URL Filter deployment manifest is unreachable (${error?.message || error}).`, { cause: error });
  }
  if (JSON.stringify(published) !== JSON.stringify(readiness.deploymentManifest)) {
    throw new Error(`Cannot ${purpose}: the published URL Filter deployment manifest does not match the exact local prefilter and processed PIR shards.`);
  }
  return readiness;
}

export function blocklistReadinessProblems(readiness, serverState = null) {
  const problems = [];
  if (!readiness?.ready) {
    problems.push(`The phone adult blocklist is unavailable: ${readiness?.error || "unknown artifact error"}.`);
    return problems;
  }
  const state = serverState?.state;
  const enabled = state?.settings?.adultBlocklistEnabled !== false;
  const live = state?.adultBlocklist;
  if (state && enabled) {
    const activeDomainCount = Number(live?.activeDomainCount || 0);
    const liveHash = String(live?.hash || "").toLowerCase();
    if (activeDomainCount < 1 || !/^[a-f0-9]{64}$/u.test(liveHash)) {
      problems.push("The live adult blocklist is enabled but has zero verified active domains.");
    } else {
      if (activeDomainCount !== readiness.domainCount) {
        problems.push(`The phone artifact contains ${readiness.domainCount} domains, but live state reports ${activeDomainCount} active domains.`);
      }
      if (liveHash !== readiness.snapshotHash) {
        problems.push("The phone adult blocklist artifact does not match the current live snapshot hash.");
      }
      const configuredSourceId = String(state?.settings?.adultBlocklistSourceId || DEFAULT_ADULT_BLOCKLIST_SOURCE_ID);
      const liveSourceId = String(live?.source?.id || "");
      const artifactSourceId = String(readiness?.source?.id || "");
      const sourceFields = ["id", "label", "url", "homepage", "license"];
      const artifactMatchesLiveSource = sourceFields.every((field) => (
        String(readiness?.source?.[field] || "") === String(live?.source?.[field] || "")
      ));
      if (liveSourceId !== configuredSourceId || artifactSourceId !== configuredSourceId || !artifactMatchesLiveSource) {
        problems.push(`The phone adult blocklist source does not match the configured source (${configuredSourceId}).`);
      }
    }
  }
  return problems;
}

export function deployedBlocklistProblems(receipt, readiness, requiredBundleIds = [URL_FILTER_APP.bundleId]) {
  if (!readiness?.ready) return [];
  if (!receipt) return ["No deployment receipt proves that the installed phone apps contain the verified adult blocklist."];
  const deployed = receipt.blocklist;
  if (!deployed?.artifactSha256 || !deployed?.snapshotHash || !Number.isInteger(deployed?.domainCount)) {
    return ["The deployment receipt predates bundled adult-blocklist verification; rebuild and redeploy the phone apps."];
  }
  const problems = [];
  if (deployed.artifactSha256 !== readiness.artifactSha256
    || deployed.snapshotHash !== readiness.snapshotHash
    || deployed.domainCount !== readiness.domainCount) {
    problems.push("The adult blocklist verified in the last phone deployment does not match the current artifact.");
  }
  const receipts = Array.isArray(receipt.apps) ? receipt.apps : [];
  const unverifiedApps = requiredBundleIds.filter((bundleId) => {
    const app = receipts.find((item) => item?.bundleId === bundleId);
    return app?.blocklistArtifactSha256 !== deployed.artifactSha256
      || app?.blocklistDomainCount !== deployed.domainCount;
  });
  if (unverifiedApps.length) {
    problems.push(`The deployment receipt does not prove the bundled blocklist for: ${unverifiedApps.join(", ")}.`);
  }
  return problems;
}

function deployedExplicitContentPolicyProblems(receipt, expected, requiredBundleIds = REQUIRED_SOCIAL_APPS.map((app) => app.bundleId)) {
  if (!receipt) return ["No deployment receipt proves that the installed phone apps contain the generated explicit-content policy."];
  if (receipt.explicitContentPolicy?.sha256 !== expected.sha256) {
    return ["The deployment receipt does not match the current generated explicit-content policy."];
  }
  const receipts = Array.isArray(receipt.apps) ? receipt.apps : [];
  const unverifiedApps = requiredBundleIds.filter((bundleId) => {
    const app = receipts.find((item) => item?.bundleId === bundleId);
    return app?.explicitContentPolicySha256 !== expected.sha256;
  });
  return unverifiedApps.length
    ? [`The deployment receipt does not prove the bundled explicit-content policy for: ${unverifiedApps.join(", ")}.`]
    : [];
}

function deployedYouTubeParityScriptProblems(receipt, expected) {
  const apps = Array.isArray(receipt?.apps) ? receipt.apps : [];
  const youtube = apps.find((app) => app?.bundleId === "tech.caseline.vigil.youtube");
  return youtube?.youtubeParityScriptSha256 === expected.sha256
    ? []
    : ["The deployment receipt does not prove the current app-root YouTube Shorts/miniplayer parity script."];
}

async function requireReadyPhoneBlocklist(purpose) {
  const readiness = await phoneBlocklistReadiness();
  if (!readiness.ready) {
    throw new Error(`Cannot ${purpose}: ${readiness.error}. Refresh the adult blocklist first.`);
  }
  const statePath = join(dirname(readiness.path), "state.json");
  let serverState;
  try {
    serverState = { state: JSON.parse(await readFile(statePath, "utf8")) };
  } catch (error) {
    throw new Error(`Cannot ${purpose}: ${statePath} could not be read to verify the artifact against current state (${error?.message || error}).`, { cause: error });
  }
  const problems = blocklistReadinessProblems(readiness, serverState);
  if (problems.length) throw new Error(`Cannot ${purpose}: ${problems.join(" ")}`);
  return readiness;
}

async function readReleaseManifest() {
  const release = JSON.parse(await readFile(RELEASE_PATH, "utf8"));
  const commonValid = /^\d+\.\d+\.\d+$/.test(release.version)
    && Number.isInteger(release.build)
    && release.build >= 1
    && Number.isFinite(Date.parse(String(release.releasedAt || "")));
  const fingerprintsValid = [2, 3].includes(release.schemaVersion)
    && release.sourceFingerprints
    && typeof release.sourceFingerprints === "object"
    && [...PHONE_EDITIONS].every((edition) => {
      const value = release.sourceFingerprints[edition];
      return value === "" || /^[a-f0-9]{64}$/u.test(String(value || ""));
    });
  const appsValid = release.schemaVersion !== 3 || REQUIRED_SOCIAL_APPS.every(({ id }) => {
    const app = release.apps?.[id];
    return /^\d+\.\d+\.\d+$/.test(String(app?.version || ""))
      && Number.isInteger(app?.build)
      && app.build >= 1
      && Number.isFinite(Date.parse(String(app?.releasedAt || "")))
      && /^[a-f0-9]{64}$/u.test(String(app?.sourceFingerprint || ""));
  });
  const legacyValid = release.schemaVersion === 1 && /^[a-f0-9]{64}$/u.test(String(release.sourceFingerprint || ""));
  if (!commonValid || (!legacyValid && !fingerprintsValid) || !appsValid) {
    throw new Error(`Invalid phone release manifest: ${RELEASE_PATH}`);
  }
  return release;
}

async function readRelease(edition = "personal") {
  const manifest = await readReleaseManifest();
  const sourceFingerprint = manifest.schemaVersion >= 2
    ? String(manifest.sourceFingerprints[edition] || "")
    : String(manifest.sourceFingerprint || "");
  const apps = Object.fromEntries(REQUIRED_SOCIAL_APPS.map(({ id }) => {
    const app = manifest.schemaVersion === 3 ? manifest.apps[id] : manifest;
    return [id, { ...app, sourceFingerprint: manifest.schemaVersion === 3 ? app.sourceFingerprint : sourceFingerprint }];
  }));
  return { ...manifest, edition, sourceFingerprint, apps };
}

async function bumpRelease(level = "patch", force = false, edition = "personal") {
  const manifest = await readReleaseManifest();
  const release = await readRelease(edition);
  const [fingerprint, ...appFingerprints] = await Promise.all([
    implementationFingerprint(edition),
    ...REQUIRED_SOCIAL_APPS.map((app) => socialAppImplementationFingerprint(app.id))
  ]);
  const systemChanged = force || release.sourceFingerprint !== fingerprint.hash;
  const sourceFingerprints = manifest.schemaVersion >= 2
    ? { ...manifest.sourceFingerprints }
    : { personal: "", enhanced: String(manifest.sourceFingerprint || "") };
  sourceFingerprints[edition] = fingerprint.hash;
  const releasedAt = new Date().toISOString();
  const apps = {};
  const changedAppIds = [];
  for (const [index, social] of REQUIRED_SOCIAL_APPS.entries()) {
    const current = release.apps[social.id];
    const appChanged = force || (manifest.schemaVersion === 3
      && current.sourceFingerprint !== appFingerprints[index].hash);
    if (appChanged) changedAppIds.push(social.id);
    apps[social.id] = {
      version: appChanged ? incrementVersion(current.version, level) : current.version,
      build: appChanged ? current.build + 1 : current.build,
      sourceFingerprint: appFingerprints[index].hash,
      releasedAt: appChanged ? releasedAt : current.releasedAt
    };
  }
  if (!systemChanged && changedAppIds.length === 0 && manifest.schemaVersion === 3) return release;
  const next = {
    schemaVersion: 3,
    version: systemChanged ? incrementVersion(release.version, level) : release.version,
    build: systemChanged ? release.build + 1 : release.build,
    sourceFingerprints,
    releasedAt: systemChanged ? releasedAt : release.releasedAt,
    apps
  };
  await atomicJsonWrite(RELEASE_PATH, next);
  return {
    ...next,
    edition,
    sourceFingerprint: fingerprint.hash,
    changedAppIds,
    apps: Object.fromEntries(REQUIRED_SOCIAL_APPS.map(({ id }) => [
      id,
      apps[id]
    ]))
  };
}

export function incrementVersion(version, level) {
  const parts = version.split(".").map(Number);
  if (level === "major") return `${parts[0] + 1}.0.0`;
  if (level === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function isLegacyPhoneBundleIdentifier(bundleIdentifier) {
  const value = String(bundleIdentifier || "");
  return value.startsWith(LEGACY_BUNDLE_PREFIX) || OBSOLETE_VIGIL_PHONE_BUNDLE_IDS.has(value);
}

export function policyFreshnessProblems({ installedProfileName = "", receiptFingerprint = "", livePolicyFingerprint = "" } = {}) {
  const live = String(livePolicyFingerprint || "");
  if (!live) return [];
  const problems = [];
  const receipt = String(receiptFingerprint || "");
  if (receipt && receipt !== live) {
    problems.push("The last deployment receipt does not match the currently generated live policy.");
  }
  if (installedProfileName && !String(installedProfileName).includes(live.slice(0, 12))) {
    problems.push("The installed policy profile does not match the currently generated live policy.");
  }
  return problems;
}

export function preservedPolicyReceipt(receipt) {
  return {
    policyFingerprint: typeof receipt?.policyFingerprint === "string" ? receipt.policyFingerprint : "",
    policyArtifactHash: typeof receipt?.policyArtifactHash === "string" ? receipt.policyArtifactHash : ""
  };
}

export function receiptPhoneEdition(receipt) {
  if (PHONE_EDITIONS.has(receipt?.edition)) return receipt.edition;
  const apps = Array.isArray(receipt?.apps) ? receipt.apps : [];
  const hasUrlFilterApp = apps.some((app) => app?.bundleId === URL_FILTER_APP.bundleId);
  const hasVerifiedUrlFilter = receipt?.liveUrlFilterAudit?.status === "running"
    && receipt?.liveUrlFilterAudit?.enabled === true
    && receipt?.liveUrlFilterAudit?.failClosed === true;
  return hasUrlFilterApp || hasVerifiedUrlFilter ? "enhanced" : "personal";
}

export function socialAppsNeedingUpdate(release, installedApps = []) {
  return REQUIRED_SOCIAL_APPS.filter((app) => {
    const installed = installedApps.find((candidate) => candidate.bundleIdentifier === app.bundleId);
    const expected = release.apps[app.id];
    return !installed
      || installed.version !== expected.version
      || String(installed.bundleVersion || "") !== String(expected.build);
  }).map((app) => app.id);
}

function signingVariantForCapabilities(capabilities, fallback = "unknown") {
  const socialCapabilities = REQUIRED_SOCIAL_APPS
    .map((app) => capabilities?.[app.id])
    .filter(Boolean);
  if (socialCapabilities.length !== REQUIRED_SOCIAL_APPS.length) return fallback;
  const capableApps = socialCapabilities.filter((value) => value.sensitiveContentAnalysis).length;
  if (capableApps === socialCapabilities.length) return "full-capabilities";
  if (capableApps === 0) return "personal-team-conservative";
  return "mixed-capabilities";
}

async function phoneStatus(selectedOptions, device, toolEnvironment, edition) {
  const [release, fingerprint, blocklist, explicitContentPolicy, youtubeParityScript] = await Promise.all([
    readRelease(edition),
    implementationFingerprint(edition),
    phoneBlocklistReadiness(),
    expectedExplicitContentPolicy(),
    expectedYouTubeParityScript()
  ]);
  const urlFilter = await iosUrlFilterReadiness(blocklist);
  const [appsResult, profileVerification, serverState] = await Promise.all([
    devicectlJson(["device", "info", "apps", "--device", device.identifier], toolEnvironment),
    configurationProfileStatus(device.identifier, toolEnvironment),
    fetchServerState(selectedOptions.server)
  ]);
  const currentPolicy = await currentPolicyFingerprint(selectedOptions.server, serverState, {
    allowCurrentRuntime: release.sourceFingerprint === fingerprint.hash,
    urlFilterService: urlFilter.ready ? urlFilter.service : null
  });
  const livePolicyFingerprint = currentPolicy.fingerprint;
  const apps = appsResult.result?.apps || [];
  const profiles = profileVerification.profiles;
  const requiredApps = appsForEdition(edition).map((required) => {
    const installed = apps.find((app) => app.bundleIdentifier === required.bundleId);
    const expectedRelease = release.apps[required.id] || release;
    return {
      ...required,
      release: expectedRelease,
      installed: installed ? { version: installed.version || "", build: installed.bundleVersion || "" } : null
    };
  });
  const obsoleteApps = apps.filter((app) => isLegacyPhoneBundleIdentifier(app.bundleIdentifier));
  const lockProfile = profiles.find((profile) => profile.identifier === PROFILE_IDENTIFIER);
  const obsoleteLauncherProfile = profiles.find((profile) => profile.identifier === LAUNCHER_PROFILE_IDENTIFIER);
  const obsoleteYouTubeWebClipProfile = profiles.find((profile) => profile.identifier === YOUTUBE_WEB_CLIP_PROFILE_IDENTIFIER);
  const receipt = await readReceipt(device.udid || device.identifier);
  const deployedEdition = receiptPhoneEdition(receipt);
  const problems = [];
  if (release.sourceFingerprint !== fingerprint.hash) problems.push("Phone-facing sources changed after the current release; bump and deploy a new phone release.");
  for (const app of requiredApps) {
    if (!app.installed) problems.push(`${app.name} is not installed.`);
    else if (app.installed.version !== app.release.version || String(app.installed.build) !== String(app.release.build)) {
      problems.push(`${app.name} is ${app.installed.version} (${app.installed.build}), expected ${app.release.version} (${app.release.build}).`);
    }
  }
  if (obsoleteApps.length) problems.push(`${OBSOLETE_APPS_PROBLEM_PREFIX} ${obsoleteApps.map((app) => app.bundleIdentifier).join(", ")}.`);
  const iosEnabled = Boolean(serverState?.state?.deviceControls?.ios?.enabled);
  if (!profileVerification.available) {
    problems.push(`Configuration-profile verification is unavailable: ${profileVerification.detail}`);
  } else {
    if (iosEnabled && !lockProfile) problems.push("The live Vigil iPhone policy is enabled locally but no Vigil lock profile is installed.");
    if (obsoleteLauncherProfile) problems.push(OBSOLETE_LAUNCHER_PROFILE_PROBLEM);
    if (obsoleteYouTubeWebClipProfile) problems.push(OBSOLETE_YOUTUBE_WEB_CLIP_PROFILE_PROBLEM);
  }
  if (!serverState) problems.push(`The Vigil server at ${selectedOptions.server} is unavailable, so live policy freshness cannot be checked.`);
  else if (!livePolicyFingerprint) problems.push("The currently generated live policy could not be resolved for a freshness check.");
  if (receipt && receipt.release?.sourceFingerprint !== release.sourceFingerprint) problems.push("The last device receipt belongs to a different implementation fingerprint.");
  if (receipt && deployedEdition !== edition) {
    problems.push(`The phone receipt is for the ${editionLabel(deployedEdition)} edition, but status selected ${editionLabel(edition)}.`);
  }
  if (receipt?.policyFingerprint && lockProfile && !profileName(lockProfile).includes(receipt.policyFingerprint.slice(0, 12))) {
    problems.push("The installed policy profile name does not match the last deployment receipt.");
  }
  problems.push(...policyFreshnessProblems({
    installedProfileName: lockProfile ? profileName(lockProfile) : "",
    receiptFingerprint: receipt?.policyFingerprint,
    livePolicyFingerprint
  }));
  problems.push(...blocklistReadinessProblems(blocklist, serverState));
  problems.push(...deployedExplicitContentPolicyProblems(receipt, explicitContentPolicy));
  problems.push(...deployedYouTubeParityScriptProblems(receipt, youtubeParityScript));
  if (edition === "enhanced") {
    problems.push(...deployedBlocklistProblems(receipt, blocklist, [URL_FILTER_APP.bundleId]));
    if (!urlFilter.ready) problems.push(`The fail-closed iOS URL Filter is not deployable: ${urlFilter.error}.`);
    else if (receipt?.urlFilter?.prefilterSha256 !== urlFilter.prefilter.sha256
      || receipt?.urlFilter?.pirDatabaseSha256 !== urlFilter.prefilter.pirDatabaseSha256
      || receipt?.urlFilter?.prefilterTag !== urlFilter.prefilter.tag) {
      problems.push("The deployment receipt does not prove the current paired URL Filter prefilter and PIR database revision.");
    }
    if (receipt && (receipt?.liveUrlFilterAudit?.status !== "running"
      || receipt?.liveUrlFilterAudit?.enabled !== true
      || receipt?.liveUrlFilterAudit?.failClosed !== true)) {
      problems.push("The deployment receipt does not prove that iOS reached a running fail-closed URL Filter state.");
    }
  }
  return { edition, release, fingerprint, blocklist, explicitContentPolicy, youtubeParityScript, urlFilter, device, requiredApps, obsoleteApps, profiles, profileVerification, lockProfile, obsoleteLauncherProfile, obsoleteYouTubeWebClipProfile, receipt, serverState, livePolicyFingerprint, policyGenerationSource: currentPolicy.source, problems };
}

function printStatus(report) {
  console.log(`Vigil ${editionLabel(report.edition)} phone ${report.release.version} (${report.release.build})`);
  console.log(`Implementation: ${report.release.sourceFingerprint === report.fingerprint.hash ? "released" : "CHANGED — release bump required"}`);
  console.log(`Device: ${report.device.name} • ${report.device.model} • iOS ${report.device.osVersion} • wired and paired`);
  console.log("Apps:");
  for (const app of report.requiredApps) {
    console.log(`- ${app.name}: ${app.installed ? `${app.installed.version} (${app.installed.build})` : "missing"} • expected ${app.release.version} (${app.release.build})`);
  }
  console.log("Profiles:");
  if (report.profileVerification.available) {
    console.log(`- Live policy: ${report.lockProfile ? profileName(report.lockProfile) : "missing"}`);
    console.log(`- Retired social launchers: ${report.obsoleteLauncherProfile ? "installed — remove with --replace-legacy" : "absent"}`);
    console.log(`- Retired YouTube Web Clip: ${report.obsoleteYouTubeWebClipProfile ? "installed — remove with --replace-legacy" : "absent"}`);
  } else {
    console.log(`- Verification unavailable: ${report.profileVerification.detail}`);
  }
  if (report.receipt?.policyFingerprint) console.log(`Last deployed policy: ${report.receipt.policyFingerprint.slice(0, 12)}`);
  if (report.livePolicyFingerprint) console.log(`Current live policy: ${report.livePolicyFingerprint.slice(0, 12)} • ${report.policyGenerationSource}`);
  printBlocklistReadiness(report.blocklist);
  console.log(report.edition === "enhanced"
    ? `Enhanced system URL Filter: ${report.urlFilter.ready ? `${report.urlFilter.prefilter.domainCount.toLocaleString("en-US")} domains • ${report.urlFilter.prefilter.tag}` : `NOT READY • ${report.urlFilter.error}`}`
    : "Enhanced system URL Filter: optional paid capability • not required by Personal edition");
  console.log(`Bundled explicit-content policy: ${report.explicitContentPolicy.sha256.slice(0, 12)} • ${report.explicitContentPolicy.bytes.toLocaleString("en-US")} bytes`);
  console.log(`Bundled YouTube parity script: ${report.youtubeParityScript.sha256.slice(0, 12)} • ${report.youtubeParityScript.bytes.toLocaleString("en-US")} bytes`);
  const signing = signingCapabilitySummary(report.receipt?.signingVariant);
  console.log(`Last deployed signing: ${signing.variant} • ${signing.mediaCapability}`);
  console.log(`Live policy source: ${report.serverState ? (report.serverState.state?.deviceControls?.ios?.enabled ? "enabled" : "disabled") : "server unavailable"}`);
  if (!report.problems.length) console.log("Status: current");
  else {
    console.log("Status: attention required");
    for (const problem of report.problems) console.log(`- ${problem}`);
  }
}

async function updatePhone(selectedOptions) {
  const edition = selectedOptions.edition;
  if (selectedOptions.noPolicy && edition === "enhanced") {
    throw new Error("--no-policy is incompatible with the Enhanced edition's fail-closed iOS URL Filter; the app and its exact managed configuration must be deployed together.");
  }
  const blocklist = await requireReadyPhoneBlocklist("update the phone");
  const urlFilter = edition === "enhanced"
    ? await requireReadyIosUrlFilter(blocklist, "update the Enhanced phone edition")
    : await iosUrlFilterReadiness(blocklist);
  let release = await readRelease(edition);
  const fingerprint = await implementationFingerprint(edition);
  if (release.sourceFingerprint !== fingerprint.hash) {
    release = await bumpRelease("patch", false, edition);
    console.log(`${editionLabel(edition)} phone inputs changed; created release ${release.version} (${release.build}).`);
  }
  const { device, developerDir, toolEnvironment } = await preparePhoneToolchain(selectedOptions.device);
  const deviceReceiptId = device.udid || device.identifier;
  const previousReceipt = await readReceipt(deviceReceiptId);
  const installedBeforeUpdate = await devicectlJson(["device", "info", "apps", "--device", device.identifier], toolEnvironment);
  const installedApps = installedBeforeUpdate.result?.apps || [];
  const socialAppIds = socialAppsNeedingUpdate(release, installedApps);
  const installedUrlFilter = installedApps.find((app) => app.bundleIdentifier === URL_FILTER_APP.bundleId);
  const includeUrlFilter = edition === "enhanced" && (
    !installedUrlFilter
    || installedUrlFilter.version !== release.version
    || String(installedUrlFilter.bundleVersion || "") !== String(release.build)
  );
  const previousEdition = receiptPhoneEdition(previousReceipt);
  if (previousReceipt && previousEdition === "enhanced" && edition === "personal" && !selectedOptions.allowEditionDowngrade) {
    throw new Error("Refusing to replace an Enhanced phone deployment with Personal edition without --allow-edition-downgrade.");
  }
  if (selectedOptions.noPolicy && previousReceipt && previousEdition !== edition) {
    throw new Error("An edition change must replace the matching configuration profile; --no-policy cannot be used.");
  }
  if (selectedOptions.noPolicy
    && previousReceipt?.release?.sourceFingerprint !== release.sourceFingerprint) {
    throw new Error("Refusing the app-only update because this release has new phone-facing sources and may require matching supervised allowlist routes. Run the normal update without --no-policy first.");
  }
  const socialUpdateLabel = socialAppIds.length
    ? socialAppIds.map((id) => `${REQUIRED_SOCIAL_APPS.find((app) => app.id === id).name} ${release.apps[id].version} (${release.apps[id].build})`).join(", ")
    : "no companion reinstall needed";
  console.log(`Updating ${device.name} to Vigil ${editionLabel(edition)} phone ${release.version} (${release.build}) without rebooting; ${socialUpdateLabel}.`);
  console.log(`Apple toolchain: ${developerDir}`);
  await buildRuntime();
  const audit = await auditFourPolicies(toolEnvironment, edition === "enhanced" ? urlFilter.service : null);
  printPolicyAudit(audit, edition);
  const build = await buildPhoneApps(release, edition, urlFilter, toolEnvironment, socialAppIds, includeUrlFilter);
  if (selectedOptions.noPolicy) {
    const extensionProblems = safariExtensionUpdateProblems(previousReceipt, build.apps);
    if (extensionProblems.length) {
      throw new Error(`Refusing the app-only update because Safari could disable the YouTube controls extension:\n- ${extensionProblems.join("\n- ")}`);
    }
  }
  const preparedPolicy = selectedOptions.noPolicy
    ? null
    : await prepareCurrentPolicy(release, selectedOptions.server, edition === "enhanced" ? urlFilter.service : null, toolEnvironment, edition);
  const obsoleteBeforeUpdate = installedApps
    .filter((app) => isLegacyPhoneBundleIdentifier(app.bundleIdentifier));
  const profileBeforeUpdate = await configurationProfileStatus(device.identifier, toolEnvironment);
  const obsoleteProfilesBeforeUpdate = profileBeforeUpdate.profiles
    .filter((profile) => OBSOLETE_CONFIGURATION_PROFILE_IDENTIFIERS.has(profile.identifier));
  let legacyProfileMigrationVerified = previousReceipt?.legacyProfileMigrationVerified === true;
  if (!profileBeforeUpdate.available && !legacyProfileMigrationVerified) {
    throw new Error(`Cannot verify that retired launcher and YouTube Web Clip profiles are absent: ${profileBeforeUpdate.detail}. The fixed YouTube app was not installed. Inspect or remove those profiles through a supported supervised-management path, then run the normal update.`);
  }
  if ((obsoleteBeforeUpdate.length || obsoleteProfilesBeforeUpdate.length) && !selectedOptions.replaceLegacy) {
    const obsoleteItems = [
      ...obsoleteBeforeUpdate.map((app) => app.bundleIdentifier),
      ...obsoleteProfilesBeforeUpdate.map((profile) => profile.identifier)
    ];
    throw new Error(`Obsolete phone apps or launcher configuration must be removed before the fixed companions can be installed. Re-run with --replace-legacy: ${obsoleteItems.join(", ")}`);
  }
  if (selectedOptions.replaceLegacy) {
    await removeObsoleteConfigurationProfiles(device.identifier, toolEnvironment);
    legacyProfileMigrationVerified = true;
  } else if (profileBeforeUpdate.available) {
    legacyProfileMigrationVerified = true;
  }
  for (const obsolete of obsoleteBeforeUpdate) {
    console.log(`Removing obsolete ${obsolete.bundleIdentifier}; its app-local data cannot be recovered after uninstall…`);
    await run("xcrun", ["devicectl", "device", "uninstall", "app", "--device", device.identifier, obsolete.bundleIdentifier], { env: toolEnvironment });
  }
  for (const app of build.apps) {
    console.log(`Installing ${app.name}…`);
    await run("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app.path], { env: toolEnvironment });
  }

  let { policyFingerprint, policyArtifactHash } = preservedPolicyReceipt(selectedOptions.noPolicy ? previousReceipt : null);
  let liveUrlFilterAudit = null;
  if (preparedPolicy) {
    ({ policyFingerprint, policyArtifactHash } = preparedPolicy);
    console.log(`Installing policy ${policyFingerprint.slice(0, 12)}…`);
    await installConfigurationProfileWhenUnlocked(device, preparedPolicy.lockPath, toolEnvironment);
    if (edition === "enhanced") {
      liveUrlFilterAudit = await verifyLiveIosUrlFilter(device.identifier, urlFilter.service, toolEnvironment);
    }
    await persistPhoneEdition(edition);
  }

  const appReceiptRecords = new Map((previousReceipt?.apps || []).map((app) => [app.bundleId, app]));
  for (const app of build.apps) {
    appReceiptRecords.set(app.bundleId, {
      name: app.name,
      bundleId: app.bundleId,
      version: (release.apps[app.id] || release).version,
      build: (release.apps[app.id] || release).build,
      sourceFingerprint: release.apps[app.id]?.sourceFingerprint || release.sourceFingerprint,
      sha256: app.sha256,
      signingCapabilities: app.signingCapabilities,
      blocklistArtifactSha256: app.blocklist?.artifactSha256 || null,
      blocklistDomainCount: app.blocklist?.domainCount || null,
      explicitContentPolicySha256: app.explicitContentPolicy?.sha256 || null,
      youtubeParityScript: app.youtubeParityScript || null,
      youtubeParityScriptSha256: app.youtubeParityScript?.sha256 || null,
      youtubeInteractionExtension: app.youtubeInteractionExtension || null,
      youtubeInteractionExtensionSha256: app.youtubeInteractionExtension?.sha256 || null
    });
  }
  const signingCapabilities = {
    ...(previousReceipt?.signingCapabilities || {}),
    ...build.signingCapabilities
  };
  await writeReceipt(deviceReceiptId, {
    schemaVersion: 2,
    edition,
    device: { identifier: device.identifier, udid: device.udid, name: device.name, model: device.model, osVersion: device.osVersion },
    release,
    policyFingerprint,
    policyArtifactHash,
    signingVariant: signingVariantForCapabilities(signingCapabilities, previousReceipt?.signingVariant || "unknown"),
    signingCapabilities,
    blocklist: build.blocklist || previousReceipt?.blocklist || null,
    explicitContentPolicy: build.explicitContentPolicy,
    urlFilter: build.urlFilter || previousReceipt?.urlFilter || null,
    liveUrlFilterAudit: liveUrlFilterAudit || previousReceipt?.liveUrlFilterAudit || null,
    legacyProfileMigrationVerified,
    apps: [...appReceiptRecords.values()],
    deployedAt: new Date().toISOString(),
    rebooted: false
  });
  const report = await phoneStatus(selectedOptions, device, toolEnvironment, edition);
  printStatus(report);
  if (report.problems.length) process.exitCode = 1;
}

function printBlocklistReadiness(readiness) {
  if (!readiness?.ready) {
    console.log(`Phone adult blocklist: NOT READY • ${readiness?.error || "unknown artifact error"}`);
    return;
  }
  const source = readiness.source?.label || readiness.source?.id || "unknown source";
  console.log(`Phone adult blocklist: ${readiness.domainCount.toLocaleString("en-US")} domains • ${readiness.snapshotHash.slice(0, 12)} snapshot • ${readiness.artifactSha256.slice(0, 12)} artifact • ${source}`);
}

export function signingCapabilitySummary(variant) {
  if (variant === "full-capabilities") {
    return { variant, mediaCapability: "Sensitive Content Analysis entitled (conceal unclassified media)" };
  }
  if (variant === "personal-team-conservative") {
    return { variant, mediaCapability: "Sensitive Content Analysis unavailable (reveal unclassified media)" };
  }
  if (variant === "mixed-capabilities") {
    return { variant, mediaCapability: "capabilities differ by app; inspect the deployment receipt" };
  }
  return { variant: "unknown", mediaCapability: "no verified signing-capability receipt" };
}

async function buildRuntime() {
  console.log("Building current Vigil runtime for policy audit…");
  await run("npm", ["run", "build"], { cwd: ROOT });
}

async function auditFourPolicies(toolEnvironment, urlFilterService) {
  const defaultsModule = await importFresh(join(ROOT, "dist", "runtime", "src", "defaults.js"));
  const policyModule = await importFresh(join(ROOT, "dist", "runtime", "src", "policy.js"));
  const profilesModule = await importFresh(join(ROOT, "dist", "runtime", "src", "iosProfiles.js"));
  const now = new Date();
  const levels = [
    { id: "normal", title: "Normal", mode: "normal", lockLevel: "light" },
    { id: defaultsModule.SOFT_BLOCK_PROFILE_ID, title: "Soft Lock", mode: "focus", lockLevel: "light" },
    { id: defaultsModule.BRICK_MODE_PROFILE_ID, title: "Full Brick", mode: "brick", lockLevel: "deep" },
    { id: defaultsModule.PANIC_LOCK_PROFILE_ID, title: "Panic", mode: "panic", lockLevel: "deep", panic: true }
  ];
  const auditDir = join(ROOT, "data", "ios-phone-policy-audit");
  await mkdir(auditDir, { recursive: true });
  const output = [];
  for (const level of levels) {
    const state = defaultsModule.defaultState();
    state.deviceControls.ios.enabled = true;
    state.deviceControls.ios.hardenRemoval = false;
    if (level.id === "normal") {
      state.settings.baselineProfileId = "normal";
    } else if (level.panic) {
      state.panicLock = {
        id: "phone-audit-panic",
        title: "Panic Lockout",
        mode: "panic",
        profileId: defaultsModule.PANIC_LOCK_PROFILE_ID,
        lockLevel: "deep",
        startedAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 3 * 60 * 1000).toISOString(),
        canEndEarly: false,
        commitmentLock: true,
        emergencyUnlocksAllowed: false,
        source: "panic",
        fullLockout: true,
        profileSnapshot: policyModule.panicLockProfile()
      };
    } else {
      state.activeSessions.phone = {
        id: `phone-audit-${level.id}`,
        title: level.title,
        mode: level.mode,
        profileId: level.id,
        lockLevel: level.lockLevel,
        startedAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        canEndEarly: level.id !== defaultsModule.BRICK_MODE_PROFILE_ID,
        source: "manual",
        deviceTargets: ["phone"],
        profileSnapshot: policyModule.profileById(state, level.id)
      };
    }
    const profile = profilesModule.buildIosConfigurationProfile(state, now, { urlFilter: urlFilterService });
    const summary = profilesModule.iosProfileSummary(state, now);
    const path = join(auditDir, `${level.id}.mobileconfig`);
    await writeFile(path, profile, { mode: 0o600 });
    const signedPath = join(auditDir, `${level.id}.signed.mobileconfig`);
    await signProfile(profile, signedPath);
    await runQuiet("xcrun", ["devicectl", "device", "profile", "validate", "--type", "configuration", signedPath], { env: toolEnvironment });
    output.push({
      id: level.id,
      title: level.title,
      sha256: sha256(profile),
      apps: summary.profile.appBundleCount,
      deniedUrls: summary.profile.deniedUrlCount,
      allowedUrls: summary.profile.allowedUrlCount,
      focusedSocial: summary.profile.focusedSocialEnforcementActive
    });
  }
  return output;
}

function printPolicyAudit(audit, edition) {
  console.log(`${editionLabel(edition)} four-level policy audit:`);
  for (const level of audit) {
    console.log(`- ${level.title}: ${level.apps} apps • ${level.deniedUrls} denied URLs • ${level.allowedUrls} allowed URLs • ${level.sha256.slice(0, 12)}`);
  }
}

async function buildPhoneApps(
  release,
  edition,
  urlFilter,
  toolEnvironment = process.env,
  socialAppIds = REQUIRED_SOCIAL_APPS.map((app) => app.id),
  includeUrlFilter = edition === "enhanced"
) {
  const selectedSocialAppIds = new Set(socialAppIds);
  const releaseLabel = REQUIRED_SOCIAL_APPS
    .map((app) => `${app.id}-${release.apps[app.id].version}-${release.apps[app.id].build}`)
    .join("-");
  const root = join(ROOT, "data", "ios-phone-build", `${edition}-${releaseLabel}`);
  const personalTeamEntitlements = join(ROOT, "ios", "Shared", "PersonalTeam.entitlements");
  await mkdir(root, { recursive: true });
  const blocklist = await requireReadyPhoneBlocklist("build a Release phone app");
  await runQuiet(process.execPath, [join(ROOT, "dist", "runtime", "scripts", "generate-ios-content-policy.mjs")]);
  const explicitContentPolicy = await expectedExplicitContentPolicy();
  const environment = { ...toolEnvironment, VIGIL_PHONE_BLOCKLIST: blocklist.path };
  let reducedEntitlements = edition === "personal";
  const apps = [];
  for (const social of REQUIRED_SOCIAL_APPS) {
    if (!selectedSocialAppIds.has(social.id)) continue;
    const appRelease = release.apps[social.id];
    const derived = join(root, social.id);
    console.log(`Building ${social.name} companion…`);
    const socialArguments = [
      "-project", "ios/VigilSocial/VigilSocial.xcodeproj",
      "-scheme", social.buildScheme,
      "-configuration", "Release",
      "-destination", "generic/platform=iOS",
      "-derivedDataPath", derived,
      "-allowProvisioningUpdates",
      "build",
      `VIGIL_APP_BUNDLE_IDENTIFIER=${social.bundleId}`,
      `VIGIL_SERVICE=${social.service}`,
      `SOCIAL_APP_NAME=${social.name}`,
      `SOCIAL_APP_ICON_SET=${social.appIconSet}`,
      `SOCIAL_URL_SCHEME=${social.scheme}`,
      `MARKETING_VERSION=${appRelease.version}`,
      `CURRENT_PROJECT_VERSION=${appRelease.build}`
    ];
    if (reducedEntitlements) {
      socialArguments.push(
        `CODE_SIGN_ENTITLEMENTS=${personalTeamEntitlements}`,
        "VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified"
      );
    }
    try {
      await run("xcodebuild", socialArguments, { cwd: ROOT, env: environment });
    } catch (error) {
      if (reducedEntitlements) throw error;
      reducedEntitlements = true;
      console.warn("Full Apple capabilities are unavailable for the fixed social companions; retrying with the conservative Personal Team entitlement set.");
      await run("xcodebuild", [
        ...socialArguments,
        `CODE_SIGN_ENTITLEMENTS=${personalTeamEntitlements}`,
        "VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified"
      ], { cwd: ROOT, env: environment });
    }
    const path = join(derived, "Build", "Products", "Release-iphoneos", "VigilSocial.app");
    const bundledExplicitContentPolicy = await verifyBundledExplicitContentPolicy(path, explicitContentPolicy);
    const youtubeParityScript = social.id === "youtube"
      ? await verifyBundledYouTubeParityScript(path)
      : null;
    const youtubeInteractionExtension = social.id === "instagram"
      ? await verifyBundledYouTubeInteractionExtension(path, social.bundleId)
      : null;
    const signingCapabilities = await signedAppCapabilities(path);
    if (!reducedEntitlements && !signingCapabilities.sensitiveContentAnalysis) {
      throw new Error(`${social.name} built without the requested Sensitive Content Analysis entitlement; refusing to label it as a full-capability build.`);
    }
    apps.push({
      ...social,
      path,
      blocklist: null,
      explicitContentPolicy: bundledExplicitContentPolicy,
      youtubeParityScript,
      youtubeInteractionExtension,
      signingCapabilities,
      sha256: await hashAppBundle(path)
    });
  }
  let filterPrefilter = null;
  if (includeUrlFilter) {
    if (!urlFilter?.ready) throw new Error("Enhanced edition requires a ready fail-closed iOS URL Filter.");
    const filterDerived = join(root, URL_FILTER_APP.id);
    console.log("Building Enhanced fail-closed URL Filter…");
    await run("xcodebuild", [
      "-project", "ios/VigilURLFilter/VigilURLFilter.xcodeproj",
      "-scheme", "VigilURLFilterHost",
      "-configuration", "Release",
      "-destination", "generic/platform=iOS",
      "-derivedDataPath", filterDerived,
      "-allowProvisioningUpdates",
      "build",
      `MARKETING_VERSION=${release.version}`,
      `CURRENT_PROJECT_VERSION=${release.build}`
    ], {
      cwd: ROOT,
      env: {
        ...environment,
        VIGIL_URL_FILTER_PREFILTER: urlFilter.prefilter.path
      }
    });
    const filterPath = join(filterDerived, "Build", "Products", "Release-iphoneos", "VigilURLFilterHost.app");
    const filterBlocklist = await verifyBundledPhoneBlocklist(
      join(filterPath, "Extensions", "VigilURLFilterControl.appex"),
      blocklist
    );
    filterPrefilter = await verifyBundledUrlFilterPrefilter(filterPath, urlFilter);
    const filterCapabilities = await signedUrlFilterCapabilities(filterPath);
    if (!filterCapabilities.urlFilterProvider) {
      throw new Error("Vigil URL Filter built without Apple's url-filter-provider entitlement; refusing to install an inert app.");
    }
    apps.push({
      ...URL_FILTER_APP,
      path: filterPath,
      blocklist: filterBlocklist,
      explicitContentPolicy: null,
      signingCapabilities: filterCapabilities,
      sha256: await hashAppBundle(filterPath),
      urlFilter: filterPrefilter
    });
  }
  return {
    apps,
    signingCapabilities: Object.fromEntries(apps.map((app) => [app.id, app.signingCapabilities])),
    explicitContentPolicy,
    urlFilter: includeUrlFilter ? {
      prefilterSha256: filterPrefilter.sha256,
      prefilterTag: filterPrefilter.tag,
      pirDatabaseRevision: filterPrefilter.pirDatabaseRevision,
      pirDatabaseSha256: filterPrefilter.pirDatabaseSha256,
      domainCount: filterPrefilter.domainCount,
      serviceURL: urlFilter.service.pirServerURL
    } : null,
    blocklist: {
      domainCount: blocklist.domainCount,
      snapshotHash: blocklist.snapshotHash,
      artifactSha256: blocklist.artifactSha256,
      bytes: blocklist.bytes,
      source: blocklist.source
    }
  };
}

async function expectedExplicitContentPolicy() {
  const bytes = await readFile(EXPLICIT_CONTENT_POLICY_PATH);
  let policy;
  try {
    policy = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${EXPLICIT_CONTENT_POLICY_PATH} is not valid JSON.`);
  }
  if (policy?.schemaVersion !== 1
    || !Array.isArray(policy?.phrases)
    || !Array.isArray(policy?.terms)
    || !Array.isArray(policy?.contextualRules)) {
    throw new Error(`${EXPLICIT_CONTENT_POLICY_PATH} does not satisfy the generated classifier policy contract.`);
  }
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

async function expectedYouTubeParityScript() {
  const path = join(
    ROOT,
    "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Resources",
    YOUTUBE_INTERACTION_EXTENSION.scriptName
  );
  const bytes = await readFile(path);
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

async function verifyBundledExplicitContentPolicy(appPath, expected) {
  const resourcePath = join(appPath, EXPLICIT_CONTENT_POLICY_RESOURCE);
  if (!await isFile(resourcePath)) {
    throw new Error(`${basename(appPath)} does not contain ${EXPLICIT_CONTENT_POLICY_RESOURCE}; refusing to ship classifier rules that are only present in the source fingerprint.`);
  }
  const bytes = await readFile(resourcePath);
  const actual = { sha256: sha256(bytes), bytes: bytes.byteLength };
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`${basename(appPath)} contains a stale or substituted ${EXPLICIT_CONTENT_POLICY_RESOURCE}.`);
  }
  return actual;
}

async function verifyBundledYouTubeParityScript(appPath) {
  const sourcePath = join(
    ROOT,
    "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Resources",
    YOUTUBE_INTERACTION_EXTENSION.scriptName
  );
  const bundledPath = join(appPath, YOUTUBE_INTERACTION_EXTENSION.scriptName);
  if (!await isFile(bundledPath)) {
    throw new Error(`${basename(appPath)} does not contain the app-root ${YOUTUBE_INTERACTION_EXTENSION.scriptName}; refusing to ship a YouTube surface without its Shorts and miniplayer guard.`);
  }
  const [sourceBytes, bundledBytes] = await Promise.all([
    readFile(sourcePath),
    readFile(bundledPath)
  ]);
  if (!sourceBytes.equals(bundledBytes)) {
    throw new Error(`${basename(appPath)} contains a stale or substituted app-root ${YOUTUBE_INTERACTION_EXTENSION.scriptName}.`);
  }
  return { sha256: sha256(bundledBytes), bytes: bundledBytes.byteLength };
}

async function verifyBundledYouTubeInteractionExtension(appPath, parentBundleIdentifier) {
  const extensionPath = join(appPath, "PlugIns", YOUTUBE_INTERACTION_EXTENSION.productName);
  const infoPath = join(extensionPath, "Info.plist");
  const manifestPath = join(extensionPath, YOUTUBE_INTERACTION_EXTENSION.manifestName);
  const scriptPath = join(extensionPath, YOUTUBE_INTERACTION_EXTENSION.scriptName);
  for (const path of [infoPath, manifestPath, scriptPath]) {
    if (!await isFile(path)) {
      throw new Error(`${basename(appPath)} does not contain the complete Vigil YouTube interaction extension.`);
    }
  }

  const { stdout: identifierOutput } = await execFileAsync("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPath
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const expectedIdentifier = `${parentBundleIdentifier}${YOUTUBE_INTERACTION_EXTENSION.bundleIdentifierSuffix}`;
  if (identifierOutput.trim() !== expectedIdentifier) {
    throw new Error(`${YOUTUBE_INTERACTION_EXTENSION.productName} is not contained by ${parentBundleIdentifier}.`);
  }

  const manifestBytes = await readFile(manifestPath);
  const scriptBytes = await readFile(scriptPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`${YOUTUBE_INTERACTION_EXTENSION.manifestName} is not valid JSON.`);
  }
  const expectedHosts = ["https://youtube.com/*", "https://www.youtube.com/*", "https://m.youtube.com/*"];
  const scripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [];
  const contractValid = JSON.stringify(manifest?.host_permissions) === JSON.stringify(expectedHosts)
    && scripts.length === 1
    && JSON.stringify(scripts[0]?.matches) === JSON.stringify(expectedHosts)
    && JSON.stringify(scripts[0]?.js) === JSON.stringify([YOUTUBE_INTERACTION_EXTENSION.scriptName])
    && scripts[0]?.all_frames === false;
  const source = scriptBytes.toString("utf8");
  if (!contractValid
    || !source.includes("data-vigil-youtube-miniplayer")
    || !source.includes("recoverFromShorts")
    || source.includes("accounts.google.com")) {
    throw new Error("The bundled Vigil YouTube interaction extension does not satisfy its narrow YouTube-only parity contract.");
  }
  return {
    bundleIdentifier: expectedIdentifier,
    sha256: sha256(Buffer.concat([manifestBytes, scriptBytes])),
    manifestVersion: manifest.manifest_version,
    hostPermissions: [...manifest.host_permissions],
    contentScriptMatches: [...scripts[0].matches],
    permissions: Array.isArray(manifest.permissions) ? [...manifest.permissions].sort() : []
  };
}

export function safariExtensionUpdateProblems(previousReceipt, nextApps) {
  const maintenance = "Use the explicit offline Safari-extension maintenance procedure before installing this app build.";
  const previousApp = previousReceipt?.apps?.find((app) => app.bundleId === "tech.caseline.vigil.instagram") || null;
  const nextApp = nextApps?.find((app) => app.bundleId === "tech.caseline.vigil.instagram") || null;
  const previous = previousApp?.youtubeInteractionExtension || null;
  const previousHash = previous?.sha256 || previousApp?.youtubeInteractionExtensionSha256 || "";
  if (!nextApp) return [];
  const next = nextApp?.youtubeInteractionExtension || null;

  if (!next) {
    return previousHash ? [`The installed app receipt contains Vigil YouTube Controls, but the proposed app build does not. ${maintenance}`] : [];
  }
  if (!previousHash) {
    return [`The proposed build adds Vigil YouTube Controls to a phone whose receipt does not contain it. ${maintenance}`];
  }
  if (!previous) {
    return previousHash === next.sha256
      ? []
      : [`The existing receipt predates the extension permission contract and the extension bytes changed, so an in-place update cannot be proven safe. ${maintenance}`];
  }

  const problems = [];
  if (previous.bundleIdentifier !== next.bundleIdentifier) {
    problems.push(`The YouTube controls extension bundle identifier changed from ${previous.bundleIdentifier} to ${next.bundleIdentifier}. ${maintenance}`);
  }
  if (previous.manifestVersion !== next.manifestVersion) {
    problems.push(`The YouTube controls manifest version changed from ${previous.manifestVersion} to ${next.manifestVersion}. ${maintenance}`);
  }
  for (const [label, key] of [
    ["host permissions", "hostPermissions"],
    ["content-script matches", "contentScriptMatches"],
    ["extension permissions", "permissions"]
  ]) {
    const before = [...(previous[key] || [])].sort();
    const after = [...(next[key] || [])].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      problems.push(`The YouTube controls ${label} changed (${before.join(", ") || "none"} -> ${after.join(", ") || "none"}). ${maintenance}`);
    }
  }
  return problems;
}

async function verifyBundledPhoneBlocklist(appPath, expected) {
  const resourcePath = join(appPath, PHONE_BLOCKLIST_RESOURCE);
  if (!await isFile(resourcePath)) {
    throw new Error(`${basename(appPath)} does not contain ${PHONE_BLOCKLIST_RESOURCE}; refusing to ship a release whose fingerprint promises an unused blocklist.`);
  }
  const actual = await phoneBlocklistReadiness(resourcePath);
  if (!actual.ready) throw new Error(`${basename(appPath)} contains an invalid ${PHONE_BLOCKLIST_RESOURCE}: ${actual.error}.`);
  if (actual.artifactSha256 !== expected.artifactSha256
    || actual.snapshotHash !== expected.snapshotHash
    || actual.domainCount !== expected.domainCount) {
    throw new Error(`${basename(appPath)} contains a stale or substituted ${PHONE_BLOCKLIST_RESOURCE}.`);
  }
  return actual;
}

async function verifyBundledUrlFilterPrefilter(appPath, expected) {
  const resourcePath = join(appPath, "Extensions", "VigilURLFilterControl.appex", URL_FILTER_PREFILTER_RESOURCE);
  if (!await isFile(resourcePath)) {
    throw new Error(`${basename(appPath)} does not contain the required ${URL_FILTER_PREFILTER_RESOURCE}.`);
  }
  const bytes = await readFile(resourcePath);
  if (sha256(bytes) !== expected.prefilter.sha256) {
    throw new Error(`${basename(appPath)} contains a stale or substituted URL Filter prefilter.`);
  }
  return { ...expected.prefilter };
}

async function signedUrlFilterCapabilities(appPath) {
  const extensionPath = join(appPath, "Extensions", "VigilURLFilterControl.appex");
  const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "--entitlements", ":-", extensionPath], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const entitlements = `${stdout || ""}\n${stderr || ""}`;
  return {
    sensitiveContentAnalysis: false,
    urlFilterProvider: /<string>url-filter-provider<\/string>/u.test(entitlements)
  };
}

async function verifyLiveIosUrlFilter(deviceIdentifier, service, toolEnvironment) {
  const directory = await mkdtemp(join(tmpdir(), "vigil-live-url-filter-"));
  const destination = join(directory, "vigil-url-filter-audit.json");
  const expectedTokenHash = sha256(Buffer.from(service.authenticationToken, "utf8"));
  let lastDetail = "the host app did not publish a status audit";
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await runQuiet("xcrun", ["devicectl", "device", "process", "launch", "--device", deviceIdentifier, "--terminate-existing", URL_FILTER_APP.bundleId], { env: toolEnvironment });
      await rm(destination, { force: true });
      try {
        await runQuiet("xcrun", ["devicectl", "device", "copy", "from", "--device", deviceIdentifier, "--source", "Documents/vigil-url-filter-audit.json", "--destination", destination, "--domain-type", "appDataContainer", "--domain-identifier", URL_FILTER_APP.bundleId], { env: toolEnvironment });
        const audit = JSON.parse(await readFile(destination, "utf8"));
        const matches = audit?.status === "running"
          && audit?.enabled === true
          && audit?.failClosed === true
          && audit?.prefilterFetchInterval === service.prefilterFetchIntervalSeconds
          && audit?.pirServerURL === service.pirServerURL
          && audit?.privacyPassIssuerURL === service.privacyPassIssuerURL
          && audit?.authenticationTokenSha256 === expectedTokenHash
          && audit?.controlProviderBundleIdentifier === service.controlProviderBundleIdentifier;
        if (matches) return audit;
        lastDetail = `status=${audit?.status || "unknown"}, enabled=${String(audit?.enabled)}, failClosed=${String(audit?.failClosed)}, lastError=${audit?.lastDisconnectError || "none"}`;
      } catch (error) {
        lastDetail = error?.message || String(error);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  throw new Error(`The installed iOS URL Filter did not reach an exact running fail-closed state: ${lastDetail}`);
}

async function installConfigurationProfileWhenUnlocked(device, profilePath, toolEnvironment, timeoutMilliseconds = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let announcedLocked = false;
  const supervisorKeybagPath = await existingSupervisorKeybagPath();
  let useProtectedSupervisorInstall = Boolean(device.udid && supervisorKeybagPath);
  while (Date.now() < deadline) {
    try {
      const command = useProtectedSupervisorInstall ? process.execPath : "xcrun";
      const args = useProtectedSupervisorInstall
        ? [
            APPLY_USB_PROFILE_SCRIPT,
            "--profile", profilePath,
            "--udid", device.udid,
            "--supervisor-keybag", supervisorKeybagPath
          ]
        : [
            "devicectl", "device", "profile", "install",
            "--device", device.identifier,
            profilePath,
            "--type", "configuration",
            "--replace-existing"
          ];
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: ROOT,
        env: toolEnvironment,
        timeout: useProtectedSupervisorInstall ? 150_000 : 30_000,
        maxBuffer: 4 * 1024 * 1024
      });
      const detail = `${stdout || ""}${stderr || ""}`.trim();
      if (detail) console.log(detail);
      return;
    } catch (error) {
      const detail = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || error}`;
      if (useProtectedSupervisorInstall && /paired over USB but is not supervised/iu.test(detail)) {
        useProtectedSupervisorInstall = false;
        console.log("The iPhone is not supervised, so iOS will transfer the profile for confirmation in Settings.");
        continue;
      }
      if (!/device is locked|MCInstallationErrorDomain error 4009|ProfileError: invalid response \{'Status': 'NotNow'\}/iu.test(detail)) {
        throw new Error(`Configuration-profile installation failed: ${detail.trim()}`, { cause: error });
      }
      if (!announcedLocked) {
        console.log("The iPhone is locked. Unlock it and leave its screen awake; Vigil will retry the profile without rebuilding.");
        announcedLocked = true;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  }
  throw new Error("Timed out waiting for the iPhone to remain unlocked long enough to install the protected Vigil profile.");
}

async function existingSupervisorKeybagPath() {
  const candidates = [
    String(process.env.VIGIL_SUPERVISOR_KEYBAG || "").trim(),
    process.env.VIGIL_DATA_DIR ? join(process.env.VIGIL_DATA_DIR, "vigil-supervisor.keybag") : "",
    join(ROOT, "data", "vigil-supervisor.keybag")
  ].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    const details = await stat(path).catch(() => null);
    if (details?.isFile() && details.size > 0) return path;
  }
  return "";
}

async function signedAppCapabilities(appPath) {
  const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "--entitlements", ":-", appPath], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const entitlements = `${stdout || ""}\n${stderr || ""}`;
  return {
    sensitiveContentAnalysis: /<key>com\.apple\.developer\.sensitivecontentanalysis\.client<\/key>\s*<true\s*\/>/u.test(entitlements)
  };
}

async function hashAppBundle(root) {
  const files = await filesBelow(root, () => true);
  const digest = createHash("sha256");
  for (const path of files.sort()) digest.update(relative(root, path)).update("\0").update(await readFile(path));
  return digest.digest("hex");
}

async function stampProfile(profile, displayName) {
  const dir = await mkdtemp(join(tmpdir(), "vigil-profile-stamp-"));
  try {
    const path = join(dir, "profile.mobileconfig");
    await writeFile(path, profile, { mode: 0o600 });
    await execFileAsync("/usr/bin/plutil", ["-replace", "PayloadDisplayName", "-string", displayName, path]);
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function signProfile(profile, outputPath) {
  const identity = await profileSigningIdentity();
  const dir = await mkdtemp(join(tmpdir(), "vigil-profile-sign-"));
  const temporaryOutput = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const inputPath = join(dir, "unsigned.mobileconfig");
    await writeFile(inputPath, profile, { mode: 0o600 });
    await execFileAsync("/usr/bin/security", ["cms", "-S", "-N", identity, "-i", inputPath, "-o", temporaryOutput], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    await chmod(temporaryOutput, 0o600);
    await rename(temporaryOutput, outputPath);
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

async function profileSigningIdentity() {
  const requested = String(process.env.VIGIL_IOS_PROFILE_SIGNING_IDENTITY || "").trim();
  if (requested) return requested;
  const { stdout } = await execFileAsync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const match = stdout.match(/^\s*\d+\)\s+[A-Fa-f0-9]+\s+"([^"]+)"/m);
  if (!match) {
    throw new Error("A signing identity is required for Xcode's configuration-profile validation. Set VIGIL_IOS_PROFILE_SIGNING_IDENTITY.");
  }
  return match[1];
}

async function prepareCurrentPolicy(release, server, urlFilterService, toolEnvironment, edition) {
  const profile = await buildCurrentPolicyFromLiveState(server, AbortSignal.timeout(5000), null, urlFilterService);
  const policyFingerprint = sha256(profile);
  const stamped = await stampProfile(profile, `Vigil iPhone Lock • ${editionLabel(edition)} • ${release.version} (${release.build}) • ${policyFingerprint.slice(0, 12)}`);
  const policyArtifactHash = sha256(stamped);
  const profileDir = join(ROOT, "data", "ios-phone-profiles");
  await mkdir(profileDir, { recursive: true });
  const lockPath = join(profileDir, "vigil-iphone-lock.mobileconfig");
  await signProfile(stamped, lockPath);
  await run("xcrun", ["devicectl", "device", "profile", "validate", "--type", "configuration", lockPath], { env: toolEnvironment });
  return { lockPath, policyFingerprint, policyArtifactHash };
}

async function buildCurrentPolicyFromLiveState(server, signal, suppliedServerState = null, urlFilterService = null) {
  const serverState = suppliedServerState || await downloadServerState(server, signal);
  const state = structuredClone(serverState.state);
  const ios = state?.deviceControls?.ios;
  if (!ios || typeof ios !== "object") throw new Error("Vigil live state does not contain iPhone policy settings.");

  if (ios.hardenRemoval && ios.removalPasswordSet !== true) {
    throw new Error("Vigil's hardened iPhone profile has no persisted removal password; refusing to generate an unrecoverable profile.");
  }
  if (ios.removalPasswordSet === true) {
    let removalPassword;
    try {
      const runningProfile = await downloadPolicy(server, signal);
      const plistModule = await importFresh(join(ROOT, "dist", "runtime", "src", "plist.js"));
      removalPassword = removalPasswordFromProfile(plistModule.parsePlist(runningProfile.toString("utf8")));
    } catch {
      removalPassword = await localIosRemovalPassword();
    }
    if (!removalPassword) throw new Error("The running Vigil profile did not expose its expected removal-password payload.");
    ios.removalPassword = removalPassword;
  }

  const profilesModule = await importFresh(join(ROOT, "dist", "runtime", "src", "iosProfiles.js"));
  return Buffer.from(profilesModule.buildIosConfigurationProfile(
    state,
    new Date(),
    urlFilterService ? { urlFilter: urlFilterService } : {}
  ));
}

async function localIosRemovalPassword() {
  const candidates = [
    process.env.VIGIL_STATE_PATH,
    process.env.VIGIL_DATA_DIR ? join(process.env.VIGIL_DATA_DIR, "state.json") : "",
    join(homedir(), "Library", "Application Support", "Vigil", "state.json")
  ].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      const password = state?.deviceControls?.ios?.removalPassword;
      if (typeof password === "string" && password.length >= 8) return password;
    } catch {
      // Try the next local state path without exposing protected profile data.
    }
  }
  return "";
}

export function removalPasswordFromProfile(profile) {
  const payloads = Array.isArray(profile?.PayloadContent) ? profile.PayloadContent : [];
  const removalPayload = payloads.find((payload) => payload?.PayloadType === "com.apple.profileRemovalPassword");
  return typeof removalPayload?.RemovalPassword === "string" ? removalPayload.RemovalPassword : "";
}

async function downloadPolicy(server, signal) {
  const response = await fetch(`${server}/api/devices/ios/profile.mobileconfig`, {
    headers: { "x-vigil-intent": "vigil-app" },
    signal
  });
  if (!response.ok) throw new Error(`Vigil policy download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadServerState(server, signal) {
  const response = await fetch(`${server}/api/state`, {
    headers: { "x-vigil-intent": "vigil-app" },
    signal
  });
  if (!response.ok) throw new Error(`Vigil state download failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.state || typeof payload.state !== "object") throw new Error("Vigil state response is missing its state object.");
  return payload;
}

async function fetchServerState(server) {
  try {
    return await downloadServerState(server, AbortSignal.timeout(3000));
  } catch {
    return null;
  }
}

async function currentPolicyFingerprint(server, serverState, { allowCurrentRuntime, urlFilterService }) {
  if (allowCurrentRuntime && serverState) {
    try {
      const profile = await buildCurrentPolicyFromLiveState(server, AbortSignal.timeout(3000), serverState, urlFilterService);
      return { fingerprint: sha256(profile), source: "current source + live state" };
    } catch {
      return { fingerprint: "", source: "exact generation failed" };
    }
  }
  return { fingerprint: "", source: "exact generation unavailable" };
}

async function prepareAuditToolchain() {
  const selected = await selectDeveloperDirectory();
  return {
    developerDir: selected.developerDir,
    toolEnvironment: { ...process.env, DEVELOPER_DIR: selected.developerDir }
  };
}

async function preparePhoneToolchain(requested) {
  const selected = await selectDeveloperDirectory();
  const toolEnvironment = { ...process.env, DEVELOPER_DIR: selected.developerDir };
  const device = await resolveDevice(requested, toolEnvironment);
  if (!iosSdkSupportsDevice(selected.iosSdk, device.osVersion)) {
    throw new Error(`The newest installed iOS SDK is ${selected.iosSdk}, but the connected phone runs iOS ${device.osVersion}. Install a matching Xcode platform.`);
  }
  return { device, developerDir: selected.developerDir, toolEnvironment };
}

export function iosSdkSupportsDevice(iosSdk, deviceOsVersion) {
  const targetMajor = Number.parseInt(String(deviceOsVersion).split(".")[0] || "0", 10);
  return !targetMajor || Math.floor(Number(iosSdk)) >= targetMajor;
}

async function resolveDevice(requested, toolEnvironment) {
  const result = await devicectlJson(["list", "devices"], toolEnvironment);
  const devices = (result.result?.devices || []).filter((device) => {
    const hardware = device.properties?.hardware || device.hardwareProperties || {};
    const connection = device.properties?.connection || device.connectionProperties || {};
    return hardware.deviceType === "iPhone" && hardware.reality === "physical" && connection.pairingState === "paired";
  });
  const device = requested
    ? devices.find((item) => [item.identifier, item.properties?.hardware?.udid, item.hardwareProperties?.udid, item.properties?.state?.name, item.deviceProperties?.name].includes(requested))
    : devices.length === 1 ? devices[0] : null;
  if (!device) {
    if (requested) throw new Error(`Paired iPhone not found: ${requested}`);
    if (!devices.length) throw new Error("No paired physical iPhone is visible. Plug it in, unlock it, and trust this Mac.");
    throw new Error(`More than one paired iPhone is visible; pass --device. Candidates: ${devices.map((item) => item.identifier).join(", ")}`);
  }
  const hardware = device.properties?.hardware || device.hardwareProperties || {};
  const software = device.properties?.software || device.deviceProperties || {};
  const state = device.properties?.state || device.deviceProperties || {};
  return {
    identifier: device.identifier,
    udid: hardware.udid || "",
    name: state.name || "iPhone",
    model: hardware.marketingName || hardware.productType || "iPhone",
    osVersion: software.osVersionNumber?.stringValue || software.osVersionNumber || "unknown"
  };
}

async function selectDeveloperDirectory() {
  const requested = String(process.env.DEVELOPER_DIR || "").trim();
  const candidates = [];
  if (requested) candidates.push(resolve(requested));
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["-p"], { timeout: 5000 });
    candidates.push(stdout.trim());
  } catch {
    // Continue with installed Xcode applications.
  }
  try {
    for (const entry of await readdir("/Applications", { withFileTypes: true })) {
      if (entry.isDirectory() && /^Xcode.*\.app$/u.test(entry.name)) {
        candidates.push(join("/Applications", entry.name, "Contents", "Developer"));
      }
    }
  } catch {
    // The explicit and selected developer directories may still be usable.
  }
  const usable = [];
  for (const path of [...new Set(candidates.filter(Boolean))]) {
    const xcodebuild = join(path, "usr", "bin", "xcodebuild");
    if (!await isFile(xcodebuild)) continue;
    try {
      const { stdout } = await execFileAsync(xcodebuild, ["-showsdks"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      const versions = [...stdout.matchAll(/-sdk iphoneos(\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]));
      const iosSdk = versions.length ? Math.max(...versions) : 0;
      usable.push({ developerDir: path, iosSdk });
    } catch {
      // Ignore incomplete Xcode installations.
    }
  }
  usable.sort((left, right) => right.iosSdk - left.iosSdk);
  const selected = usable[0];
  if (!selected) throw new Error("No usable Xcode iOS SDK is installed.");
  return selected;
}

async function devicectlJson(args, toolEnvironment) {
  const { stdout } = await execFileAsync("xcrun", ["devicectl", ...args, "--json-output", "-"], {
    env: toolEnvironment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000
  });
  return JSON.parse(stdout);
}

async function configurationProfileStatus(deviceIdentifier, toolEnvironment) {
  try {
    const result = await devicectlJson(["device", "profile", "list", "--device", deviceIdentifier, "--type", "configuration"], toolEnvironment);
    return {
      available: true,
      detail: "",
      profiles: result.result?.configurationProfiles || []
    };
  } catch (error) {
    const detail = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
    if (!isUnsupportedConfigurationProfileError(detail)) {
      throw error;
    }
    return {
      available: false,
      detail: "CoreDevice does not support configuration-profile inspection for this device.",
      profiles: []
    };
  }
}

async function removeObsoleteConfigurationProfiles(deviceIdentifier, toolEnvironment) {
  for (const profileIdentifier of OBSOLETE_CONFIGURATION_PROFILE_IDENTIFIERS) {
    try {
      await execFileAsync("xcrun", [
        "devicectl", "device", "profile", "remove",
        "--device", deviceIdentifier,
        profileIdentifier,
        "--type", "configuration",
        "--force-removal"
      ], {
        env: toolEnvironment,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000
      });
      console.log(`Removed obsolete configuration profile ${profileIdentifier}.`);
    } catch (error) {
      const detail = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
      if (isMissingConfigurationProfileError(detail)) continue;
      if (isUnsupportedConfigurationProfileError(detail)) {
        throw new Error(`Cannot verify removal of ${profileIdentifier}: CoreDevice does not support configuration-profile management for this device. The fixed YouTube app was not installed; remove the retired profile through a supported supervised-management path and rerun status before updating.`, { cause: error });
      }
      throw error;
    }
  }
  const verification = await configurationProfileStatus(deviceIdentifier, toolEnvironment);
  if (!verification.available) {
    throw new Error(`Cannot verify retired-profile removal: ${verification.detail}. The fixed YouTube app was not installed.`);
  }
  const remaining = verification.profiles
    .filter((profile) => OBSOLETE_CONFIGURATION_PROFILE_IDENTIFIERS.has(profile.identifier))
    .map((profile) => profile.identifier);
  if (remaining.length) {
    throw new Error(`Retired configuration profiles remain after explicit removal: ${remaining.join(", ")}. The fixed YouTube app was not installed.`);
  }
}

function isUnsupportedConfigurationProfileError(detail) {
  return /configuration profile management[\s\S]*not supported|com\.apple\.coredevice\.feature\.configurationprofiles/iu.test(String(detail || ""));
}

function isMissingConfigurationProfileError(detail) {
  return /(?:configuration )?profile[^\n]*(?:not found|does not exist)|no (?:configuration )?profile[^\n]*(?:found|matches)/iu.test(String(detail || ""));
}

function profileName(profile) {
  return String(profile.name || profile.displayName || profile.identifier || "installed");
}

async function readReceipt(deviceId) {
  const path = receiptPath(deviceId);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

async function writeReceipt(deviceId, value) {
  const path = receiptPath(deviceId);
  await mkdir(dirname(path), { recursive: true });
  await atomicJsonWrite(path, value);
}

function receiptPath(deviceId) {
  const safe = String(deviceId).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(ROOT, "data", "ios-phone-deployments", `${safe}.json`);
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function importFresh(path) {
  await access(path);
  return await import(`${pathToFileURL(path).href}?v=${Date.now()}-${Math.random()}`);
}

async function isFile(path) {
  const value = await stat(path).catch(() => null);
  return Boolean(value?.isFile());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runQuiet(command, args, options = {}) {
  await execFileAsync(command, args, { cwd: options.cwd || ROOT, env: options.env || process.env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: options.cwd || ROOT, env: options.env || process.env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) rejectRun(new Error(`${command} ended after ${signal}`));
      else if (code) rejectRun(new Error(`${command} exited with code ${code}`));
      else resolveRun();
    });
  });
}

function printHelp() {
  console.log(`Usage: node scripts/ios-phone-suite.mjs <command> [options]

Commands:
  status       Read-only source, app, profile, and policy delivery status (default)
  check        Status with a nonzero exit when drift exists
  audit        Build and validate Normal, Soft Lock, Full Brick, and Panic profiles
  update       Bump when needed, audit, build, install, sync policy, and verify
  develop      Safely update the Personal companions and matching supervised policy
  bump [kind]  Bump patch, minor, or major only when phone inputs changed
  fingerprint  Print the current phone implementation fingerprint

Options:
  --device ID  Select a CoreDevice UUID, UDID, or device name
  --edition NAME  Select personal or enhanced (default: persisted edition, initially personal)
  --server URL Vigil server used for live state and policy (default ${DEFAULT_SERVER})
  --no-policy  Update apps but do not replace configuration profiles
  --allow-edition-downgrade  Explicitly permit Enhanced-to-Personal replacement
  --replace-legacy  Remove obsolete Sentinel/Browser/Social/Snapchat apps and retired launcher/YouTube Web Clip profiles
  --force      Force a version bump even if phone inputs are unchanged
  --json       JSON output for fingerprint`);
}
