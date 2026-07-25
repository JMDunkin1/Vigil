import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

const RUNTIME_TREE_DIGEST_KIND = "vigil-runtime-tree-v1" as const;
const MAX_RUNTIME_TREE_ENTRIES = 100_000;
const MAX_RUNTIME_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const READ_BUFFER_BYTES = 1024 * 1024;

export interface RuntimeTreeDigest {
  kind: typeof RUNTIME_TREE_DIGEST_KIND;
  sha256: string;
  entryCount: number;
  totalBytes: number;
  rootDev: number;
  rootIno: number;
}

export interface RuntimeTreeDigestDependencies {
  /**
   * Test-only race seam. Production callers never provide it; keeping the hook
   * after descriptor pinning lets tests deterministically prove that an
   * in-place mutation is rejected.
   */
  afterFilePinned?(path: string): Promise<void>;
}

interface RuntimeTreeEntry {
  path: string;
  type: "directory" | "file";
  mode: number;
  size?: number;
  sha256?: string;
}

/**
 * Capture a portable digest of every path, type, permission mode, and regular
 * file byte in a runtime directory. Symbolic links and special files are
 * rejected. Each file is read through O_NOFOLLOW and its descriptor/path
 * identity and mutation timestamps must remain stable for the whole read.
 */
export async function captureRuntimeTreeDigest(
  rootPathInput: string,
  dependencies: RuntimeTreeDigestDependencies = {}
): Promise<RuntimeTreeDigest> {
  const first = await captureRuntimeTreeDigestOnce(rootPathInput, dependencies);
  const second = await captureRuntimeTreeDigestOnce(rootPathInput, dependencies);
  if (!runtimeTreeDigestContentsMatch(first, second)
    || first.rootDev !== second.rootDev
    || first.rootIno !== second.rootIno) {
    throw new Error("The Vigil runtime tree changed between its complete digest captures.");
  }
  return second;
}

async function captureRuntimeTreeDigestOnce(
  rootPathInput: string,
  dependencies: RuntimeTreeDigestDependencies
): Promise<RuntimeTreeDigest> {
  const rootPath = resolve(rootPathInput);
  if (rootPath !== rootPathInput || await realpath(rootPath) !== rootPath) {
    throw new Error("The Vigil runtime tree must have an exact canonical root path.");
  }
  const rootBefore = await lstat(rootPath);
  assertStableDirectory(rootPath, rootBefore);

  const entries: RuntimeTreeEntry[] = [];
  const totals = { bytes: 0 };
  await walkRuntimeDirectory(rootPath, rootPath, entries, totals, dependencies);

  const [rootAfter, rootCanonicalAfter] = await Promise.all([
    lstat(rootPath),
    realpath(rootPath)
  ]);
  if (rootCanonicalAfter !== rootPath || !stableStatsMatch(rootBefore, rootAfter)) {
    throw new Error("The Vigil runtime tree root changed while its digest was being captured.");
  }

  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  const aggregate = createHash("sha256");
  aggregate.update(`${RUNTIME_TREE_DIGEST_KIND}\n`, "utf8");
  for (const entry of entries) {
    aggregate.update(JSON.stringify(entry), "utf8");
    aggregate.update("\n", "utf8");
  }
  return {
    kind: RUNTIME_TREE_DIGEST_KIND,
    sha256: aggregate.digest("hex"),
    entryCount: entries.length,
    totalBytes: totals.bytes,
    rootDev: rootAfter.dev,
    rootIno: rootAfter.ino
  };
}

export function runtimeTreeDigestContentsMatch(
  left: RuntimeTreeDigest,
  right: RuntimeTreeDigest
): boolean {
  return left.kind === right.kind
    && left.sha256 === right.sha256
    && left.entryCount === right.entryCount
    && left.totalBytes === right.totalBytes;
}

