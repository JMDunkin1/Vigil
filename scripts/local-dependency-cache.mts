import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CACHE_SCHEMA = 1;
const CACHE_DIRECTORY = "local-dependencies-v1";
const READY_FILENAME = "ready.json";
const REQUIRED_PACKAGES = ["@electron/asar", "electron", "electron-builder", "typescript"] as const;

export interface LocalDependencyCacheDescriptor {
  schema: 1;
  architecture: string;
  key: string;
  nodePath: string;
  nodeVersion: string;
  npmPath: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  packageVersions: Record<string, string>;
  platform: NodeJS.Platform;
}

interface LocalDependencyCacheMarker extends LocalDependencyCacheDescriptor {
  installedPackageLockSha256: string;
  nodeModulesTreeSha256: string;
}

export async function describeLocalDependencyCache(
  snapshotRoot: string,
  nodePath: string,
  npmPath: string
): Promise<LocalDependencyCacheDescriptor> {
  const [packageBytes, lockBytes, canonicalNode, canonicalNpm] = await Promise.all([
    readFile(join(snapshotRoot, "package.json")),
    readFile(join(snapshotRoot, "package-lock.json")),
    realpath(nodePath),
    realpath(npmPath)
  ]);
  const lock = JSON.parse(lockBytes.toString("utf8")) as {
    packages?: Record<string, { version?: unknown }>;
  };
  const packageVersions: Record<string, string> = {};
  for (const name of REQUIRED_PACKAGES) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== "string" || !version) {
      throw new Error(`Vigil's lockfile is missing the exact ${name} dependency version.`);
    }
    packageVersions[name] = version;
  }
  const record: Omit<LocalDependencyCacheDescriptor, "key"> = {
    schema: CACHE_SCHEMA,
    architecture: process.arch,
    nodePath: canonicalNode,
    nodeVersion: process.version,
    npmPath: canonicalNpm,
    packageJsonSha256: sha256(packageBytes),
    packageLockSha256: sha256(lockBytes),
    packageVersions,
    platform: process.platform
  };
  return {
    ...record,
    key: sha256(Buffer.from(JSON.stringify(record), "utf8"))
  };
}

export async function attachLocalDependencyCache(
  snapshotRoot: string,
  updaterDir: string,
  descriptor: LocalDependencyCacheDescriptor
): Promise<boolean> {
  const cacheRoot = localDependencyCacheRoot(updaterDir, descriptor.key);
  if (!await localDependencyCacheReady(cacheRoot, descriptor)) return false;
  await assertSnapshotNodeModulesMissing(snapshotRoot);
  await symlink(join(cacheRoot, "node_modules"), join(snapshotRoot, "node_modules"), "dir");
  return true;
}

