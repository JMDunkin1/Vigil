import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMacBuildVersion } from "./mac-build-version.mjs";
import { resolveMacSigningIdentity } from "./mac-signing-identity.mjs";

export const LOCAL_MAC_SHELL_SCHEMA = 1;
export const LOCAL_MAC_SHELL_MARKER_FILENAME = "vigil-local-shell.json";

const PACKAGING_DEPENDENCIES = [
  "node_modules/electron",
  "node_modules/electron-builder",
  "node_modules/app-builder-lib",
  "node_modules/@electron/asar",
  "node_modules/@electron/osx-sign",
  "node_modules/@electron/universal"
];

const SHELL_INPUT_PATHS = [
  "build/PrivacyInfo.xcprivacy",
  "build/browser-store.json",
  "build/icon.icns",
  "build/mac-entitlements-inherit.plist",
  "build/mac-entitlements.plist",
  "scripts/after-pack.mjs",
  "scripts/local-mac-shell.mjs",
  "scripts/mac-build-version.mjs",
  "scripts/mac-signing-identity.mjs",
  "scripts/package-local-mac.mjs",
  "scripts/package-mac.mjs",
  "scripts/sign-mac.mjs"
];

export async function localMacShellDescriptor(
  projectRoot,
  { environment = process.env, architecture = process.arch, signingIdentity } = {}
) {
  const [manifestBytes, lockBytes] = await Promise.all([
    readFile(join(projectRoot, "package.json")),
    readFile(join(projectRoot, "package-lock.json"))
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const packagingDependencies = Object.fromEntries(PACKAGING_DEPENDENCIES.map((path) => {
    const dependency = lock?.packages?.[path];
    if (!dependency || typeof dependency.version !== "string" || typeof dependency.integrity !== "string") {
      throw new Error(`Vigil's package lock is missing exact local-packaging dependency metadata for ${path}.`);
    }
    return [path, { integrity: dependency.integrity, version: dependency.version }];
  }));
  const shellInputs = {};
  for (const relativePath of SHELL_INPUT_PATHS) {
    const bytes = await readFile(join(projectRoot, relativePath));
    shellInputs[relativePath] = createHash("sha256").update(bytes).digest("hex");
  }
  const selectedIdentity = signingIdentity ?? await resolveMacSigningIdentity(environment);
  const record = {
    schema: LOCAL_MAC_SHELL_SCHEMA,
    architecture,
    buildVersion: resolveMacBuildVersion(environment),
    manifest: localMacShellManifestProjection(manifest),
    packagingDependencies,
    shellInputs,
    signingIdentity: selectedIdentity
  };
  return {
    schema: LOCAL_MAC_SHELL_SCHEMA,
    appId: String(manifest?.build?.appId || ""),
    architecture,
    buildVersion: record.buildVersion,
    electronVersion: packagingDependencies["node_modules/electron"].version,
    fingerprint: createHash("sha256").update(canonicalJson(record)).digest("hex"),
    productName: String(manifest?.build?.productName || ""),
    signingIdentity: selectedIdentity
  };
}

export function localMacShellManifestProjection(manifest) {
  return {
    author: manifest?.author ?? null,
    description: manifest?.description ?? null,
    main: manifest?.main ?? null,
    name: manifest?.name ?? null,
    version: manifest?.version ?? null,
    build: {
      appId: manifest?.build?.appId ?? null,
      productName: manifest?.build?.productName ?? null,
      files: manifest?.build?.files ?? null,
      asar: manifest?.build?.asar ?? null,
      asarUnpack: manifest?.build?.asarUnpack ?? null,
      extraResources: manifest?.build?.extraResources ?? null,
      afterPack: manifest?.build?.afterPack ?? null,
      mac: manifest?.build?.mac ?? null
    }
  };
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function localMacShellMarkerMatches(marker, expected) {
  return Boolean(
    marker
    && typeof marker === "object"
    && !Array.isArray(marker)
    && marker.schema === LOCAL_MAC_SHELL_SCHEMA
    && marker.appId === expected.appId
    && marker.architecture === expected.architecture
    && marker.buildVersion === expected.buildVersion
    && marker.electronVersion === expected.electronVersion
    && marker.fingerprint === expected.fingerprint
    && marker.productName === expected.productName
    && marker.signingIdentity === expected.signingIdentity
  );
}

export async function readLocalMacShellMarker(appPath) {
  const path = join(appPath, "Contents", "Resources", LOCAL_MAC_SHELL_MARKER_FILENAME);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Vigil's local shell marker is not a regular file.");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeLocalMacShellMarker(appPath, descriptor) {
  const path = join(appPath, "Contents", "Resources", LOCAL_MAC_SHELL_MARKER_FILENAME);
  await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o644 });
}
