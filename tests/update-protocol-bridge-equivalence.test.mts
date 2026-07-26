import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assembleUpdateProtocolBridgeCandidate,
  updateProtocolBridgeWrapperSource,
  verifyUpdateProtocolBridgeEquivalence
} from "../scripts/package-update-protocol-bridge.mjs";

const execFileAsync = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "vigil-protocol-bridge-equivalence-")));
const installedAppPath = join(root, "installed", "Vigil.app");
const candidateAppPath = join(root, "candidate", "Vigil.app");
const refreshedCandidateAppPath = join(root, "refreshed-candidate", "Vigil.app");
const payloadPath = join(root, "payload");
const refreshedPayloadPath = join(root, "refreshed-payload");
const standardRuntime = join("Contents", "Resources", "app.asar.unpacked", "dist", "runtime");
const buildInfoPath = join(standardRuntime, "build-info.json");
const controllerPath = join(standardRuntime, "app", "updater.js");
const updaterPath = join(standardRuntime, "scripts", "update-packaged-app.mjs");
const setupPath = join(standardRuntime, "scripts", "setup-system-guardian.mjs");
const bootstrapPath = join(standardRuntime, "scripts", "bootstrap-update-protocol.mjs");
const installerPath = join(standardRuntime, "scripts", "install-system-guardian.mjs");
const appAsarPath = join("Contents", "Resources", "app.asar");
const launcherPath = join("Contents", "MacOS", "Vigil");

