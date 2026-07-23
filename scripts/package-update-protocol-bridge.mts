import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import { macSigningTimestamp, resolveMacSigningIdentity } from "./mac-signing-identity.mjs";

const execFileAsync = promisify(execFile);

export const UPDATE_PROTOCOL_BRIDGE_EQUIVALENCE_VERSION = 1 as const;
export const UPDATE_PROTOCOL_BRIDGE_PAYLOAD_VERSION = 3 as const;
export const UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE = join(
  "Contents", "Resources", "VigilUpdater", "v3"
);
export const UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH = join(
  "Contents", "Resources", "VigilUpdater", "bridge-equivalence-v1.json"
);
export const UPDATE_PROTOCOL_BRIDGE_LAUNCHER_RELATIVE_PATH = join("Contents", "MacOS", "Vigil");
export const UPDATE_PROTOCOL_BRIDGE_BUILD_INFO_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"
);

const STANDARD_RUNTIME_ROOT = join("Contents", "Resources", "app.asar.unpacked", "dist", "runtime");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PROTOCOL_REVISION = 3;

export type UpdateProtocolBridgeWrapperKind = "updater" | "setup" | "bootstrap" | "installer";

export interface UpdateProtocolBridgeWrapperRecord {
  kind: UpdateProtocolBridgeWrapperKind;
  path: string;
  mode: number;
  sha256: string;
  payloadModule: string;
  baselinePresent: boolean;
  xattrs: Array<{ name: string; sha256: string }>;
}

export interface UpdateProtocolBridgeEquivalenceManifest {
  kind: "vigil-update-protocol-bridge-equivalence-v1";
  version: typeof UPDATE_PROTOCOL_BRIDGE_EQUIVALENCE_VERSION;
  payloadVersion: typeof UPDATE_PROTOCOL_BRIDGE_PAYLOAD_VERSION;
  payloadRoot: string;
  equivalentTreeSha256: string;
  payloadTreeSha256: string;
  baselineBuildInfoSha256: string;
  codeResourceRulesSha256: string;
  wrappersSha256: string;
  wrappers: UpdateProtocolBridgeWrapperRecord[];
}

export interface UpdateProtocolBridgeEquivalenceEvidence {
  manifestSha256: string;
  equivalentTreeSha256: string;
  payloadTreeSha256: string;
  wrappersSha256: string;
  baselineBuildInfoSha256: string;
}

interface WrapperDefinition {
  kind: UpdateProtocolBridgeWrapperKind;
  relativePath: string;
  payloadModule: string;
  mayBeAdded: boolean;
}

interface TreeEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  sha256?: string;
  target?: string;
  hardlinkGroup?: string;
  hardlinkCount?: number;
  xattrs: Array<{ name: string; sha256: string }>;
}

const WRAPPERS: readonly WrapperDefinition[] = [
  {
    kind: "updater",
    relativePath: join(STANDARD_RUNTIME_ROOT, "scripts", "update-packaged-app.mjs"),
    payloadModule: "scripts/update-packaged-app.mjs",
    mayBeAdded: false
  },
  {
    kind: "setup",
    relativePath: join(STANDARD_RUNTIME_ROOT, "scripts", "setup-system-guardian.mjs"),
    payloadModule: "scripts/setup-system-guardian.mjs",
    mayBeAdded: true
  },
  {
    kind: "bootstrap",
    relativePath: join(STANDARD_RUNTIME_ROOT, "scripts", "bootstrap-update-protocol.mjs"),
    payloadModule: "scripts/bootstrap-update-protocol.mjs",
    mayBeAdded: true
  },
  {
    kind: "installer",
    relativePath: join(STANDARD_RUNTIME_ROOT, "scripts", "install-system-guardian.mjs"),
    payloadModule: "scripts/install-system-guardian.mjs",
    mayBeAdded: false
  }
] as const;

/**
 * Clone installed generation A and add only the inert v3 payload, its strict
 * equivalence manifest, and four direct-invocation wrappers. Normal Electron
 * startup continues to load A's unchanged app.asar and build metadata.
 */
