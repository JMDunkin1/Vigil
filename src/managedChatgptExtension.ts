import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BUILT_IN_CHROME_EXTENSION_ID } from "./defaults.js";
import { toPlist } from "./plist.js";

const runFile = promisify(execFile);
export const CHATGPT_POLICY_DOMAIN = "com.openai.codex";
export const CHROME_WEB_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
const PROFILE_ID = "tech.caseline.vigil.chatgpt-companion";
const RECEIPT_NAME = "release.json";
const ARCHIVE_NAME = "store-upload.zip";
// Keep credentials, browser storage, generated metadata, and source maps out of releases.
const PACKAGE_FILES = new Set([
  "manifest.json", "background.js", "content.js", "options.html", "options.js", "options.css",
  "blocked.html", "blocked.css", "blocked.js", "blocked-navigation.js", "rules.json",
  "reddit-review-background.js", "reddit-review-guard.js", "reddit-review-blocked.html",
  "reddit-child-lock.js", "google-safe-search.js", "media-child-lock.js",
  "youtube-bridge.js", "youtube-limits.js", "search-break.html", "search-break.js",
  "search-break-background.js", "search-break-page.js",
  ...[16, 32, 48, 128].map(size => `icons/icon-${size}.png`)
]);

export interface ExtensionRelease {
  schemaVersion: 1;
  kind: "unsigned-store-upload";
  extensionId: string;
  version: string;
  createdAt: string;
  files: Array<{ path: string; sha256: string }>;
  payloadSha256: string;
  contentSha256: string;
  archiveSha256: string;
  recoveryOf?: string;
}

export interface ExtensionPublication {
  extensionId: string;
  published: boolean;
  publishedVersion: string | null;
}

export interface ManagedClientRehearsal {
  clientBundleId: string;
  clientVersion: string;
  nativeRequiredExtensionVersion: string;
  testedAt: string;
  extensionId: string;
  // These are receipts from actual client tests, not the presence of a profile file.
  update: { fromVersion: string; toVersion: string; payloadSha256: string; passed: boolean };
  recovery: { fromVersion: string; fromContentSha256: string; restoredContentSha256: string; deliveredVersion: string; passed: boolean };
}

