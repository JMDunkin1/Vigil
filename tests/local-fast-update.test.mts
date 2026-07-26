import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";
import {
  attachLocalDependencyCache,
  describeLocalDependencyCache,
  localDependencyCacheMarkerMatches,
  localDependencyCacheRoot,
  publishLocalDependencyCache
} from "../scripts/local-dependency-cache.mjs";

interface LocalMacShellDescriptor {
  schema: number;
  appId: string;
  architecture: string;
  buildVersion: string;
  electronVersion: string;
  fingerprint: string;
  productName: string;
  signingIdentity: string;
}

interface LocalMacShellModule {
  canonicalJson(value: unknown): string;
  localMacShellDescriptor(
    root: string,
    options: { environment: NodeJS.ProcessEnv; architecture: string; signingIdentity: string }
  ): Promise<LocalMacShellDescriptor>;
  localMacShellMarkerMatches(marker: unknown, descriptor: LocalMacShellDescriptor): boolean;
  readLocalMacShellMarker(appPath: string): Promise<LocalMacShellDescriptor>;
  writeLocalMacShellMarker(appPath: string, descriptor: LocalMacShellDescriptor): Promise<void>;
}

interface LocalMacPackagerModule {
  assertTemplateCloneContinuity(template: SignatureMetadata, clone: SignatureMetadata): void;
  normalizeUnsignedMachO(input: Buffer): Buffer;
  packagedRuntimePathIncluded(path: string): boolean;
  templateSigningIdentityDisposition(signature: SignatureMetadata, signingIdentity: string): "match" | "fallback";
  updateElectronAsarIntegrity(appPath: string, appAsarPath: string): Promise<string>;
}

interface SignatureMetadata {
  adhoc: boolean;
  authority: string | null;
  cdHash: string | null;
  identifier: string | null;
  leafCertificateSha256: string | null;
  locallyRebuildable: boolean;
  teamIdentifier: string | null;
}