export async function assembleUpdateProtocolBridgeCandidate({
  installedAppPath,
  runtimePayloadPath,
  candidateAppPath
}: {
  installedAppPath: string;
  runtimePayloadPath: string;
  candidateAppPath: string;
}): Promise<UpdateProtocolBridgeEquivalenceManifest> {
  const installed = await exactAppDirectory(installedAppPath, "installed bridge baseline");
  const payload = await exactDirectory(runtimePayloadPath, "v3 runtime payload");
  const candidate = safeCandidatePath(candidateAppPath, installed, payload);
  await assertNoBridgePayload(installed);
  const [payloadSourceTree, baselineTree, baselineBuildInfo, codeResourceRulesSha256] = await Promise.all([
    snapshotTree(payload, () => false, true),
    protectedTree(installed),
    readFile(join(installed, UPDATE_PROTOCOL_BRIDGE_BUILD_INFO_RELATIVE_PATH)),
    readCodeResourceRulesSha256(installed, false)
  ]);
  const payloadDigest = treeSha256(payloadSourceTree);
  const payloadRelativeRoot = join(UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE, payloadDigest);
  await rm(candidate, { recursive: true, force: true });
  await mkdir(dirname(candidate), { recursive: true });
  await execFileAsync("/bin/cp", ["-ac", installed, candidate], {
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  await recreateProtectedHardlinks(candidate, baselineTree);

  const payloadDestination = join(candidate, payloadRelativeRoot);
  await mkdir(dirname(payloadDestination), { recursive: true });
  await chmod(join(candidate, "Contents", "Resources", "VigilUpdater"), 0o755);
  await chmod(join(candidate, UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE), 0o755);
  await clearExtendedAttributes(join(candidate, "Contents", "Resources", "VigilUpdater"));
  await clearExtendedAttributes(join(candidate, UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE));
  await execFileAsync("/bin/cp", ["-ac", payload, payloadDestination], {
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });

  const wrapperRecords: UpdateProtocolBridgeWrapperRecord[] = [];
  for (const definition of WRAPPERS) {
    const baselinePath = join(installed, definition.relativePath);
    const candidatePath = join(candidate, definition.relativePath);
    const baselineStat = await lstat(baselinePath).catch((error: unknown) => {
      if (definition.mayBeAdded && isErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (baselineStat && (!baselineStat.isFile() || baselineStat.isSymbolicLink())) {
      throw new Error(`Vigil's installed bridge baseline has an unsafe ${definition.kind} script.`);
    }
    if (baselineStat && (baselineStat.nlink !== 1 || await realpath(baselinePath) !== baselinePath)) {
      throw new Error(`Vigil's installed bridge baseline has an aliased ${definition.kind} script.`);
    }
    const mode = baselineStat ? baselineStat.mode & 0o7777 : 0o644;
    const baselineXattrs = baselineStat ? await extendedAttributes(baselinePath, false) : [];
    const bytes = Buffer.from(wrapperSource(definition.kind, payloadDigest), "utf8");
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, bytes, { mode });
    await chmod(candidatePath, mode);
    if (!baselineStat) await clearExtendedAttributes(candidatePath);
    const xattrs = await extendedAttributes(candidatePath, false);
    if (baselineStat && JSON.stringify(xattrs) !== JSON.stringify(baselineXattrs)) {
      throw new Error(`Vigil's cloned ${definition.kind} wrapper changed extended attributes.`);
    }
    wrapperRecords.push({
      kind: definition.kind,
      path: portablePath(definition.relativePath),
      mode,
      sha256: sha256(bytes),
      payloadModule: definition.payloadModule,
      baselinePresent: baselineStat !== null,
      xattrs
    });
  }

  const [candidateTree, payloadTree] = await Promise.all([
    protectedTree(candidate),
    snapshotTree(payloadDestination, () => false, true)
  ]);
  assertSameTree(baselineTree, candidateTree);
  if (treeSha256(payloadTree) !== payloadDigest) {
    throw new Error("Vigil's cloned v3 payload changed while the bridge candidate was assembled.");
  }
  const manifest: UpdateProtocolBridgeEquivalenceManifest = {
    kind: "vigil-update-protocol-bridge-equivalence-v1",
    version: UPDATE_PROTOCOL_BRIDGE_EQUIVALENCE_VERSION,
    payloadVersion: UPDATE_PROTOCOL_BRIDGE_PAYLOAD_VERSION,
    payloadRoot: portablePath(payloadRelativeRoot),
    equivalentTreeSha256: treeSha256(baselineTree),
    payloadTreeSha256: treeSha256(payloadTree),
    baselineBuildInfoSha256: sha256(baselineBuildInfo),
    codeResourceRulesSha256,
    wrappersSha256: wrappersSha256(wrapperRecords),
    wrappers: wrapperRecords
  };
  const manifestPath = join(candidate, UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await clearExtendedAttributes(manifestPath);
  await verifyUpdateProtocolBridgeEquivalence(installed, candidate, { requireSignedSeal: false });
  return manifest;
}

export async function packageUpdateProtocolBridgeCandidate(options: {
  installedAppPath: string;
  runtimePayloadPath: string;
  candidateAppPath: string;
  signingIdentity?: string;
}): Promise<UpdateProtocolBridgeEquivalenceEvidence> {
  await assembleUpdateProtocolBridgeCandidate(options);
  const identity = options.signingIdentity || await resolveMacSigningIdentity();
  const timestamp = macSigningTimestamp(identity);
  const args = [
    "--force",
    "--sign", identity,
    "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
    ...(timestamp === "none" ? ["--timestamp=none"] : ["--timestamp"]),
    resolve(options.candidateAppPath)
  ];
  await execFileAsync("/usr/bin/codesign", args, {
    timeout: 2 * 60_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(options.candidateAppPath)], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return await verifyUpdateProtocolBridgeEquivalence(options.installedAppPath, options.candidateAppPath);
}

/** Verify a signed or unsigned candidate against A and its signed manifest. */
export async function verifyUpdateProtocolBridgeEquivalence(
  installedAppPath: string | null,
  candidateAppPath: string,
  options: { requireSignedSeal?: boolean } = {}
): Promise<UpdateProtocolBridgeEquivalenceEvidence> {
  const candidate = await exactAppDirectory(candidateAppPath, "bridge candidate");
  const { bytes: manifestBytes, manifest } = await readBridgeManifest(candidate);
  const payloadRoot = join(candidate, manifest.payloadRoot);
  const [candidateTree, payloadTree, candidateBuildInfo] = await Promise.all([
    protectedTree(candidate),
    snapshotTree(payloadRoot, () => false, true),
    readFile(join(candidate, UPDATE_PROTOCOL_BRIDGE_BUILD_INFO_RELATIVE_PATH))
  ]);
  if (treeSha256(candidateTree) !== manifest.equivalentTreeSha256
    || treeSha256(payloadTree) !== manifest.payloadTreeSha256
    || sha256(candidateBuildInfo) !== manifest.baselineBuildInfoSha256) {
    throw new Error("Vigil's bridge candidate does not match its strict equivalence manifest.");
  }

  if (installedAppPath !== null) {
    const installed = await exactAppDirectory(installedAppPath, "installed bridge baseline");
    await assertNoBridgePayload(installed);
    const [baselineTree, baselineBuildInfo] = await Promise.all([
      protectedTree(installed),
      readFile(join(installed, UPDATE_PROTOCOL_BRIDGE_BUILD_INFO_RELATIVE_PATH))
    ]);
    assertSameTree(baselineTree, candidateTree);
    if (treeSha256(baselineTree) !== manifest.equivalentTreeSha256
      || sha256(baselineBuildInfo) !== manifest.baselineBuildInfoSha256) {
      throw new Error("Vigil's bridge candidate is not equivalent to the exact installed generation.");
    }
    for (const definition of WRAPPERS) {
      const record = manifest.wrappers.find((candidateRecord) => candidateRecord.kind === definition.kind)!;
      const present = await pathExists(join(installed, definition.relativePath));
      if (present !== record.baselinePresent || (!present && !definition.mayBeAdded)) {
        throw new Error(`Vigil's bridge manifest misstates the installed ${definition.kind} script topology.`);
      }
      if (present) {
        const baselinePath = join(installed, definition.relativePath);
        const [stat, canonical, xattrs] = await Promise.all([
          lstat(baselinePath),
          realpath(baselinePath),
          extendedAttributes(baselinePath, false)
        ]);
        if (!stat.isFile()
          || stat.isSymbolicLink()
          || stat.nlink !== 1
          || canonical !== baselinePath
          || JSON.stringify(xattrs) !== JSON.stringify(record.xattrs)) {
          throw new Error(`Vigil's bridge manifest misstates the installed ${definition.kind} script metadata.`);
        }
      }
    }
  }

  const observedWrappers: UpdateProtocolBridgeWrapperRecord[] = [];
  for (const definition of WRAPPERS) {
    const record = manifest.wrappers.find((candidateRecord) => candidateRecord.kind === definition.kind)!;
    const path = join(candidate, definition.relativePath);
    const [stat, canonical, bytes, xattrs] = await Promise.all([
      lstat(path),
      realpath(path),
      readFile(path),
      extendedAttributes(path, false)
    ]);
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || canonical !== path
      || (stat.mode & 0o7777) !== record.mode
      || JSON.stringify(xattrs) !== JSON.stringify(record.xattrs)
      || sha256(bytes) !== record.sha256
      || bytes.toString("utf8") !== wrapperSource(definition.kind, manifest.payloadTreeSha256)) {
      throw new Error(`Vigil's bridge ${definition.kind} wrapper is not the exact signed v3 loader.`);
    }
    observedWrappers.push(record);
  }
  if (wrappersSha256(observedWrappers) !== manifest.wrappersSha256) {
    throw new Error("Vigil's bridge wrapper set changed after manifest creation.");
  }
  const payloadUpdater = await readFile(join(payloadRoot, "scripts", "update-packaged-app.mjs"), "utf8");
  if (!payloadUpdater.includes(`export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = ${PROTOCOL_REVISION};`)) {
    throw new Error("Vigil's inert bridge payload lacks its required v3 updater protocol marker.");
  }
  if (options.requireSignedSeal !== false) {
    await assertSignedBridgeSeal(candidate, installedAppPath, manifest, payloadTree);
  }
  return {
    manifestSha256: sha256(manifestBytes),
    equivalentTreeSha256: manifest.equivalentTreeSha256,
    payloadTreeSha256: manifest.payloadTreeSha256,
    wrappersSha256: manifest.wrappersSha256,
    baselineBuildInfoSha256: manifest.baselineBuildInfoSha256
  };
}

/** Resolve one exact payload module after validating the closed bridge topology. */
export async function updateProtocolBridgePayloadModulePath(
  candidateAppPath: string,
  payloadModule: string
): Promise<string> {
  const candidate = await exactAppDirectory(candidateAppPath, "bridge candidate");
  const definition = WRAPPERS.find((wrapper) => wrapper.payloadModule === payloadModule);
  if (!definition) throw new Error("Vigil refused an unrecognized bridge payload module.");
  const { manifest } = await readBridgeManifest(candidate);
  const expected = join(candidate, manifest.payloadRoot, payloadModule);
  const [canonical, stat] = await Promise.all([realpath(expected), lstat(expected)]);
  if (canonical !== expected || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Vigil refused an unsafe bridge payload module.");
  }
  return expected;
}

export function updateProtocolBridgeWrapperSource(
  kind: UpdateProtocolBridgeWrapperKind,
  payloadTreeSha256: string
): string {
  if (!validSha256(payloadTreeSha256)) throw new Error("Vigil refused an invalid bridge payload digest.");
  return wrapperSource(kind, payloadTreeSha256);
}

function wrapperSource(kind: UpdateProtocolBridgeWrapperKind, payloadTreeSha256: string): string {
  const prefix = `../../../../VigilUpdater/v3/${payloadTreeSha256}/scripts/`;
  if (kind === "updater") {
    return [
      "// Vigil signed update-protocol bridge wrapper v1",
      `export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = ${PROTOCOL_REVISION};`,
      `const { runPackagedUpdate } = await import("${prefix}update-packaged-app.mjs");`,
      "await runPackagedUpdate();",
      ""
    ].join("\n");
  }
  if (kind === "setup") {
    return [
      "// Vigil signed update-protocol bridge wrapper v1",
      `const { runSystemGuardianSetup } = await import("${prefix}setup-system-guardian.mjs");`,
      "try {",
      "  await runSystemGuardianSetup();",
      "} catch (error) {",
      "  process.stderr.write(`${JSON.stringify({ ok: false, canceled: false, error: error instanceof Error ? error.message : String(error) })}\\n`);",
      "  process.exitCode = 1;",
      "}",
      ""
    ].join("\n");
  }
  if (kind === "bootstrap") {
    return [
      "// Vigil signed update-protocol bridge wrapper v1",
      "import { randomUUID } from \"node:crypto\";",
      `const { runBootstrapCli } = await import("${prefix}bootstrap-update-protocol.mjs");`,
      "try {",
      "  await runBootstrapCli();",
      "} catch (error) {",
      "  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), id: randomUUID() })}\\n`);",
      "  process.exitCode = 1;",
      "}",
      ""
    ].join("\n");
  }
  return [
    "// Vigil signed update-protocol bridge wrapper v1",
    `const { installSystemGuardian } = await import("${prefix}install-system-guardian.mjs");`,
    "await installSystemGuardian();",
    "console.log(process.argv.includes(\"--json\")",
    "  ? JSON.stringify({ ok: true, label: \"tech.caseline.vigil.guardian.v3\", running: true })",
    "  : \"Installed and started Vigil's v3 system guardian.\");",
    ""
  ].join("\n");
}

async function protectedTree(appPath: string): Promise<TreeEntry[]> {
  const bridgeRoot = portablePath(join("Contents", "Resources", "VigilUpdater"));
  return await snapshotTree(appPath, (path) => isOuterSignatureMetadata(path)
    || isWrapper(path)
    || path === portablePath(UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH)
    || path === bridgeRoot
    || path.startsWith(`${bridgeRoot}/`));
}

async function snapshotTree(
  root: string,
  excluded: (path: string) => boolean = () => false,
  closedPayload = false,
  includeRoot = closedPayload
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const hardlinks = new Map<string, string>();
  const visit = async (absolute: string, path: string): Promise<void> => {
    if (path && excluded(path)) return;
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o7777;
    const xattrs = await extendedAttributes(absolute, stat.isSymbolicLink());
    if (stat.isSymbolicLink()) {
      if (closedPayload) throw new Error(`Vigil refused a symbolic link in its closed v3 payload at ${path}.`);
      entries.push({ path, type: "symlink", mode, target: await readlink(absolute), xattrs });
      return;
    }
    if (stat.isDirectory()) {
      if (path || includeRoot) entries.push({ path, type: "directory", mode, xattrs });
      const names = (await readdir(absolute)).sort();
      assertSafeDirectoryNames(names, path);
      for (const name of names) {
        await visit(join(absolute, name), path ? `${path}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Vigil refused a special file in its bridge bundle at ${path}.`);
    const bytes = await readFile(absolute);
    const comparable = path === portablePath(UPDATE_PROTOCOL_BRIDGE_LAUNCHER_RELATIVE_PATH)
      ? withoutMachOCodeSignatures(bytes)
      : bytes;
    let hardlinkGroup: string | undefined;
    if (stat.nlink > 1) {
      if (closedPayload) throw new Error(`Vigil refused a hard link in its closed v3 payload at ${path}.`);
      const key = `${stat.dev}:${stat.ino}`;
      hardlinkGroup = hardlinks.get(key) || path;
      hardlinks.set(key, hardlinkGroup);
    }
    entries.push({
      path,
      type: "file",
      mode,
      sha256: sha256(comparable),
      hardlinkGroup,
      hardlinkCount: hardlinkGroup ? stat.nlink : undefined,
      xattrs
    });
  };
  await visit(root, "");
  assertClosedHardlinkTopology(entries, root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assertClosedHardlinkTopology(entries: TreeEntry[], root: string): void {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.hardlinkGroup) counts.set(entry.hardlinkGroup, (counts.get(entry.hardlinkGroup) || 0) + 1);
  }
  for (const entry of entries) {
    if (entry.hardlinkGroup && counts.get(entry.hardlinkGroup) !== entry.hardlinkCount) {
      throw new Error(`Vigil refused a hard link escaping its compared bridge tree at ${root}/${entry.path}.`);
    }
  }
}

async function recreateProtectedHardlinks(candidate: string, baselineTree: TreeEntry[]): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const entry of baselineTree) {
    if (!entry.hardlinkGroup) continue;
    const paths = groups.get(entry.hardlinkGroup) || [];
    paths.push(entry.path);
    groups.set(entry.hardlinkGroup, paths);
  }
  for (const paths of groups.values()) {
    const [first, ...rest] = paths;
    if (!first) continue;
    const source = join(candidate, first);
    for (const path of rest) {
      const destination = join(candidate, path);
      await rm(destination);
      await link(source, destination);
    }
  }
}

async function extendedAttributes(path: string, symlink: boolean): Promise<Array<{ name: string; sha256: string }>> {
  const listArgs = [...(symlink ? ["-s"] : []), path];
  const { stdout } = await execFileAsync("/usr/bin/xattr", listArgs, {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  const names = stdout.split("\n").map((name) => name.trim()).filter(Boolean).sort();
  assertSafeDirectoryNames(names, `${path} extended attributes`);
  return await Promise.all(names.map(async (name) => {
    const { stdout: hex } = await execFileAsync("/usr/bin/xattr", ["-p", "-x", ...(symlink ? ["-s"] : []), name, path], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    const normalized = hex.replace(/\s+/gu, "").toLowerCase();
    if (normalized && !/^(?:[a-f0-9]{2})+$/u.test(normalized)) {
      throw new Error(`Vigil refused an unreadable extended attribute on ${path}.`);
    }
    return { name, sha256: sha256(Buffer.from(normalized, "hex")) };
  }));
}

async function clearExtendedAttributes(path: string): Promise<void> {
  await execFileAsync("/usr/bin/xattr", ["-c", path], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8"
  });
}

function assertSafeDirectoryNames(names: readonly string[], parent: string): void {
  const folded = new Set<string>();
  for (const name of names) {
    if (!name
      || name !== name.normalize("NFC")
      || /[\u0000-\u001f\u007f]/u.test(name)
      || name === "."
      || name === "..") {
      throw new Error(`Vigil refused a weird bridge inventory name under ${parent || "."}.`);
    }
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error(`Vigil refused a case-colliding bridge inventory under ${parent || "."}.`);
    folded.add(key);
  }
}

function withoutMachOCodeSignatures(input: Buffer): Buffer {
  return comparableMachO(input, 0, input.length) || input;
}

function comparableMachO(
  bytes: Buffer,
  base: number,
  size: number
): Buffer | null {
  if (size < 4 || base < 0 || base + size > bytes.length) return null;
  const magic = bytes.readUInt32BE(base);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const is64 = magic === 0xcafebabf;
    const count = bytes.readUInt32BE(base + 4);
    const width = is64 ? 32 : 20;
    if (count < 1 || count > 32 || 8 + count * width > size) return null;
    const slices: Array<Record<string, unknown>> = [];
    const occupied: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const entry = base + 8 + index * width;
      const offset = is64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8);
      const sliceSize = is64 ? Number(bytes.readBigUInt64BE(entry + 16)) : bytes.readUInt32BE(entry + 12);
      if (!Number.isSafeInteger(offset)
        || !Number.isSafeInteger(sliceSize)
        || offset < 0
        || sliceSize < 1
        || offset > size
        || sliceSize > size - offset) return null;
      const comparable = comparableMachO(bytes, base + offset, sliceSize);
      if (!comparable) return null;
      occupied.push({ start: offset, end: offset + sliceSize });
      slices.push({
        cpuType: bytes.readUInt32BE(entry),
        cpuSubtype: bytes.readUInt32BE(entry + 4),
        align: bytes.readUInt32BE(entry + (is64 ? 24 : 16)),
        ...(is64 ? { reserved: bytes.readUInt32BE(entry + 28) } : {}),
        sha256: sha256(comparable)
      });
    }
    occupied.sort((left, right) => left.start - right.start);
    let paddingStart = 8 + count * width;
    for (const range of occupied) {
      if (range.start < paddingStart) return null;
      if (bytes.subarray(base + paddingStart, base + range.start).some((value) => value !== 0)) {
        throw new Error("Vigil refused non-padding bytes between universal launcher slices.");
      }
      paddingStart = range.end;
    }
    if (bytes.subarray(base + paddingStart, base + size).some((value) => value !== 0)) {
      throw new Error("Vigil refused non-padding bytes after universal launcher slices.");
    }
    return Buffer.from(JSON.stringify({ kind: is64 ? "fat64" : "fat32", slices }), "utf8");
  }
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const thin = little || magic === 0xfeedface || magic === 0xfeedfacf;
  if (!thin) return null;
  const read32 = (offset: number): number => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const write32 = (buffer: Buffer, offset: number, value: number): void => {
    if (little) buffer.writeUInt32LE(value, offset);
    else buffer.writeUInt32BE(value, offset);
  };
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const headerSize = is64 ? 32 : 28;
  if (size < headerSize) return null;
  const commandCount = read32(base + 16);
  const commandBytes = read32(base + 20);
  if (commandCount > 4096 || commandBytes > size - headerSize) return null;
  let cursor = base + headerSize;
  let signature: { dataOffset: number; dataSize: number; commandOffset: number } | null = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > base + size) return null;
    const command = read32(cursor);
    const commandSize = read32(cursor + 4);
    if (commandSize < 8 || cursor + commandSize > base + size) return null;
    if (command === 0x1d && commandSize >= 16) {
      if (signature) throw new Error("Vigil refused a launcher with multiple Mach-O code-signature commands.");
      const dataOffset = read32(cursor + 8);
      const dataSize = read32(cursor + 12);
      if (dataOffset > size || dataSize > size - dataOffset) return null;
      signature = { dataOffset, dataSize, commandOffset: cursor - base };
    }
    cursor += commandSize;
  }
  if (cursor !== base + headerSize + commandBytes) return null;
  if (!signature) return Buffer.from(bytes.subarray(base, base + size));
  if (signature.dataOffset < headerSize + commandBytes) return null;
  const signatureBytes = bytes.subarray(
    base + signature.dataOffset,
    base + signature.dataOffset + signature.dataSize
  );
  const semantics = codeSignatureSemantics(signatureBytes);
  const terminal = bytes.subarray(base + signature.dataOffset + signature.dataSize, base + size);
  if (terminal.some((value) => value !== 0)) {
    throw new Error("Vigil refused non-padding launcher bytes after its terminal code signature.");
  }
  const code = Buffer.from(bytes.subarray(base, base + signature.dataOffset));
  write32(code, signature.commandOffset + 8, 0);
  write32(code, signature.commandOffset + 12, 0);
  return Buffer.concat([
    code,
    Buffer.from(`\nVIGIL-CODE-SIGNATURE-SEMANTICS\n${JSON.stringify(semantics)}\n`, "utf8")
  ]);
}

function codeSignatureSemantics(bytes: Buffer): Record<string, unknown> {
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0xfade0cc0) {
    throw new Error("Vigil refused a launcher without a valid embedded-signature SuperBlob.");
  }
  const length = bytes.readUInt32BE(4);
  const count = bytes.readUInt32BE(8);
  if (length < 12 || length > bytes.length || count > 64 || 12 + count * 8 > length) {
    throw new Error("Vigil refused a malformed launcher signature SuperBlob.");
  }
  if (bytes.subarray(length).some((value) => value !== 0)) {
    throw new Error("Vigil refused non-padding bytes after the launcher signature SuperBlob.");
  }
  const codeDirectories: Array<Record<string, unknown>> = [];
  const preservedBlobs: Array<{ type: number; sha256: string }> = [];
  const occupied: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const type = bytes.readUInt32BE(12 + index * 8);
    const offset = bytes.readUInt32BE(16 + index * 8);
    if (offset > length - 8) throw new Error("Vigil refused a malformed launcher signature index.");
    const blobLength = bytes.readUInt32BE(offset + 4);
    if (blobLength < 8 || blobLength > length - offset) {
      throw new Error("Vigil refused a malformed launcher signature blob.");
    }
    const blob = bytes.subarray(offset, offset + blobLength);
    if (offset < 12 + count * 8) throw new Error("Vigil refused an overlapping launcher signature blob.");
    occupied.push({ start: offset, end: offset + blobLength });
    if (type === 0 || (type >= 0x1000 && type <= 0x1005)) {
      codeDirectories.push(codeDirectorySemantics(type, blob));
    } else if (type < 0x1000 && type !== 3) {
      preservedBlobs.push({ type, sha256: sha256(blob) });
    }
  }
  occupied.sort((left, right) => left.start - right.start);
  let paddingStart = 12 + count * 8;
  for (const range of occupied) {
    if (range.start < paddingStart) throw new Error("Vigil refused overlapping launcher signature blobs.");
    if (bytes.subarray(paddingStart, range.start).some((value) => value !== 0)) {
      throw new Error("Vigil refused non-padding bytes between launcher signature blobs.");
    }
    paddingStart = range.end;
  }
  if (bytes.subarray(paddingStart, length).some((value) => value !== 0)) {
    throw new Error("Vigil refused non-padding bytes after launcher signature blobs.");
  }
  if (!codeDirectories.length) throw new Error("Vigil refused a launcher signature without a CodeDirectory.");
  return { codeDirectories, preservedBlobs };
}