export async function publishLocalDependencyCache(
  snapshotRoot: string,
  updaterDir: string,
  descriptor: LocalDependencyCacheDescriptor
): Promise<void> {
  const sourceNodeModules = join(snapshotRoot, "node_modules");
  const sourceStats = await lstat(sourceNodeModules);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("Vigil's freshly installed dependency tree is unsafe.");
  }
  const [installedPackageLockSha256, nodeModulesTreeSha256] = await Promise.all([
    readFile(join(sourceNodeModules, ".package-lock.json")).then(sha256),
    hashLocalDependencyTree(sourceNodeModules)
  ]);
  const cacheParent = join(updaterDir, CACHE_DIRECTORY);
  await mkdir(cacheParent, { recursive: true, mode: 0o700 });
  await chmod(cacheParent, 0o700);
  await assertPrivateDirectory(cacheParent, "dependency cache directory");
  const cacheRoot = localDependencyCacheRoot(updaterDir, descriptor.key);
  if (await pathExists(cacheRoot)) {
    if (await localDependencyCacheReady(cacheRoot, descriptor)) {
      await rm(sourceNodeModules, { recursive: true, force: true });
      await symlink(join(cacheRoot, "node_modules"), sourceNodeModules, "dir");
      return;
    }
    await rename(cacheRoot, `${cacheRoot}.invalid-${randomUUID()}`);
  }

  const temporaryRoot = await mkdtemp(join(cacheParent, `.${descriptor.key}-`));
  const temporaryNodeModules = join(temporaryRoot, "node_modules");
  let published = false;
  try {
    await rename(sourceNodeModules, temporaryNodeModules);
    const marker: LocalDependencyCacheMarker = { ...descriptor, installedPackageLockSha256, nodeModulesTreeSha256 };
    await writeFile(join(temporaryRoot, READY_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryRoot, cacheRoot);
    published = true;
    await symlink(join(cacheRoot, "node_modules"), sourceNodeModules, "dir");
  } catch (error) {
    if (!published && !await pathExists(sourceNodeModules) && await pathExists(temporaryNodeModules)) {
      await rename(temporaryNodeModules, sourceNodeModules).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!published) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function localDependencyCacheRoot(updaterDir: string, key: string): string {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Vigil's dependency cache key is invalid.");
  return join(updaterDir, CACHE_DIRECTORY, key);
}

export function localDependencyCacheMarkerMatches(
  marker: Partial<LocalDependencyCacheMarker>,
  descriptor: LocalDependencyCacheDescriptor
): marker is LocalDependencyCacheMarker {
  return marker.schema === descriptor.schema
    && marker.architecture === descriptor.architecture
    && marker.key === descriptor.key
    && marker.nodePath === descriptor.nodePath
    && marker.nodeVersion === descriptor.nodeVersion
    && marker.npmPath === descriptor.npmPath
    && marker.packageJsonSha256 === descriptor.packageJsonSha256
    && marker.packageLockSha256 === descriptor.packageLockSha256
    && marker.platform === descriptor.platform
    && Boolean(marker.installedPackageLockSha256 && /^[a-f0-9]{64}$/u.test(marker.installedPackageLockSha256))
    && Boolean(marker.nodeModulesTreeSha256 && /^[a-f0-9]{64}$/u.test(marker.nodeModulesTreeSha256))
    && JSON.stringify(marker.packageVersions) === JSON.stringify(descriptor.packageVersions);
}

async function localDependencyCacheReady(
  cacheRoot: string,
  descriptor: LocalDependencyCacheDescriptor
): Promise<boolean> {
  try {
    await assertPrivateDirectory(cacheRoot, "dependency cache generation");
    const markerPath = join(cacheRoot, READY_FILENAME);
    const [markerStats, markerRaw, nodeModulesStats] = await Promise.all([
      lstat(markerPath),
      readFile(markerPath, "utf8"),
      lstat(join(cacheRoot, "node_modules"))
    ]);
    if (!markerStats.isFile()
      || markerStats.isSymbolicLink()
      || markerStats.uid !== currentUid()
      || (markerStats.mode & 0o077) !== 0
      || !nodeModulesStats.isDirectory()
      || nodeModulesStats.isSymbolicLink()) return false;
    const marker = JSON.parse(markerRaw) as Partial<LocalDependencyCacheMarker>;
    if (!localDependencyCacheMarkerMatches(marker, descriptor)) return false;
    const installedLock = await readFile(join(cacheRoot, "node_modules", ".package-lock.json"));
    if (sha256(installedLock) !== marker.installedPackageLockSha256) return false;
    for (const [name, version] of Object.entries(descriptor.packageVersions)) {
      const manifest = JSON.parse(await readFile(join(cacheRoot, "node_modules", ...name.split("/"), "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (manifest.version !== version) return false;
    }
    if (await hashLocalDependencyTree(join(cacheRoot, "node_modules")) !== marker.nodeModulesTreeSha256) return false;
    return true;
  } catch {
    return false;
  }
}

export async function hashLocalDependencyTree(root: string): Promise<string> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Vigil's dependency tree root is unsafe.");
  }
  const entries = (await readdir(root, { recursive: true, withFileTypes: true }))
    .map((entry) => {
      const absolutePath = join(entry.parentPath, entry.name);
      return {
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/")
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const digests = new Array<string>(entries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(16, Math.max(entries.length, 1)) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      digests[index] = await hashDependencyTreeEntry(root, entries[index].absolutePath, entries[index].relativePath);
    }
  });
  await Promise.all(workers);
  const aggregate = createHash("sha256");
  aggregate.update(`root\0${rootStats.mode & 0o777}\0`);
  for (let index = 0; index < entries.length; index += 1) {
    const path = entries[index].relativePath;
    aggregate.update(`${Buffer.byteLength(path, "utf8")}:`);
    aggregate.update(path);
    aggregate.update("\0");
    aggregate.update(digests[index]);
    aggregate.update("\0");
  }
  return aggregate.digest("hex");
}

async function hashDependencyTreeEntry(root: string, path: string, relativePath: string): Promise<string> {
  const stats = await lstat(path);
  const entryHash = createHash("sha256");
  entryHash.update(`${stats.mode & 0o777}\0`);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    entryHash.update("directory");
    return entryHash.digest("hex");
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    const targetWithinRoot = relative(root, resolvedTarget);
    if (isAbsolute(target) || targetWithinRoot === ".." || targetWithinRoot.startsWith(`..${sep}`)) {
      throw new Error(`Vigil's dependency cache contains an unsafe symlink at ${relativePath}.`);
    }
    entryHash.update("symlink\0");
    entryHash.update(target);
    return entryHash.digest("hex");
  }
  if (!stats.isFile()) throw new Error(`Vigil's dependency cache contains an unsafe entry at ${relativePath}.`);
  entryHash.update("file\0");
  const contentHash = createHash("sha256");
  for await (const chunk of createReadStream(path)) contentHash.update(chunk);
  entryHash.update(contentHash.digest());
  return entryHash.digest("hex");
}

async function assertSnapshotNodeModulesMissing(snapshotRoot: string): Promise<void> {
  if (await pathExists(join(snapshotRoot, "node_modules"))) {
    throw new Error("The isolated source snapshot already contains a dependency tree.");
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== currentUid()
    || (value.mode & 0o077) !== 0) {
    throw new Error(`Vigil's ${label} is unsafe.`);
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Vigil could not determine the dependency-cache owner.");
  return uid;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