export function compareExtensionVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export async function prepareExtensionRelease(source: string, destination: string, options: {
  version?: string;
  recoveryOf?: string;
} = {}): Promise<ExtensionRelease> {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (destinationPath === sourcePath || destinationPath.startsWith(`${sourcePath}/`)) {
    throw new Error("Release output must be outside the extension source.");
  }
  await assertDirectory(sourcePath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await assertDirectory(dirname(destinationPath));
  if (await pathExists(destinationPath)) throw new Error("Release already exists; retain it and choose a new destination.");
  const original = await packageInventory(sourcePath);
  const manifest = validateManifest(JSON.parse((await readFile(join(sourcePath, "manifest.json"))).toString()), original);
  if (options.version && compareExtensionVersions(options.version, manifest.version) <= 0) {
    throw new Error("A repair must use a higher version; Chromium does not normally downgrade extensions.");
  }
  const temporary = join(dirname(destinationPath), `.vigil-extension-release-${randomUUID()}`);
  await mkdir(join(temporary, "payload"), { recursive: true, mode: 0o700 });
  try {
    for (const entry of original) {
      const bytes = await readFile(join(sourcePath, entry.path));
      if (sha256(bytes) !== entry.sha256) throw new Error("Extension source changed during snapshot preparation.");
      const output = join(temporary, "payload", entry.path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, entry.path === "manifest.json" && options.version
        ? `${JSON.stringify({ ...manifest, version: options.version }, null, 2)}\n` : bytes, { flag: "wx", mode: 0o600 });
    }
    if (JSON.stringify(await packageInventory(sourcePath)) !== JSON.stringify(original)) {
      throw new Error("Extension source changed during snapshot preparation.");
    }
    const files = await packageInventory(join(temporary, "payload"));
    const archive = join(temporary, ARCHIVE_NAME);
    await runFile("/usr/bin/zip", ["-q", archive, ...files.map(entry => entry.path)], { cwd: join(temporary, "payload") });
    const inventory = (await runFile("/usr/bin/unzip", ["-Z1", archive])).stdout.trim().split("\n").sort();
    if (JSON.stringify(inventory) !== JSON.stringify(files.map(entry => entry.path))) throw new Error("Archive inventory mismatch.");
    const receipt: ExtensionRelease = {
      schemaVersion: 1, kind: "unsigned-store-upload", extensionId: BUILT_IN_CHROME_EXTENSION_ID,
      version: options.version || manifest.version, createdAt: new Date().toISOString(), files,
      payloadSha256: sha256(JSON.stringify(files)), contentSha256: await contentFingerprint(join(temporary, "payload"), files),
      archiveSha256: sha256(await readFile(archive)),
      ...(options.recoveryOf ? { recoveryOf: options.recoveryOf } : {})
    };
    await writeFile(join(temporary, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await verifyExtensionRelease(temporary);
    await rename(temporary, destinationPath);
    return receipt;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyExtensionRelease(directory: string): Promise<ExtensionRelease> {
  await assertDirectory(directory);
  for (const file of [RECEIPT_NAME, ARCHIVE_NAME]) await assertFile(join(directory, file));
  const receipt = JSON.parse(await readFile(join(directory, RECEIPT_NAME), "utf8")) as ExtensionRelease;
  if (receipt.schemaVersion !== 1 || receipt.kind !== "unsigned-store-upload"
    || receipt.extensionId !== BUILT_IN_CHROME_EXTENSION_ID || !Array.isArray(receipt.files)) {
    throw new Error("Unsupported or mismatched extension release receipt.");
  }
  const files = await packageInventory(join(directory, "payload"));
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, "payload", "manifest.json"), "utf8")), files);
  if (manifest.version !== receipt.version || JSON.stringify(files) !== JSON.stringify(receipt.files)
    || sha256(JSON.stringify(files)) !== receipt.payloadSha256
    || await contentFingerprint(join(directory, "payload"), files) !== receipt.contentSha256
    || sha256(await readFile(join(directory, ARCHIVE_NAME))) !== receipt.archiveSha256) {
    throw new Error("Extension release integrity check failed; retain the previous working release.");
  }
  return receipt;
}

export async function prepareExtensionRecovery(previousRelease: string, destination: string, version: string, highestDeployedVersion: string): Promise<ExtensionRelease> {
  const previous = await verifyExtensionRelease(previousRelease);
  if (compareExtensionVersions(version, highestDeployedVersion) <= 0) {
    throw new Error("Recovery version must be higher than every deployed version.");
  }
  return await prepareExtensionRelease(join(previousRelease, "payload"), destination, {
    version, recoveryOf: previous.payloadSha256
  });
}

export function managedChatgptProfile(release: ExtensionRelease, publication: ExtensionPublication, options: {
  locked: boolean;
  workingRelease?: ExtensionRelease;
  rehearsal?: ManagedClientRehearsal;
  currentClientVersion?: string;
  currentNativeRequiredExtensionVersion?: string;
  now?: Date;
}): string {
  if (publication.published !== true || publication.extensionId !== release.extensionId
    || publication.publishedVersion !== release.version) {
    throw new Error("Do not apply an install policy: this exact release is not recorded as published in the Chrome Web Store.");
  }
  if (release.extensionId !== BUILT_IN_CHROME_EXTENSION_ID || !/^[a-f0-9]{64}$/u.test(release.payloadSha256)) {
    throw new Error("Invalid managed companion identity or payload receipt.");
  }
  versionParts(release.version);
  if (options.locked) assertRehearsal(release, options.workingRelease, options.rehearsal, options.currentClientVersion, options.currentNativeRequiredExtensionVersion, options.now || new Date());
  const mode = options.locked ? "force_installed" : "normal_installed";
  return toPlist({
    PayloadType: "Configuration", PayloadVersion: 1, PayloadIdentifier: PROFILE_ID,
    PayloadUUID: profileUuid(PROFILE_ID), PayloadDisplayName: "Vigil ChatGPT Companion",
    PayloadScope: "System", PayloadRemovalDisallowed: options.locked,
    PayloadDescription: "Updates and repairs keep the same companion identity and download signed releases from the Chrome Web Store. A profile alone does not prove effective enforcement.",
    PayloadContent: [{
      PayloadType: "com.apple.ManagedClient.preferences", PayloadVersion: 1,
      PayloadIdentifier: `${PROFILE_ID}.preferences`, PayloadUUID: profileUuid(`${PROFILE_ID}.preferences`),
      PayloadContent: { [CHATGPT_POLICY_DOMAIN]: { Forced: [{ mcx_preference_settings: {
        ExtensionSettings: { [release.extensionId]: {
          installation_mode: mode, update_url: CHROME_WEB_STORE_UPDATE_URL, override_update_url: true
        } }
      } }] } }
    }]
  });
}

function assertRehearsal(release: ExtensionRelease, working: ExtensionRelease | undefined, receipt: ManagedClientRehearsal | undefined, currentClientVersion: string | undefined, currentNativeRequiredExtensionVersion: string | undefined, now: Date): void {
  const testedAt = Date.parse(receipt?.testedAt || "");
  if (!working || !receipt || receipt.clientBundleId !== CHATGPT_POLICY_DOMAIN || !receipt.clientVersion
    || receipt.clientVersion !== currentClientVersion || !receipt.update || !receipt.recovery
    || receipt.nativeRequiredExtensionVersion !== release.version || currentNativeRequiredExtensionVersion !== release.version
    || receipt.extensionId !== release.extensionId || working.extensionId !== release.extensionId
    || !Number.isFinite(testedAt) || testedAt > now.getTime() || now.getTime() - testedAt > 24 * 60 * 60 * 1000
    || receipt.update.passed !== true || receipt.update.fromVersion !== working.version
    || receipt.update.toVersion !== release.version || receipt.update.payloadSha256 !== release.payloadSha256
    || compareExtensionVersions(release.version, working.version) <= 0
    || receipt.recovery.passed !== true || receipt.recovery.fromVersion !== release.version
    || receipt.recovery.fromContentSha256 !== release.contentSha256
    || receipt.recovery.restoredContentSha256 !== working.contentSha256
    || compareExtensionVersions(receipt.recovery.deliveredVersion, release.version) <= 0) {
    throw new Error("Removal lock requires recent actual ChatGPT update and recovery tests for these exact releases. Package tests alone are insufficient.");
  }
}

interface Manifest extends Record<string, unknown> { version: string; key: string }

function validateManifest(value: unknown, files: Array<{ path: string }>): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension manifest.");
  const manifest = value as Manifest;
  if (manifest.manifest_version !== 3 || manifest.name !== "Vigil Companion" || typeof manifest.key !== "string") {
    throw new Error("Only Vigil's existing Manifest V3 companion can be packaged.");
  }
  versionParts(manifest.version);
  const key = createPublicKey({ key: Buffer.from(manifest.key, "base64"), format: "der", type: "spki" });
  const der = key.export({ format: "der", type: "spki" });
  const id = sha256(der).slice(0, 32).replace(/[0-9a-f]/gu, character => String.fromCharCode(97 + Number.parseInt(character, 16)));
  if (id !== BUILT_IN_CHROME_EXTENSION_ID) throw new Error("The release would change Vigil's trusted extension identity.");
  const paths = new Set(files.map(file => file.path));
  const references: string[] = [];
  const visit = (entry: unknown): void => {
    if (typeof entry === "string" && /\.(js|html|css|json|png)$/u.test(entry)) references.push(entry);
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  for (const field of ["background", "content_scripts", "icons", "action", "options_page", "declarative_net_request", "web_accessible_resources"]) visit(manifest[field]);
  for (const reference of references) if (!paths.has(reference)) throw new Error(`Missing declared extension asset: ${reference}`);
  if (!paths.has("background.js") || !paths.has("content.js") || !paths.has("rules.json")) throw new Error("Companion filtering assets are incomplete.");
  return manifest;
}

async function packageInventory(directory: string): Promise<Array<{ path: string; sha256: string }>> {
  await assertDirectory(directory);
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = async (relative = ""): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === "_metadata") continue;
      if (entry.isDirectory() && path === "icons") { await assertDirectory(join(directory, path)); await visit(path); }
      else {
        if (!PACKAGE_FILES.has(path)) throw new Error(`Unexpected extension package entry: ${path}`);
        await assertFile(join(directory, path));
        files.push({ path, sha256: sha256(await readFile(join(directory, path))) });
      }
    }
  };
  await visit();
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function contentFingerprint(directory: string, files: Array<{ path: string; sha256: string }>): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  delete manifest.version;
  return sha256(JSON.stringify(files.map(entry => entry.path === "manifest.json"
    ? { path: entry.path, sha256: sha256(JSON.stringify(manifest)) } : entry)));
}

function versionParts(version: string): number[] {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/u.test(version)) throw new Error("Invalid Chromium extension version.");
  const parts = version.split(".").map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) throw new Error("Invalid Chromium extension version.");
  return parts;
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function profileUuid(value: string): string { const hex = sha256(value).slice(0, 32); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase(); }
async function assertDirectory(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe extension directory: ${path}`); }
async function assertFile(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024 * 1024) throw new Error(`Unsafe extension file: ${path}`); }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