function codeDirectorySemantics(type: number, bytes: Buffer): Record<string, unknown> {
  if (bytes.length < 44 || bytes.readUInt32BE(0) !== 0xfade0c02) {
    throw new Error("Vigil refused a malformed launcher CodeDirectory.");
  }
  const version = bytes.readUInt32BE(8);
  const flags = bytes.readUInt32BE(12);
  const hashOffset = bytes.readUInt32BE(16);
  const nSpecialSlots = bytes.readUInt32BE(24);
  const nCodeSlots = bytes.readUInt32BE(28);
  const codeLimit = bytes.readUInt32BE(32);
  const hashSize = bytes[36];
  const hashType = bytes[37];
  const platform = bytes[38];
  const pageSize = bytes[39];
  if (!hashSize
    || nSpecialSlots > 64
    || nCodeSlots > 10_000_000
    || hashOffset < nSpecialSlots * hashSize
    || hashOffset + nCodeSlots * hashSize > bytes.length) {
    throw new Error("Vigil refused invalid launcher CodeDirectory hash slots.");
  }
  const specialSlots: Array<{ slot: number; sha256: string }> = [];
  const normalized = Buffer.from(bytes);
  for (let slot = 1; slot <= nSpecialSlots; slot += 1) {
    const offset = hashOffset - slot * hashSize;
    if (slot === 3) {
      // Resource envelope intentionally changes for the inert payload and wrappers.
      normalized.fill(0, offset, offset + hashSize);
      continue;
    }
    specialSlots.push({ slot, sha256: sha256(bytes.subarray(offset, offset + hashSize)) });
  }
  return {
    type,
    version,
    flags,
    nSpecialSlots,
    nCodeSlots,
    codeLimit,
    hashSize,
    hashType,
    platform,
    pageSize,
    specialSlots,
    normalizedSha256: sha256(normalized),
    codePageHashesSha256: sha256(bytes.subarray(hashOffset, hashOffset + nCodeSlots * hashSize))
  };
}