try {
  await createBaselineFixture(installedAppPath);
  await createPayloadFixture(payloadPath);
  await Promise.all([
    mkdir(dirname(candidateAppPath), { recursive: true }),
    mkdir(dirname(refreshedCandidateAppPath), { recursive: true })
  ]);
  const manifest = await assembleUpdateProtocolBridgeCandidate({
    installedAppPath,
    runtimePayloadPath: payloadPath,
    candidateAppPath
  });

  assert.equal(
    await readFile(join(candidateAppPath, appAsarPath), "utf8"),
    await readFile(join(installedAppPath, appAsarPath), "utf8"),
    "normal Electron startup must retain A's exact app.asar"
  );
  assert.deepEqual(
    await readFile(join(candidateAppPath, buildInfoPath)),
    await readFile(join(installedAppPath, buildInfoPath)),
    "F's standard build identity must remain byte-for-byte A"
  );
  assert.deepEqual(
    await readFile(join(candidateAppPath, launcherPath)),
    await readFile(join(installedAppPath, launcherPath)),
    "an unsigned fixture must retain A's exact launcher"
  );
  assert.equal(manifest.payloadRoot, `Contents/Resources/VigilUpdater/v3/${manifest.payloadTreeSha256}`);
  assert.equal(manifest.wrappers.find((record) => record.kind === "updater")?.mode, 0o755);
  assert.equal(manifest.wrappers.find((record) => record.kind === "installer")?.mode, 0o640);
  assert.equal(manifest.wrappers.find((record) => record.kind === "setup")?.baselinePresent, false);
  assert.equal(manifest.wrappers.find((record) => record.kind === "bootstrap")?.baselinePresent, false);
  for (const [kind, path] of [
    ["controller", controllerPath],
    ["updater", updaterPath],
    ["setup", setupPath],
    ["bootstrap", bootstrapPath],
    ["installer", installerPath]
  ] as const) {
    const wrapper = updateProtocolBridgeWrapperSource(kind, manifest.payloadTreeSha256);
    const noAsar = wrapper.indexOf("process.noAsar = true;");
    const payloadImport = wrapper.indexOf("await import(");
    if (kind === "controller" || kind === "updater") {
      assert.equal(noAsar, -1,
        `a ${kind} wrapper imported by normal Electron startup must not globally disable ASAR resolution`);
    } else {
      assert.ok(
        noAsar >= 0 && noAsar < payloadImport,
        `the ${kind} wrapper must disable Electron's virtual ASAR filesystem before loading v3 code`
      );
    }
    assert.equal(
      await readFile(join(candidateAppPath, path), "utf8"),
      wrapper,
      `the ${kind} wrapper must be the exact root-pinned v3 loader`
    );
  }
  const installerWrapper = updateProtocolBridgeWrapperSource("installer", manifest.payloadTreeSha256);
  const controllerModule = await import(
    `${pathToFileURL(join(candidateAppPath, controllerPath)).href}?bridge-import=1`
  );
  const updaterModule = await import(`${pathToFileURL(join(candidateAppPath, updaterPath)).href}?bridge-import=1`);
  assert.equal(typeof controllerModule.createVigilAppUpdateController, "function",
    "the controller bridge wrapper must expose the payload's complete updater control plane");
  assert.equal(typeof updaterModule.inspectInstalledUpdateTopology, "function",
    "the updater bridge wrapper must preserve the module exports used during normal Electron startup");
  assert.equal(typeof updaterModule.runPackagedUpdate, "function",
    "the updater bridge wrapper must expose direct updater dispatch without running it when imported");
  assert.match(installerWrapper, /--read-only-preflight/u,
    "the bridge installer wrapper must preserve non-privileged setup preflight dispatch");
  assert.match(installerWrapper, /preflightSystemGuardianUpdateCompatibility/u,
    "the bridge installer wrapper must preserve read-only predecessor compatibility dispatch");
  assert.ok(
    installerWrapper.indexOf("preflightSystemGuardian()")
      < installerWrapper.indexOf("installSystemGuardian()"),
    "the bridge installer wrapper must dispatch read-only preflight before privileged installation"
  );
  const verifyFixture = () => verifyUpdateProtocolBridgeEquivalence(
    installedAppPath,
    candidateAppPath,
    { requireSignedSeal: false }
  );
  const evidence = await verifyFixture();
  assert.equal(evidence.payloadTreeSha256, manifest.payloadTreeSha256);
  assert.equal(evidence.equivalentTreeSha256, manifest.equivalentTreeSha256);

  await createPayloadFixture(refreshedPayloadPath);
  await writeFile(join(refreshedPayloadPath, "src.mjs"), "export const payload = 4;\n");
  const refreshedManifest = await assembleUpdateProtocolBridgeCandidate({
    installedAppPath: candidateAppPath,
    runtimePayloadPath: refreshedPayloadPath,
    candidateAppPath: refreshedCandidateAppPath
  });
  assert.notEqual(refreshedManifest.payloadTreeSha256, manifest.payloadTreeSha256,
    "a bridge refresh must pin the new runtime payload");
  assert.equal(refreshedManifest.equivalentTreeSha256, manifest.equivalentTreeSha256,
    "a bridge refresh must preserve generation A's protected tree");
  assert.equal(refreshedManifest.baselineBuildInfoSha256, manifest.baselineBuildInfoSha256,
    "a bridge refresh must preserve generation A's build identity");
  assert.deepEqual(
    refreshedManifest.wrappers.map(({ kind, mode, baselinePresent, xattrs }) => ({ kind, mode, baselinePresent, xattrs })),
    manifest.wrappers.map(({ kind, mode, baselinePresent, xattrs }) => ({ kind, mode, baselinePresent, xattrs })),
    "a bridge refresh must retain the original wrapper topology and metadata"
  );
  const refreshedEvidence = await verifyUpdateProtocolBridgeEquivalence(
    candidateAppPath,
    refreshedCandidateAppPath,
    { requireSignedSeal: false }
  );
  assert.equal(refreshedEvidence.payloadTreeSha256, refreshedManifest.payloadTreeSha256);
  const originalBaselineRefreshEvidence = await verifyUpdateProtocolBridgeEquivalence(
    installedAppPath,
    refreshedCandidateAppPath,
    { requireSignedSeal: false }
  );
  assert.equal(originalBaselineRefreshEvidence.payloadTreeSha256, refreshedManifest.payloadTreeSha256,
    "the refreshed bridge must remain directly equivalent to the original generation A");
  await assert.rejects(
    lstat(join(refreshedCandidateAppPath, manifest.payloadRoot)),
    { code: "ENOENT" },
    "the refreshed bridge must not retain the superseded payload tree"
  );

  const transactionRoot = join(root, "transaction");
  const previousAppPath = join(transactionRoot, "Vigil.app.vigil-previous");
  const nextAppPath = join(transactionRoot, "Vigil.app.vigil-next");
  const partialAppPath = `${nextAppPath}.00000000-0000-4000-8000-000000000000.partial`;
  await mkdir(transactionRoot, { recursive: true });
  await rename(installedAppPath, previousAppPath);
  await rename(candidateAppPath, nextAppPath);
  try {
    await assert.rejects(
      verifyUpdateProtocolBridgeEquivalence(null, nextAppPath, { requireSignedSeal: false }),
      /bridge candidate is not the exact Vigil\.app bundle/u
    );
    await assert.rejects(
      verifyUpdateProtocolBridgeEquivalence(previousAppPath, nextAppPath, { requireSignedSeal: false }),
      /bridge candidate is not the exact Vigil\.app bundle/u
    );
    const transactionEvidence = await verifyUpdateProtocolBridgeEquivalence(
      previousAppPath,
      nextAppPath,
      { requireSignedSeal: false, allowAtomicInstallBundlePaths: true }
    );
    assert.deepEqual(transactionEvidence, evidence);
  } finally {
    await rename(previousAppPath, installedAppPath);
    await rename(nextAppPath, candidateAppPath);
  }
  await rename(installedAppPath, previousAppPath);
  try {
    await assert.rejects(
      verifyUpdateProtocolBridgeEquivalence(previousAppPath, candidateAppPath, { requireSignedSeal: false }),
      /installed bridge baseline is not the exact Vigil\.app bundle/u
    );
  } finally {
    await rename(previousAppPath, installedAppPath);
  }
  await rename(candidateAppPath, partialAppPath);
  try {
    await assert.rejects(
      verifyUpdateProtocolBridgeEquivalence(
        null,
        partialAppPath,
        { requireSignedSeal: false, allowAtomicInstallBundlePaths: true }
      ),
      /bridge candidate is not the exact Vigil\.app bundle/u,
      "quarantined partial bundles must never be accepted as active transaction generations"
    );
  } finally {
    await rename(partialAppPath, candidateAppPath);
  }

  const candidateAsar = join(candidateAppPath, appAsarPath);
  await writeFile(candidateAsar, "tampered startup archive\n");
  await assert.rejects(
    verifyFixture(),
    /protected startup content|strict equivalence manifest/u
  );
  await writeFile(candidateAsar, "A app archive\n");

  const payloadModule = join(candidateAppPath, manifest.payloadRoot, "scripts", "update-packaged-app.mjs");
  const payloadUpdater = await readFile(payloadModule);
  await writeFile(payloadModule, Buffer.concat([payloadUpdater, Buffer.from("// tamper\n")]));
  await assert.rejects(
    verifyFixture(),
    /strict equivalence manifest/u
  );
  await writeFile(payloadModule, payloadUpdater);

  const candidateUpdater = join(candidateAppPath, updaterPath);
  await writeFile(candidateUpdater, "export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = 3;\n");
  await assert.rejects(
    verifyFixture(),
    /exact signed v3 loader/u
  );
  await writeFile(candidateUpdater, updateProtocolBridgeWrapperSource("updater", manifest.payloadTreeSha256));
  await chmod(candidateUpdater, 0o755);

  const bridgeExtra = join(candidateAppPath, "Contents", "Resources", "VigilUpdater", "unexpected");
  await writeFile(bridgeExtra, "not allowed\n");
  await assert.rejects(
    verifyFixture(),
    /unexpected bridge content/u
  );
  await rm(bridgeExtra);

  const protectedExtra = join(candidateAppPath, "Contents", "Resources", "startup-injection.mjs");
  await writeFile(protectedExtra, "export default true;\n");
  await assert.rejects(
    verifyFixture(),
    /protected app tree|protected startup content|strict equivalence manifest/u
  );
  await rm(protectedExtra);

  await execFileAsync("/usr/bin/xattr", ["-w", "tech.caseline.vigil.test", "changed", candidateAsar]);
  await assert.rejects(
    verifyFixture(),
    /protected startup content|strict equivalence manifest/u,
    "extended-attribute changes must be part of the complete protected inventory"
  );
  await execFileAsync("/usr/bin/xattr", ["-d", "tech.caseline.vigil.test", candidateAsar]);

  const cmsOffset = 64 + 92 + 8;
  const launcher = Buffer.from(await readFile(join(candidateAppPath, launcherPath)));
  launcher[cmsOffset] = 2;
  await writeFile(join(candidateAppPath, launcherPath), launcher);
  await verifyFixture();
  launcher[64 + 28 + 44] ^= 0xff;
  await writeFile(join(candidateAppPath, launcherPath), launcher);
  await assert.rejects(
    verifyFixture(),
    /protected startup content|strict equivalence manifest/u,
    "CodeDirectory code-page hashes must remain exact even when CMS signature bytes are normalized"
  );

  await assertClosedPayloadRejections();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createBaselineFixture(appPath: string): Promise<void> {
  const buildInfo = {
    name: "vigil",
    commit: "a".repeat(40),
    dirty: false,
    sourceFingerprint: "b".repeat(64),
    sourceRoot: "/private/tmp/vigil-source"
  };
  await Promise.all([
    mkdir(dirname(join(appPath, launcherPath)), { recursive: true }),
    mkdir(dirname(join(appPath, updaterPath)), { recursive: true }),
    mkdir(dirname(join(appPath, standardRuntime, "app", "main.js")), { recursive: true }),
    mkdir(join(appPath, "Contents", "Resources", "data"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(appPath, launcherPath), artificialMachO()),
    writeFile(join(appPath, "Contents", "Info.plist"), "<plist>A identity</plist>\n"),
    writeFile(join(appPath, appAsarPath), "A app archive\n"),
    writeFile(join(appPath, buildInfoPath), `${JSON.stringify(buildInfo)}\n`),
    writeFile(
      join(appPath, controllerPath),
      "export function createVigilAppUpdateController() { return { status: async () => ({ generation: 'A' }) }; }\n"
    ),
    writeFile(join(appPath, updaterPath), "legacy updater wrapper\n"),
    writeFile(join(appPath, installerPath), "legacy installer wrapper\n"),
    writeFile(join(appPath, standardRuntime, "app", "main.js"), "export const generation = 'A';\n"),
    writeFile(join(appPath, "Contents", "Resources", "data", "one"), "hardlinked protected data\n")
  ]);
  await link(
    join(appPath, "Contents", "Resources", "data", "one"),
    join(appPath, "Contents", "Resources", "data", "two")
  );
  await chmod(join(appPath, launcherPath), 0o755);
  await chmod(join(appPath, updaterPath), 0o755);
  await chmod(join(appPath, installerPath), 0o640);
  await execFileAsync("/usr/bin/xattr", ["-w", "tech.caseline.vigil.wrapper", "preserved", join(appPath, updaterPath)]);
}

async function createPayloadFixture(path: string): Promise<void> {
  await Promise.all([
    mkdir(join(path, "app"), { recursive: true }),
    mkdir(join(path, "scripts"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(
      join(path, "app", "updater.js"),
      "export function createVigilAppUpdateController() { return { status: async () => ({}) }; }\n"
    ),
    writeFile(join(path, "scripts", "update-packaged-app.mjs"), [
      "export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = 3;",
      "export async function inspectInstalledUpdateTopology() { return { ok: true }; }",
      "export async function runPackagedUpdate() {}",
      ""
    ].join("\n")),
    writeFile(join(path, "scripts", "setup-system-guardian.mjs"), "export async function runSystemGuardianSetup() {}\n"),
    writeFile(join(path, "scripts", "bootstrap-update-protocol.mjs"), "export async function runBootstrapCli() {}\n"),
    writeFile(join(path, "scripts", "install-system-guardian.mjs"), "export async function installSystemGuardian() {}\n"),
    writeFile(join(path, "src.mjs"), "export const payload = 3;\n")
  ]);
}

async function assertClosedPayloadRejections(): Promise<void> {
  const aliasedOutputParent = join(root, "aliased-installed-parent");
  await symlink(dirname(installedAppPath), aliasedOutputParent);
  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: payloadPath,
      candidateAppPath: join(aliasedOutputParent, "Vigil.app")
    }),
    /unsafe output directory/u,
    "a symlinked output parent must not alias the installed app"
  );

  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: payloadPath,
      candidateAppPath: join(installedAppPath, "nested", "Vigil.app")
    }),
    /unsafe update-protocol bridge candidate path/u,
    "a candidate must never be created inside the installed app"
  );
  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: payloadPath,
      candidateAppPath: join(payloadPath, "nested", "Vigil.app")
    }),
    /unsafe update-protocol bridge candidate path/u,
    "a candidate must never be created inside the payload source"
  );

  const symlinkPayload = join(root, "payload-symlink");
  await createPayloadFixture(symlinkPayload);
  await symlink("src.mjs", join(symlinkPayload, "alias.mjs"));
  await mkdir(join(root, "candidate-symlink"), { recursive: true });
  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: symlinkPayload,
      candidateAppPath: join(root, "candidate-symlink", "Vigil.app")
    }),
    /symbolic link in its closed v3 payload/u
  );

  const hardlinkPayload = join(root, "payload-hardlink");
  await createPayloadFixture(hardlinkPayload);
  await link(join(hardlinkPayload, "src.mjs"), join(hardlinkPayload, "alias.mjs"));
  await mkdir(join(root, "candidate-hardlink"), { recursive: true });
  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: hardlinkPayload,
      candidateAppPath: join(root, "candidate-hardlink", "Vigil.app")
    }),
    /hard link in its closed v3 payload/u
  );

  const weirdPayload = join(root, "payload-weird");
  await createPayloadFixture(weirdPayload);
  await writeFile(join(weirdPayload, "bad\nname"), "no\n");
  await mkdir(join(root, "candidate-weird"), { recursive: true });
  await assert.rejects(
    assembleUpdateProtocolBridgeCandidate({
      installedAppPath,
      runtimePayloadPath: weirdPayload,
      candidateAppPath: join(root, "candidate-weird", "Vigil.app")
    }),
    /weird bridge inventory name/u
  );
}

