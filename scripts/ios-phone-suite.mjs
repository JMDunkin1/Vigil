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
const RELEASE_PATH = join(ROOT, "ios", "phone-release.json");
const DEFAULT_SERVER = "http://127.0.0.1:8787";
const PHONE_BLOCKLIST_RESOURCE = "adult-blocklist.sdi";
const EXPLICIT_CONTENT_POLICY_RESOURCE = "ExplicitContentPolicy.json";
const EXPLICIT_CONTENT_POLICY_PATH = join(ROOT, "ios", "VigilSocial", "VigilSocial", EXPLICIT_CONTENT_POLICY_RESOURCE);
const PHONE_BLOCKLIST_MAGIC = Buffer.from("SNTLIDX1", "ascii");
const PHONE_BLOCKLIST_HEADER_BYTES = PHONE_BLOCKLIST_MAGIC.byteLength + 4;
const MAX_PHONE_BLOCKLIST_BYTES = 32 * 1024 * 1024;
const DEFAULT_ADULT_BLOCKLIST_SOURCE_ID = "blocklistproject-porn";
const MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS = 600_000;
const MINIMUM_CUSTOM_ADULT_BLOCKLIST_DOMAINS = 1_000;
const PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
const LAUNCHER_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-social-launchers";
const LEGACY_BUNDLE_PREFIX = "tech.caseline.sentinel.";
const OBSOLETE_VIGIL_PHONE_BUNDLE_IDS = new Set([
  "tech.caseline.vigil.browser",
  "tech.caseline.vigil.social",
  "tech.caseline.vigil.snapchat"
]);
const OBSOLETE_APPS_PROBLEM_PREFIX = "Obsolete phone apps remain installed:";
const OBSOLETE_LAUNCHER_PROFILE_PROBLEM = "The obsolete Vigil social-launcher profile remains installed; use --replace-legacy to remove its duplicate Home Screen icons.";
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
  "src/limits.ts",
  "src/manageEngineExport.ts",
  "src/policy.ts",
  "src/presets.ts",
  "src/socialFeatureFilters.ts",
  "src/socialIconAssets.ts",
  "src/store.ts",
  "src/types.ts"
];
const REQUIRED_APPS = [
  { id: "instagram", service: "instagram", name: "Instagram", bundleId: "tech.caseline.vigil.instagram", appIconSet: "InstagramAppIcon", scheme: "vigil-instagram" },
  { id: "youtube", service: "youtube", name: "YouTube", bundleId: "tech.caseline.vigil.youtube", appIconSet: "YouTubeAppIcon", scheme: "vigil-youtube" }
];

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArguments(process.argv.slice(2));
  await main(command, options);
}

async function main(selectedCommand, selectedOptions) {
  if (selectedCommand === "help") return printHelp();
  await configureRuntimeDataDirectory();
  if (selectedCommand === "fingerprint") {
    const fingerprint = await implementationFingerprint();
    console.log(selectedOptions.json ? JSON.stringify(fingerprint, null, 2) : fingerprint.hash);
    return;
  }
  if (selectedCommand === "bump") {
    await requireReadyPhoneBlocklist("create a phone release");
    const release = await bumpRelease(selectedOptions.bump, selectedOptions.force);
    console.log(`Vigil phone release is ${release.version} (${release.build}).`);
    return;
  }
  if (selectedCommand === "audit") {
    const blocklist = await requireReadyPhoneBlocklist("complete the phone audit");
    const { developerDir, toolEnvironment } = await prepareAuditToolchain();
    console.log(`Apple toolchain: ${developerDir}`);
    await buildRuntime();
    const audit = await auditFourPolicies(toolEnvironment);
    printPolicyAudit(audit);
    printBlocklistReadiness(blocklist);
    return;
  }
  if (selectedCommand === "update") {
    await updatePhone(selectedOptions);
    return;
  }
  if (!["status", "check"].includes(selectedCommand)) throw new Error(`Unknown command: ${selectedCommand}`);
  const { device, toolEnvironment } = await preparePhoneToolchain(selectedOptions.device);
  const report = await phoneStatus(selectedOptions, device, toolEnvironment);
  printStatus(report);
  if (selectedCommand === "check" && report.problems.length) process.exitCode = 1;
}