async function readBridgeManifest(candidate: string): Promise<{
  bytes: Buffer;
  manifest: UpdateProtocolBridgeEquivalenceManifest;
}> {
  const bridgeRoot = join(candidate, "Contents", "Resources", "VigilUpdater");
  const versionRoot = join(candidate, UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE);
  await assertExactBridgeDirectory(bridgeRoot, 0o755);
  await assertExactBridgeDirectory(versionRoot, 0o755);
  assertExactNames(await readdir(bridgeRoot), ["bridge-equivalence-v1.json", "v3"], bridgeRoot);
  const manifestPath = join(candidate, UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH);
  const bytes = await readPinnedBridgeFile(manifestPath, MAX_MANIFEST_BYTES, 0o644);
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  if (manifest.payloadRoot !== `${portablePath(UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE)}/${manifest.payloadTreeSha256}`) {
    throw new Error("Vigil's bridge manifest does not pin its payload to its exact tree digest.");
  }
  assertExactNames(await readdir(versionRoot), [manifest.payloadTreeSha256], versionRoot);
  const payloadRoot = join(candidate, manifest.payloadRoot);
  const payloadStat = await lstat(payloadRoot);
  if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()) {
    throw new Error("Vigil's bridge payload root is not an exact directory.");
  }
  return { bytes, manifest };
}