const sourceRoot = existsSync(join(process.cwd(), "scripts", "local-mac-shell.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const shellModule = await import(
  `${pathToFileURL(join(sourceRoot, "scripts", "local-mac-shell.mjs")).href}?test=${Date.now()}`
) as LocalMacShellModule;
const packagerModule = await import(
  `${pathToFileURL(join(sourceRoot, "scripts", "package-local-mac.mjs")).href}?test=${Date.now()}`
) as LocalMacPackagerModule;
const packagerSource = await readFile(join(sourceRoot, "scripts", "package-local-mac.mjs"), "utf8");

assert.equal(shellModule.canonicalJson({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}');
assert.equal(packagerModule.packagedRuntimePathIncluded("src/server.js"), true);
assert.equal(packagerModule.packagedRuntimePathIncluded("tests/policy.test.mjs"), false);
assert.equal(packagerModule.packagedRuntimePathIncluded("scripts/write-build-info.mjs"), false);
assert.equal(packagerModule.packagedRuntimePathIncluded("public/app 2.js"), false);
assert.match(
  packagerSource,
  /preparePayloadMachOFiles\(root, candidateAppPath, payloadRoot, descriptor\.signingIdentity\)/u,
  "native helpers must be reused only from the already verified clone, never from the mutable installed path"
);
assert.match(
  packagerSource,
  /assessLocalTemplateSignature\(options\.templateAppPath\)[\s\S]*?resolveMacSigningIdentity\(process\.env, installedSigningIdentity\)[\s\S]*?localMacShellDescriptor\(projectRoot, \{ signingIdentity \}\)/u,
  "local packaging must select the exact installed signature before describing or rebuilding its reusable shell"
);
assert.match(
  packagerSource,
  /runInherited\(process\.execPath[\s\S]*?VIGIL_MAC_SIGNING_IDENTITY: descriptor\.signingIdentity/u,
  "the complete-packager fallback must inherit the same installed signing identity as the fast path"
);
const assessedSignature: SignatureMetadata = {
  adhoc: false,
  authority: "Apple Development: Vigil",
  cdHash: "a".repeat(40),
  identifier: "tech.caseline.vigil",
  leafCertificateSha256: "c".repeat(64),
  locallyRebuildable: true,
  teamIdentifier: "TEAM"
};
assert.doesNotThrow(() => packagerModule.assertTemplateCloneContinuity(assessedSignature, { ...assessedSignature }));
assert.throws(
  () => packagerModule.assertTemplateCloneContinuity(
    assessedSignature,
    { ...assessedSignature, cdHash: "b".repeat(40) }
  ),
  /changed while its reusable shell was being cloned/u,
  "an atomically substituted template must be rejected before the clone is re-signed"
);
assert.throws(
  () => packagerModule.assertTemplateCloneContinuity(
    assessedSignature,
    { ...assessedSignature, leafCertificateSha256: "d".repeat(64) }
  ),
  /changed while its reusable shell was being cloned/u,
  "a same-name signing certificate substitution must not pass shell continuity"
);
assert.equal(
  packagerModule.templateSigningIdentityDisposition(assessedSignature, "Apple Development: Rotated"),
  "fallback",
  "a safe local certificate rotation must use the complete packager instead of blocking updates"
);
assert.throws(
  () => packagerModule.templateSigningIdentityDisposition(
    { ...assessedSignature, authority: "Developer ID Application: Vigil", locallyRebuildable: false },
    "-"
  ),
  /distribution signature/u,
  "the fast updater must not downgrade a distribution-signed app to a local signature"
);

const shellFixtureRoot = await mkdtemp(join(tmpdir(), "vigil-fast-shell-"));
try {
  const shellInputs = [
    "package.json",
    "package-lock.json",
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
  for (const path of shellInputs) {
    const destination = join(shellFixtureRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, path), destination);
  }
  const descriptorOptions = { environment: {}, architecture: "arm64", signingIdentity: "-" };
  const firstDescriptor = await shellModule.localMacShellDescriptor(shellFixtureRoot, descriptorOptions);
  const repeatedDescriptor = await shellModule.localMacShellDescriptor(shellFixtureRoot, descriptorOptions);
  assert.deepEqual(repeatedDescriptor, firstDescriptor, "identical shell inputs must produce a stable fingerprint");

  for (const entitlement of ["build/mac-entitlements.plist", "build/mac-entitlements-inherit.plist"]) {
    const entitlementPath = join(shellFixtureRoot, entitlement);
    const original = await readFile(entitlementPath);
    await writeFile(entitlementPath, Buffer.concat([original, Buffer.from("\n<!-- fingerprint test -->\n")]));
    const changed = await shellModule.localMacShellDescriptor(shellFixtureRoot, descriptorOptions);
    assert.notEqual(changed.fingerprint, firstDescriptor.fingerprint, `${entitlement} must invalidate the reusable shell`);
    await writeFile(entitlementPath, original);
  }

  const markerAppPath = join(shellFixtureRoot, "Vigil.app");
  await mkdir(join(markerAppPath, "Contents", "Resources"), { recursive: true });
  await shellModule.writeLocalMacShellMarker(markerAppPath, firstDescriptor);
  const persistedDescriptor = await shellModule.readLocalMacShellMarker(markerAppPath);
  assert.deepEqual(persistedDescriptor, firstDescriptor);
  assert.equal(shellModule.localMacShellMarkerMatches(persistedDescriptor, firstDescriptor), true);
  assert.equal(
    shellModule.localMacShellMarkerMatches(
      { ...persistedDescriptor, fingerprint: "0".repeat(64) },
      firstDescriptor
    ),
    false
  );
} finally {
  await rm(shellFixtureRoot, { recursive: true, force: true });
}

const firstMachO = minimalMachO(1, 2);
const secondMachO = minimalMachO(9, 10);
assert.deepEqual(
  packagerModule.normalizeUnsignedMachO(firstMachO),
  packagerModule.normalizeUnsignedMachO(secondMachO),
  "signature removal may change only __LINKEDIT size metadata without forcing a helper re-sign"
);
secondMachO.writeUInt32LE(7, 24);
assert.notDeepEqual(
  packagerModule.normalizeUnsignedMachO(firstMachO),
  packagerModule.normalizeUnsignedMachO(secondMachO),
  "semantic Mach-O changes must remain visible to helper comparison"
);

const cacheFixtureRoot = await mkdtemp(join(tmpdir(), "vigil-fast-cache-"));
try {
  const firstSnapshot = join(cacheFixtureRoot, "snapshot-one");
  const secondSnapshot = join(cacheFixtureRoot, "snapshot-two");
  const thirdSnapshot = join(cacheFixtureRoot, "snapshot-three");
  const updaterDir = join(cacheFixtureRoot, "updater");
  await Promise.all([
    prepareDependencySnapshot(firstSnapshot, true),
    prepareDependencySnapshot(secondSnapshot, false),
    prepareDependencySnapshot(thirdSnapshot, false),
    mkdir(updaterDir, { recursive: true, mode: 0o700 })
  ]);
  const descriptor = await describeLocalDependencyCache(firstSnapshot, process.execPath, process.execPath);
  await publishLocalDependencyCache(firstSnapshot, updaterDir, descriptor);
  assert.equal((await lstat(join(firstSnapshot, "node_modules"))).isSymbolicLink(), true);
  assert.equal(
    await readlink(join(firstSnapshot, "node_modules")),
    join(localDependencyCacheRoot(updaterDir, descriptor.key), "node_modules")
  );

  const secondDescriptor = await describeLocalDependencyCache(secondSnapshot, process.execPath, process.execPath);
  assert.deepEqual(secondDescriptor, descriptor);
  assert.equal(await attachLocalDependencyCache(secondSnapshot, updaterDir, secondDescriptor), true);
  assert.equal((await lstat(join(secondSnapshot, "node_modules"))).isSymbolicLink(), true);
  const marker = JSON.parse(await readFile(
    join(localDependencyCacheRoot(updaterDir, descriptor.key), "ready.json"),
    "utf8"
  )) as Record<string, unknown>;
  assert.equal(localDependencyCacheMarkerMatches(marker, descriptor), true);
  assert.equal(localDependencyCacheMarkerMatches({ ...marker, nodeVersion: "wrong" }, descriptor), false);
  await writeFile(
    join(localDependencyCacheRoot(updaterDir, descriptor.key), "node_modules", "typescript", "package.json"),
    `${JSON.stringify({ name: "typescript", version: "5.9.2", injected: true })}\n`
  );
  assert.equal(
    await attachLocalDependencyCache(thirdSnapshot, updaterDir, descriptor),
    false,
    "metadata-preserving dependency-tree edits must invalidate a warm cache before any cached code executes"
  );
} finally {
  await rm(cacheFixtureRoot, { recursive: true, force: true });
}

if (process.platform === "darwin") {
  const asarFixtureRoot = await mkdtemp(join(tmpdir(), "vigil-fast-asar-"));
  try {
    const appPath = join(asarFixtureRoot, "Vigil.app");
    const resourcesPath = join(appPath, "Contents", "Resources");
    const payloadPath = join(asarFixtureRoot, "payload");
    const appAsarPath = join(resourcesPath, "app.asar");
    await Promise.all([
      mkdir(resourcesPath, { recursive: true }),
      mkdir(payloadPath, { recursive: true })
    ]);
    await writeFile(join(payloadPath, "package.json"), "{}\n");
    await asar.createPackage(payloadPath, appAsarPath);
    await writeFile(join(appPath, "Contents", "Info.plist"), integrityPlist("before"));
    const hash = await packagerModule.updateElectronAsarIntegrity(appPath, appAsarPath);
    const expectedHash = createHash("sha256").update(asar.getRawHeader(appAsarPath).headerString).digest("hex");
    assert.equal(hash, expectedHash, "Electron integrity must bind the ASAR header, not the complete archive bytes");
    assert.match(await readFile(join(appPath, "Contents", "Info.plist"), "utf8"), new RegExp(expectedHash, "u"));
  } finally {
    await rm(asarFixtureRoot, { recursive: true, force: true });
  }
}

function minimalMachO(linkEditVmSize: number, linkEditFileSize: number): Buffer {
  const commandOffset = 32;
  const bytes = Buffer.alloc(commandOffset + 72);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(72, 20);
  bytes.writeUInt32LE(0x19, commandOffset);
  bytes.writeUInt32LE(72, commandOffset + 4);
  bytes.write("__LINKEDIT", commandOffset + 8, "ascii");
  bytes.writeBigUInt64LE(BigInt(linkEditVmSize), commandOffset + 32);
  bytes.writeBigUInt64LE(BigInt(linkEditFileSize), commandOffset + 48);
  return bytes;
}

async function prepareDependencySnapshot(root: string, includeNodeModules: boolean): Promise<void> {
  const packageVersions = {
    "@electron/asar": "3.4.1",
    electron: "37.2.4",
    "electron-builder": "26.0.12",
    typescript: "5.9.2"
  };
  const lock = {
    name: "vigil-cache-fixture",
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ["", { name: "vigil-cache-fixture" }],
      ...Object.entries(packageVersions).map(([name, version]) => [`node_modules/${name}`, { version }])
    ])
  };
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"name":"vigil-cache-fixture"}\n'),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`)
  ]);
  if (!includeNodeModules) return;
  const nodeModules = join(root, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await writeFile(join(nodeModules, ".package-lock.json"), `${JSON.stringify(lock)}\n`);
  for (const [name, version] of Object.entries(packageVersions)) {
    const packagePath = join(nodeModules, ...name.split("/"));
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, "package.json"), `${JSON.stringify({ name, version })}\n`);
  }
}

function integrityPlist(hash: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key><string>SHA256</string>
      <key>hash</key><string>${hash}</string>
    </dict>
  </dict>
</dict>
</plist>
`;
}