function artificialMachO(): Buffer {
  const signatureOffset = 64;
  const codeDirectoryOffset = 28;
  const codeDirectoryLength = 64;
  const cmsOffset = codeDirectoryOffset + codeDirectoryLength;
  const cmsLength = 12;
  const signatureLength = cmsOffset + cmsLength;
  const bytes = Buffer.alloc(signatureOffset + signatureLength);
  bytes.writeUInt32BE(0xcffaedfe, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(16, 20);
  bytes.writeUInt32LE(0, 24);
  bytes.writeUInt32LE(0, 28);
  bytes.writeUInt32LE(0x1d, 32);
  bytes.writeUInt32LE(16, 36);
  bytes.writeUInt32LE(signatureOffset, 40);
  bytes.writeUInt32LE(signatureLength, 44);
  bytes.fill(0x11, 48, signatureOffset);

  bytes.writeUInt32BE(0xfade0cc0, signatureOffset);
  bytes.writeUInt32BE(signatureLength, signatureOffset + 4);
  bytes.writeUInt32BE(2, signatureOffset + 8);
  bytes.writeUInt32BE(0, signatureOffset + 12);
  bytes.writeUInt32BE(codeDirectoryOffset, signatureOffset + 16);
  bytes.writeUInt32BE(0x10000, signatureOffset + 20);
  bytes.writeUInt32BE(cmsOffset, signatureOffset + 24);

  const cd = signatureOffset + codeDirectoryOffset;
  bytes.writeUInt32BE(0xfade0c02, cd);
  bytes.writeUInt32BE(codeDirectoryLength, cd + 4);
  bytes.writeUInt32BE(0x20400, cd + 8);
  bytes.writeUInt32BE(0x10000, cd + 12);
  bytes.writeUInt32BE(44, cd + 16);
  bytes.writeUInt32BE(0, cd + 20);
  bytes.writeUInt32BE(0, cd + 24);
  bytes.writeUInt32BE(1, cd + 28);
  bytes.writeUInt32BE(signatureOffset, cd + 32);
  bytes[cd + 36] = 20;
  bytes[cd + 37] = 2;
  bytes[cd + 38] = 0;
  bytes[cd + 39] = 12;
  bytes.fill(0x33, cd + 44, cd + 64);

  const cms = signatureOffset + cmsOffset;
  bytes.writeUInt32BE(0xfade0b01, cms);
  bytes.writeUInt32BE(cmsLength, cms + 4);
  bytes.writeUInt32BE(1, cms + 8);
  return bytes;
}