async function configureRuntimeDataDirectory() {
  if (process.env.VIGIL_DATA_DIR) return;
  const blocklistPath = await currentBlocklistPath();
  if (blocklistPath) process.env.VIGIL_DATA_DIR = dirname(blocklistPath);
}

export function parseArguments(args) {
  const values = [...args];
  const first = values[0] && !values[0].startsWith("-") ? values.shift() : "status";
  const command = ["--help", "-h"].includes(first) ? "help" : first;
  const options = {
    bump: "patch",
    device: "",
    force: false,
    json: false,
    noPolicy: false,
    replaceLegacy: false,
    server: DEFAULT_SERVER
  };
  if (command === "bump" && values[0] && !values[0].startsWith("-")) options.bump = values.shift();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--device") options.device = requiredValue(values, ++index, value);
    else if (value.startsWith("--device=")) options.device = value.slice("--device=".length);
    else if (value === "--server") options.server = requiredValue(values, ++index, value).replace(/\/+$/, "");
    else if (value.startsWith("--server=")) options.server = value.slice("--server=".length).replace(/\/+$/, "");
    else if (value === "--no-policy") options.noPolicy = true;
    else if (value === "--replace-legacy") options.replaceLegacy = true;
    else if (value === "--force") options.force = true;
    else if (value === "--json") options.json = true;
    else if (["--help", "-h"].includes(value)) return { command: "help", options };
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!/^(patch|minor|major)$/.test(options.bump)) throw new Error(`Unknown release bump: ${options.bump}`);
  return { command, options };
}