async function assertExactBridgeDirectory(path: string, mode: number): Promise<void> {
  const stat = await lstat(path);
  const xattrs = await extendedAttributes(path, false);
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o7777) !== mode
    || !onlySystemProvenance(xattrs)) {
    throw new Error(`Vigil refused unsafe bridge directory metadata at ${path}.`);
  }
}

function assertExactNames(observed: string[], expected: string[], path: string): void {
  observed.sort();
  expected.sort();
  assertSafeDirectoryNames(observed, path);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`Vigil refused unexpected bridge content under ${path}.`);
  }
}

async function readPinnedBridgeFile(path: string, maxBytes: number, mode: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.isSymbolicLink()
      || (before.mode & 0o7777) !== mode
      || before.size > maxBytes
      || !onlySystemProvenance(await extendedAttributes(path, false))) {
      throw new Error(`Vigil refused unsafe bridge file metadata at ${path}.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) {
      throw new Error(`Vigil refused a changing bridge file at ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function onlySystemProvenance(xattrs: Array<{ name: string; sha256: string }>): boolean {
  return xattrs.length <= 1 && xattrs.every((entry) => entry.name === "com.apple.provenance");
}

async function assertSignedBridgeSeal(
  candidate: string,
  installedAppPath: string | null,
  manifest: UpdateProtocolBridgeEquivalenceManifest,
  payloadTree: TreeEntry[]
): Promise<void> {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  const candidateRules = await readCodeResourceRulesSha256(candidate, true);
  if (candidateRules !== manifest.codeResourceRulesSha256) {
    throw new Error("Vigil's signed bridge changed generation A's CodeResources omission rules.");
  }
  if (installedAppPath !== null
    && await readCodeResourceRulesSha256(installedAppPath, true) !== candidateRules) {
    throw new Error("Vigil's signed bridge CodeResources rules do not match installed generation A.");
  }
  const sealed = await codeResourceFileKeys(candidate, "files2");
  const required = new Set<string>([
    portablePath(UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH).replace(/^Contents\//u, ""),
    ...WRAPPERS.map((wrapper) => portablePath(wrapper.relativePath).replace(/^Contents\//u, "")),
    ...payloadTree
      .filter((entry) => entry.type === "file")
      .map((entry) => portablePath(join(manifest.payloadRoot, entry.path)).replace(/^Contents\//u, ""))
  ]);
  for (const path of required) {
    if (!sealed.has(path)) throw new Error(`Vigil's signed bridge does not seal changed resource ${path}.`);
  }
}

async function readCodeResourceRulesSha256(appPath: string, required: boolean): Promise<string> {
  const path = join(appPath, "Contents", "_CodeSignature", "CodeResources");
  if (!await pathExists(path)) {
    if (required) throw new Error("Vigil's signed bridge is missing its CodeResources envelope.");
    return sha256(Buffer.alloc(0));
  }
  const [rules, rules2] = await Promise.all([
    extractCodeResourcesPlist(path, "rules"),
    extractCodeResourcesPlist(path, "rules2")
  ]);
  return sha256(Buffer.from(`${rules}\n${rules2}\n`, "utf8"));
}

async function codeResourceFileKeys(appPath: string, dictionary: string): Promise<Set<string>> {
  const path = join(appPath, "Contents", "_CodeSignature", "CodeResources");
  const xml = await extractCodeResourcesPlist(path, dictionary);
  const keys = new Set<string>();
  for (const match of xml.matchAll(/<key>([^<]+)<\/key>/gu)) keys.add(decodeXml(match[1] || ""));
  return keys;
}

async function extractCodeResourcesPlist(path: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/plutil",
    ["-extract", key, "xml1", "-o", "-", path],
    { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }
  );
  return stdout.trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function validateManifest(value: unknown): UpdateProtocolBridgeEquivalenceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vigil's bridge manifest is invalid.");
  const manifest = value as Partial<UpdateProtocolBridgeEquivalenceManifest>;
  if (manifest.kind !== "vigil-update-protocol-bridge-equivalence-v1"
    || manifest.version !== UPDATE_PROTOCOL_BRIDGE_EQUIVALENCE_VERSION
    || manifest.payloadVersion !== UPDATE_PROTOCOL_BRIDGE_PAYLOAD_VERSION
    || typeof manifest.payloadRoot !== "string"
    || !new RegExp(`^${regexEscape(portablePath(UPDATE_PROTOCOL_BRIDGE_PAYLOAD_RELATIVE_BASE))}/[a-f0-9]{64}$`, "u")
      .test(manifest.payloadRoot)
    || !validSha256(manifest.equivalentTreeSha256)
    || !validSha256(manifest.payloadTreeSha256)
    || !validSha256(manifest.baselineBuildInfoSha256)
    || !validSha256(manifest.codeResourceRulesSha256)
    || !validSha256(manifest.wrappersSha256)
    || !Array.isArray(manifest.wrappers)
    || manifest.wrappers.length !== WRAPPERS.length) {
    throw new Error("Vigil's bridge manifest is invalid.");
  }
  const records = manifest.wrappers as UpdateProtocolBridgeWrapperRecord[];
  for (const definition of WRAPPERS) {
    const matches = records.filter((record) => record?.kind === definition.kind);
    if (matches.length !== 1
      || matches[0].path !== portablePath(definition.relativePath)
      || matches[0].payloadModule !== definition.payloadModule
      || !Number.isInteger(matches[0].mode)
      || matches[0].mode < 0
      || matches[0].mode > 0o7777
      || typeof matches[0].baselinePresent !== "boolean"
      || (!definition.mayBeAdded && matches[0].baselinePresent !== true)
      || !validXattrs(matches[0].xattrs)
      || !validSha256(matches[0].sha256)) {
      throw new Error("Vigil's bridge wrapper manifest is invalid.");
    }
  }
  return manifest as UpdateProtocolBridgeEquivalenceManifest;
}

function assertSameTree(left: TreeEntry[], right: TreeEntry[]): void {
  if (left.length !== right.length) throw new Error("Vigil's bridge candidate changed the protected app tree.");
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      throw new Error(`Vigil's bridge candidate changed protected startup content at ${left[index]?.path || right[index]?.path}.`);
    }
  }
}

function treeSha256(entries: TreeEntry[]): string {
  return sha256(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8"));
}

function wrappersSha256(records: UpdateProtocolBridgeWrapperRecord[]): string {
  const ordered = [...records].sort((left, right) => left.kind.localeCompare(right.kind));
  return sha256(Buffer.from(`${ordered.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"));
}

function isOuterSignatureMetadata(path: string): boolean {
  return path === "Contents/CodeResources"
    || path === "Contents/_CodeSignature"
    || path.startsWith("Contents/_CodeSignature/");
}

function isWrapper(path: string): boolean {
  return WRAPPERS.some((wrapper) => portablePath(wrapper.relativePath) === path);
}

async function assertNoBridgePayload(appPath: string): Promise<void> {
  for (const path of [
    join(appPath, "Contents", "Resources", "VigilUpdater"),
    join(appPath, UPDATE_PROTOCOL_BRIDGE_MANIFEST_RELATIVE_PATH)
  ]) {
    try {
      await lstat(path);
      throw new Error("Vigil refused to treat an existing bridge payload as installed generation A.");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }
}

async function exactAppDirectory(path: string, label: string): Promise<string> {
  const exact = await exactDirectory(path, label);
  if (basename(exact) !== "Vigil.app") throw new Error(`Vigil's ${label} is not the exact Vigil.app bundle.`);
  return exact;
}

async function exactDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`Vigil's ${label} path is not canonical.`);
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]);
  if (canonical !== path || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Vigil's ${label} is not a safe exact directory.`);
  }
  return path;
}

function safeCandidatePath(path: string, installed: string, payload: string): string {
  if (!isAbsolute(path)
    || resolve(path) !== path
    || basename(path) !== "Vigil.app"
    || path === installed
    || path === payload
    || installed.startsWith(`${path}${sep}`)
    || payload.startsWith(`${path}${sep}`)) {
    throw new Error("Vigil refused an unsafe update-protocol bridge candidate path.");
  }
  return path;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validXattrs(value: unknown): value is Array<{ name: string; sha256: string }> {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry
      || typeof entry !== "object"
      || typeof entry.name !== "string"
      || !entry.name
      || names.has(entry.name)
      || !validSha256(entry.sha256)) return false;
    names.add(entry.name);
  }
  return [...names].sort().every((name, index) => name === value[index]?.name);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) continue;
    values.set(name.slice(2), argv[index + 1] || "");
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

if (isDirectRun(import.meta.url)) {
  const values = parseArgs(process.argv.slice(2));
  const verifyCandidate = values.get("verify-candidate");
  const evidence = verifyCandidate
    ? await verifyUpdateProtocolBridgeEquivalence(
      values.get("installed-app") ? await realpath(resolve(required(values, "installed-app"))) : null,
      await realpath(resolve(verifyCandidate))
    )
    : await packageUpdateProtocolBridgeCandidate({
      installedAppPath: await realpath(resolve(required(values, "installed-app"))),
      runtimePayloadPath: await realpath(resolve(required(values, "runtime-payload"))),
      candidateAppPath: resolve(required(values, "output-app")),
      signingIdentity: values.get("signing-identity") || undefined
    });
  process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
}