async function walkRuntimeDirectory(
  rootPath: string,
  directoryPath: string,
  entries: RuntimeTreeEntry[],
  totals: { bytes: number },
  dependencies: RuntimeTreeDigestDependencies
): Promise<void> {
  const [before, canonicalBefore] = await Promise.all([
    lstat(directoryPath),
    realpath(directoryPath)
  ]);
  if (canonicalBefore !== directoryPath) {
    throw new Error(`The Vigil runtime tree contains a non-canonical directory at ${portablePath(rootPath, directoryPath)}.`);
  }
  assertStableDirectory(directoryPath, before);
  addEntry(entries, {
    path: portablePath(rootPath, directoryPath),
    type: "directory",
    mode: before.mode & 0o7777
  });

  const names = await readdir(directoryPath);
  names.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  for (const name of names) {
    const entryPath = join(directoryPath, name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`The Vigil runtime tree contains a symbolic link at ${portablePath(rootPath, entryPath)}.`);
    }
    if (entryStat.isDirectory()) {
      await walkRuntimeDirectory(rootPath, entryPath, entries, totals, dependencies);
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`The Vigil runtime tree contains an unsafe special entry at ${portablePath(rootPath, entryPath)}.`);
    }
    const file = await hashPinnedRuntimeFile(rootPath, entryPath, entryStat, dependencies);
    totals.bytes += file.size;
    if (!Number.isSafeInteger(totals.bytes) || totals.bytes > MAX_RUNTIME_TREE_BYTES) {
      throw new Error("The Vigil runtime tree exceeds its bounded byte limit.");
    }
    addEntry(entries, {
      path: portablePath(rootPath, entryPath),
      type: "file",
      mode: file.mode,
      size: file.size,
      sha256: file.sha256
    });
  }

  const [after, canonicalAfter] = await Promise.all([
    lstat(directoryPath),
    realpath(directoryPath)
  ]);
  if (canonicalAfter !== directoryPath || !stableStatsMatch(before, after)) {
    throw new Error(`The Vigil runtime directory ${portablePath(rootPath, directoryPath)} changed while it was being hashed.`);
  }
}

async function hashPinnedRuntimeFile(
  rootPath: string,
  path: string,
  pathnameBeforeOpen: Stats,
  dependencies: RuntimeTreeDigestDependencies
): Promise<{ mode: number; sha256: string; size: number }> {
  if (await realpath(path) !== path) {
    throw new Error(`The Vigil runtime tree contains a non-canonical file at ${portablePath(rootPath, path)}.`);
  }
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let result: { mode: number; sha256: string; size: number } | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [before, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (!before.isFile()
      || pathname.isSymbolicLink()
      || !pathname.isFile()
      || !stableStatsMatch(pathnameBeforeOpen, before)
      || !stableStatsMatch(before, pathname)
      || before.size > MAX_RUNTIME_TREE_BYTES) {
      throw new Error(`The Vigil runtime file ${portablePath(rootPath, path)} changed before it could be pinned.`);
    }
    await dependencies.afterFilePinned?.(path);

    const content = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset
      );
      if (bytesRead <= 0) {
        throw new Error(`The Vigil runtime file ${portablePath(rootPath, path)} ended while it was being hashed.`);
      }
      content.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const [after, pathnameAfter, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path)
    ]);
    if (canonicalAfter !== path
      || offset !== before.size
      || !stableStatsMatch(before, after)
      || !stableStatsMatch(after, pathnameAfter)) {
      throw new Error(`The Vigil runtime file ${portablePath(rootPath, path)} changed while it was being hashed.`);
    }
    result = {
      mode: after.mode & 0o7777,
      sha256: content.digest("hex"),
      size: offset
    };
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle?.close();
  } catch (closeError) {
    if (primaryError === undefined) primaryError = closeError;
    else preserveCleanupError(primaryError, closeError);
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw new Error(`The Vigil runtime file ${portablePath(rootPath, path)} produced no digest.`);
  return result;
}

function addEntry(entries: RuntimeTreeEntry[], entry: RuntimeTreeEntry): void {
  if (entries.length >= MAX_RUNTIME_TREE_ENTRIES) {
    throw new Error("The Vigil runtime tree exceeds its bounded entry limit.");
  }
  entries.push(entry);
}

function assertStableDirectory(path: string, value: Stats): void {
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`The Vigil runtime directory ${path} is unsafe.`);
  }
}

function stableStatsMatch(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

function portablePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  return path.slice(rootPath.length + 1).split("/").join("/");
}

function preserveCleanupError(primaryError: unknown, cleanupError: unknown): void {
  if (!(primaryError instanceof Error)) return;
  try {
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: [cleanupError]
    });
  } catch {
    // Preserve the original digest failure if it is not extensible.
  }
}