function requiredValue(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

export async function implementationFingerprint() {
  const files = [];
  for (const path of PHONE_SOURCE_FILES) files.push(resolve(ROOT, path));
  files.push(...await filesBelow(join(ROOT, "ios"), isPhoneImplementationFile));
  const blocklistPath = await currentBlocklistPath();
  if (blocklistPath) files.push(blocklistPath);
  const unique = [...new Set(files)].sort();
  const digest = createHash("sha256");
  const entries = [];
  for (const path of unique) {
    const bytes = await readFile(path);
    const name = path.startsWith(ROOT) ? relative(ROOT, path) : "runtime/adult-blocklist.sdi";
    const hash = sha256(bytes);
    entries.push({ path: name, bytes: bytes.byteLength, sha256: hash });
    digest.update(name).update("\0").update(hash).update("\n");
  }
  return { hash: digest.digest("hex"), files: entries, blocklistPath };
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
    join(ROOT, "data", "adult-blocklist.sdi"),
    join(homedir(), "Library", "Application Support", "Vigil", "adult-blocklist.sdi")
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
  const payloadOffset = PHONE_BLOCKLIST_HEADER_BYTES + metadataLength;
  if (metadataLength < 1 || payloadOffset > bytes.byteLength) return failed("artifact metadata is truncated");
  let metadata;
  try {
    metadata = JSON.parse(bytes.subarray(PHONE_BLOCKLIST_HEADER_BYTES, payloadOffset).toString("utf8"));
  } catch {
    return failed("artifact metadata is invalid JSON");
  }
  const payload = bytes.subarray(payloadOffset);
  const sourceId = String(metadata?.source?.id || "");
  const minimumDomains = sourceId === DEFAULT_ADULT_BLOCKLIST_SOURCE_ID
    ? MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS
    : MINIMUM_CUSTOM_ADULT_BLOCKLIST_DOMAINS;
  const metadataValid = metadata?.formatVersion === 1
    && metadata?.encoding === "blocked-reversed-domain-front-coding-v1"
    && metadata?.blockSize === 64
    && Number.isInteger(metadata?.domainCount)
    && metadata.domainCount >= minimumDomains
    && metadata.domainCount <= 2_000_000
    && metadata?.payloadBytes === payload.byteLength
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

export function deployedBlocklistProblems(receipt, readiness, requiredBundleIds = REQUIRED_APPS.map((app) => app.bundleId)) {
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

function deployedExplicitContentPolicyProblems(receipt, expected, requiredBundleIds = REQUIRED_APPS.map((app) => app.bundleId)) {
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

async function readRelease() {
  const release = JSON.parse(await readFile(RELEASE_PATH, "utf8"));
  if (release.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isInteger(release.build) || release.build < 1) {
    throw new Error(`Invalid phone release manifest: ${RELEASE_PATH}`);
  }
  return release;
}

async function bumpRelease(level = "patch", force = false) {
  const release = await readRelease();
  const fingerprint = await implementationFingerprint();
  if (!force && release.sourceFingerprint === fingerprint.hash) return release;
  const version = incrementVersion(release.version, level);
  const next = {
    schemaVersion: 1,
    version,
    build: release.build + 1,
    sourceFingerprint: fingerprint.hash,
    releasedAt: new Date().toISOString()
  };
  await atomicJsonWrite(RELEASE_PATH, next);
  return next;
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

async function phoneStatus(selectedOptions, device, toolEnvironment) {
  const [release, fingerprint, blocklist, explicitContentPolicy] = await Promise.all([
    readRelease(),
    implementationFingerprint(),
    phoneBlocklistReadiness(),
    expectedExplicitContentPolicy()
  ]);
  const [appsResult, profileVerification, serverState] = await Promise.all([
    devicectlJson(["device", "info", "apps", "--device", device.identifier], toolEnvironment),
    configurationProfileStatus(device.identifier, toolEnvironment),
    fetchServerState(selectedOptions.server)
  ]);
  const currentPolicy = await currentPolicyFingerprint(selectedOptions.server, serverState, {
    allowCurrentRuntime: release.sourceFingerprint === fingerprint.hash
  });
  const livePolicyFingerprint = currentPolicy.fingerprint;
  const apps = appsResult.result?.apps || [];
  const profiles = profileVerification.profiles;
  const requiredApps = REQUIRED_APPS.map((required) => {
    const installed = apps.find((app) => app.bundleIdentifier === required.bundleId);
    return { ...required, installed: installed ? { version: installed.version || "", build: installed.bundleVersion || "" } : null };
  });
  const obsoleteApps = apps.filter((app) => isLegacyPhoneBundleIdentifier(app.bundleIdentifier));
  const lockProfile = profiles.find((profile) => profile.identifier === PROFILE_IDENTIFIER);
  const obsoleteLauncherProfile = profiles.find((profile) => profile.identifier === LAUNCHER_PROFILE_IDENTIFIER);
  const receipt = await readReceipt(device.udid || device.identifier);
  const problems = [];
  if (release.sourceFingerprint !== fingerprint.hash) problems.push("Phone-facing sources changed after the current release; bump and deploy a new phone release.");
  for (const app of requiredApps) {
    if (!app.installed) problems.push(`${app.name} is not installed.`);
    else if (app.installed.version !== release.version || String(app.installed.build) !== String(release.build)) {
      problems.push(`${app.name} is ${app.installed.version} (${app.installed.build}), expected ${release.version} (${release.build}).`);
    }
  }
  if (obsoleteApps.length) problems.push(`${OBSOLETE_APPS_PROBLEM_PREFIX} ${obsoleteApps.map((app) => app.bundleIdentifier).join(", ")}.`);
  const iosEnabled = Boolean(serverState?.state?.deviceControls?.ios?.enabled);
  if (!profileVerification.available) {
    problems.push(`Configuration-profile verification is unavailable: ${profileVerification.detail}`);
  } else {
    if (iosEnabled && !lockProfile) problems.push("The live Vigil iPhone policy is enabled locally but no Vigil lock profile is installed.");
    if (obsoleteLauncherProfile) problems.push(OBSOLETE_LAUNCHER_PROFILE_PROBLEM);
  }
  if (!serverState) problems.push(`The Vigil server at ${selectedOptions.server} is unavailable, so live policy freshness cannot be checked.`);
  else if (!livePolicyFingerprint) problems.push("The currently generated live policy could not be resolved for a freshness check.");
  if (receipt && receipt.release?.sourceFingerprint !== release.sourceFingerprint) problems.push("The last device receipt belongs to a different implementation fingerprint.");
  if (receipt?.policyFingerprint && lockProfile && !profileName(lockProfile).includes(receipt.policyFingerprint.slice(0, 12))) {
    problems.push("The installed policy profile name does not match the last deployment receipt.");
  }
  problems.push(...policyFreshnessProblems({
    installedProfileName: lockProfile ? profileName(lockProfile) : "",
    receiptFingerprint: receipt?.policyFingerprint,
    livePolicyFingerprint
  }));
  problems.push(...blocklistReadinessProblems(blocklist, serverState));
  problems.push(...deployedBlocklistProblems(receipt, blocklist));
  problems.push(...deployedExplicitContentPolicyProblems(receipt, explicitContentPolicy));
  return { release, fingerprint, blocklist, explicitContentPolicy, device, requiredApps, obsoleteApps, profiles, profileVerification, lockProfile, obsoleteLauncherProfile, receipt, serverState, livePolicyFingerprint, policyGenerationSource: currentPolicy.source, problems };
}

function printStatus(report) {
  console.log(`Vigil phone ${report.release.version} (${report.release.build})`);
  console.log(`Implementation: ${report.release.sourceFingerprint === report.fingerprint.hash ? "released" : "CHANGED — release bump required"}`);
  console.log(`Device: ${report.device.name} • ${report.device.model} • iOS ${report.device.osVersion} • wired and paired`);
  console.log("Apps:");
  for (const app of report.requiredApps) {
    console.log(`- ${app.name}: ${app.installed ? `${app.installed.version} (${app.installed.build})` : "missing"}`);
  }
  console.log("Profiles:");
  if (report.profileVerification.available) {
    console.log(`- Live policy: ${report.lockProfile ? profileName(report.lockProfile) : "missing"}`);
    console.log(`- Retired social launchers: ${report.obsoleteLauncherProfile ? "installed — remove with --replace-legacy" : "absent"}`);
  } else {
    console.log(`- Verification unavailable: ${report.profileVerification.detail}`);
  }
  if (report.receipt?.policyFingerprint) console.log(`Last deployed policy: ${report.receipt.policyFingerprint.slice(0, 12)}`);
  if (report.livePolicyFingerprint) console.log(`Current live policy: ${report.livePolicyFingerprint.slice(0, 12)} • ${report.policyGenerationSource}`);
  printBlocklistReadiness(report.blocklist);
  console.log(`Bundled explicit-content policy: ${report.explicitContentPolicy.sha256.slice(0, 12)} • ${report.explicitContentPolicy.bytes.toLocaleString("en-US")} bytes`);
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
  await requireReadyPhoneBlocklist("update the phone");
  let release = await readRelease();
  const fingerprint = await implementationFingerprint();
  if (release.sourceFingerprint !== fingerprint.hash) {
    release = await bumpRelease("patch");
    console.log(`Phone-facing inputs changed; created release ${release.version} (${release.build}).`);
  }
  const { device, developerDir, toolEnvironment } = await preparePhoneToolchain(selectedOptions.device);
  console.log(`Updating ${device.name} to Vigil phone ${release.version} (${release.build}) without rebooting.`);
  console.log(`Apple toolchain: ${developerDir}`);
  await buildRuntime();
  const audit = await auditFourPolicies(toolEnvironment);
  printPolicyAudit(audit);
  const build = await buildPhoneApps(release, toolEnvironment);
  const preparedPolicy = selectedOptions.noPolicy
    ? null
    : await prepareCurrentPolicy(release, selectedOptions.server, toolEnvironment);
  const installedBeforeUpdate = await devicectlJson(["device", "info", "apps", "--device", device.identifier], toolEnvironment);
  const obsoleteBeforeUpdate = (installedBeforeUpdate.result?.apps || [])
    .filter((app) => isLegacyPhoneBundleIdentifier(app.bundleIdentifier));
  const profileBeforeUpdate = await configurationProfileStatus(device.identifier, toolEnvironment);
  const obsoleteLauncherBeforeUpdate = profileBeforeUpdate.profiles.some((profile) => profile.identifier === LAUNCHER_PROFILE_IDENTIFIER);
  if ((obsoleteBeforeUpdate.length || obsoleteLauncherBeforeUpdate) && !selectedOptions.replaceLegacy) {
    const obsoleteItems = [
      ...obsoleteBeforeUpdate.map((app) => app.bundleIdentifier),
      ...(obsoleteLauncherBeforeUpdate ? [LAUNCHER_PROFILE_IDENTIFIER] : [])
    ];
    throw new Error(`Obsolete phone apps or launcher configuration must be removed before the fixed companions can be installed. Re-run with --replace-legacy: ${obsoleteItems.join(", ")}`);
  }
  for (const obsolete of obsoleteBeforeUpdate) {
    console.log(`Removing obsolete ${obsolete.bundleIdentifier}; its app-local data cannot be recovered after uninstall…`);
    await run("xcrun", ["devicectl", "device", "uninstall", "app", "--device", device.identifier, obsolete.bundleIdentifier], { env: toolEnvironment });
  }
  if (selectedOptions.replaceLegacy) {
    await removeObsoleteLauncherProfile(device.identifier, toolEnvironment);
  }
  for (const app of build.apps) {
    console.log(`Installing ${app.name}…`);
    await run("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app.path], { env: toolEnvironment });
  }

  const deviceReceiptId = device.udid || device.identifier;
  const previousReceipt = selectedOptions.noPolicy ? await readReceipt(deviceReceiptId) : null;
  let { policyFingerprint, policyArtifactHash } = preservedPolicyReceipt(previousReceipt);
  if (preparedPolicy) {
    ({ policyFingerprint, policyArtifactHash } = preparedPolicy);
    console.log(`Installing policy ${policyFingerprint.slice(0, 12)}…`);
    await run("xcrun", ["devicectl", "device", "profile", "install", "--device", device.identifier, preparedPolicy.lockPath, "--type", "configuration", "--replace-existing"], { env: toolEnvironment });
  }

  await writeReceipt(deviceReceiptId, {
    schemaVersion: 1,
    device: { identifier: device.identifier, udid: device.udid, name: device.name, model: device.model, osVersion: device.osVersion },
    release,
    policyFingerprint,
    policyArtifactHash,
    signingVariant: build.signingVariant,
    signingCapabilities: build.signingCapabilities,
    blocklist: build.blocklist,
    explicitContentPolicy: build.explicitContentPolicy,
    apps: build.apps.map((app) => ({
      name: app.name,
      bundleId: app.bundleId,
      sha256: app.sha256,
      signingCapabilities: app.signingCapabilities,
      blocklistArtifactSha256: app.blocklist.artifactSha256,
      blocklistDomainCount: app.blocklist.domainCount,
      explicitContentPolicySha256: app.explicitContentPolicy.sha256
    })),
    deployedAt: new Date().toISOString(),
    rebooted: false
  });
  const report = await phoneStatus(selectedOptions, device, toolEnvironment);
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

async function auditFourPolicies(toolEnvironment) {
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
    const profile = profilesModule.buildIosConfigurationProfile(state, now);
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

function printPolicyAudit(audit) {
  console.log("Four-level policy audit:");
  for (const level of audit) {
    console.log(`- ${level.title}: ${level.apps} apps • ${level.deniedUrls} denied URLs • ${level.allowedUrls} allowed URLs • ${level.sha256.slice(0, 12)}`);
  }
}

async function buildPhoneApps(release, toolEnvironment = process.env) {
  const root = join(ROOT, "data", "ios-phone-build", `${release.version}-${release.build}`);
  const personalTeamEntitlements = join(ROOT, "ios", "Shared", "PersonalTeam.entitlements");
  await mkdir(root, { recursive: true });
  const blocklist = await requireReadyPhoneBlocklist("build a Release phone app");
  await runQuiet(process.execPath, [join(ROOT, "dist", "runtime", "scripts", "generate-ios-content-policy.mjs")]);
  const explicitContentPolicy = await expectedExplicitContentPolicy();
  const environment = { ...toolEnvironment, VIGIL_PHONE_BLOCKLIST: blocklist.path };
  let reducedEntitlements = false;
  const apps = [];
  for (const social of REQUIRED_APPS) {
    const derived = join(root, social.id);
    console.log(`Building ${social.name} companion…`);
    const socialArguments = [
      "-project", "ios/VigilSocial/VigilSocial.xcodeproj",
      "-scheme", "VigilSocial",
      "-configuration", "Release",
      "-destination", "generic/platform=iOS",
      "-derivedDataPath", derived,
      "-allowProvisioningUpdates",
      "build",
      `PRODUCT_BUNDLE_IDENTIFIER=${social.bundleId}`,
      `VIGIL_SERVICE=${social.service}`,
      `SOCIAL_APP_NAME=${social.name}`,
      `SOCIAL_APP_ICON_SET=${social.appIconSet}`,
      `SOCIAL_URL_SCHEME=${social.scheme}`,
      `MARKETING_VERSION=${release.version}`,
      `CURRENT_PROJECT_VERSION=${release.build}`
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
    const bundledBlocklist = await verifyBundledPhoneBlocklist(path, blocklist);
    const bundledExplicitContentPolicy = await verifyBundledExplicitContentPolicy(path, explicitContentPolicy);
    const signingCapabilities = await signedAppCapabilities(path);
    if (!reducedEntitlements && !signingCapabilities.sensitiveContentAnalysis) {
      throw new Error(`${social.name} built without the requested Sensitive Content Analysis entitlement; refusing to label it as a full-capability build.`);
    }
    apps.push({
      ...social,
      path,
      blocklist: bundledBlocklist,
      explicitContentPolicy: bundledExplicitContentPolicy,
      signingCapabilities,
      sha256: await hashAppBundle(path)
    });
  }
  const capableApps = apps.filter((app) => app.signingCapabilities.sensitiveContentAnalysis).length;
  const signingVariant = capableApps === apps.length
    ? "full-capabilities"
    : capableApps === 0 ? "personal-team-conservative" : "mixed-capabilities";
  return {
    apps,
    signingVariant,
    signingCapabilities: Object.fromEntries(apps.map((app) => [app.id, app.signingCapabilities])),
    explicitContentPolicy,
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

async function prepareCurrentPolicy(release, server, toolEnvironment) {
  const profile = await buildCurrentPolicyFromLiveState(server, AbortSignal.timeout(5000));
  const policyFingerprint = sha256(profile);
  const stamped = await stampProfile(profile, `Vigil iPhone Lock • ${release.version} (${release.build}) • ${policyFingerprint.slice(0, 12)}`);
  const policyArtifactHash = sha256(stamped);
  const profileDir = join(ROOT, "data", "ios-phone-profiles");
  await mkdir(profileDir, { recursive: true });
  const lockPath = join(profileDir, "vigil-iphone-lock.mobileconfig");
  await signProfile(stamped, lockPath);
  await run("xcrun", ["devicectl", "device", "profile", "validate", "--type", "configuration", lockPath], { env: toolEnvironment });
  return { lockPath, policyFingerprint, policyArtifactHash };
}

async function buildCurrentPolicyFromLiveState(server, signal, suppliedServerState = null) {
  const serverState = suppliedServerState || await downloadServerState(server, signal);
  const state = structuredClone(serverState.state);
  const ios = state?.deviceControls?.ios;
  if (!ios || typeof ios !== "object") throw new Error("Vigil live state does not contain iPhone policy settings.");

  if (ios.hardenRemoval && ios.removalPasswordSet !== true) {
    throw new Error("Vigil's hardened iPhone profile has no persisted removal password; refusing to generate an unrecoverable profile.");
  }
  if (ios.removalPasswordSet === true) {
    const runningProfile = await downloadPolicy(server, signal);
    const plistModule = await importFresh(join(ROOT, "dist", "runtime", "src", "plist.js"));
    const removalPassword = removalPasswordFromProfile(plistModule.parsePlist(runningProfile.toString("utf8")));
    if (!removalPassword) throw new Error("The running Vigil profile did not expose its expected removal-password payload.");
    ios.removalPassword = removalPassword;
  }

  const profilesModule = await importFresh(join(ROOT, "dist", "runtime", "src", "iosProfiles.js"));
  return Buffer.from(profilesModule.buildIosConfigurationProfile(state, new Date()));
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

async function fetchLivePolicyFingerprint(server) {
  try {
    return sha256(await downloadPolicy(server, AbortSignal.timeout(3000)));
  } catch {
    return "";
  }
}

async function currentPolicyFingerprint(server, serverState, { allowCurrentRuntime }) {
  if (allowCurrentRuntime && serverState) {
    try {
      const profile = await buildCurrentPolicyFromLiveState(server, AbortSignal.timeout(3000), serverState);
      return { fingerprint: sha256(profile), source: "current source + live state" };
    } catch {
      // A read-only status check can still report the running server's profile;
      // update itself never falls back and therefore cannot install stale bytes.
    }
  }
  const fingerprint = await fetchLivePolicyFingerprint(server);
  return { fingerprint, source: fingerprint ? "running-server fallback" : "unavailable" };
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

async function removeObsoleteLauncherProfile(deviceIdentifier, toolEnvironment) {
  try {
    await execFileAsync("xcrun", [
      "devicectl", "device", "profile", "remove",
      "--device", deviceIdentifier,
      LAUNCHER_PROFILE_IDENTIFIER,
      "--type", "configuration",
      "--force-removal"
    ], {
      env: toolEnvironment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000
    });
    console.log(`Removed obsolete configuration profile ${LAUNCHER_PROFILE_IDENTIFIER}.`);
  } catch (error) {
    const detail = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
    if (isMissingConfigurationProfileError(detail)) return;
    if (isUnsupportedConfigurationProfileError(detail)) {
      console.warn(`Could not inspect or remove ${LAUNCHER_PROFILE_IDENTIFIER}: CoreDevice does not support configuration-profile management for this device.`);
      return;
    }
    throw error;
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
  bump [kind]  Bump patch, minor, or major only when phone inputs changed
  fingerprint  Print the current phone implementation fingerprint

Options:
  --device ID  Select a CoreDevice UUID, UDID, or device name
  --server URL Vigil server used for live state and policy (default ${DEFAULT_SERVER})
  --no-policy  Update apps but do not replace configuration profiles
  --replace-legacy  Remove obsolete Sentinel/Browser/Social/Snapchat apps and the retired launcher profile
  --force      Force a version bump even if phone inputs are unchanged
  --json       JSON output for fingerprint`);
}
