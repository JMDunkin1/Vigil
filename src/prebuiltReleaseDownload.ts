import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  parsePrebuiltReleaseManifest
} from "./prebuiltRelease.js";
import type { VigilPrebuiltReleaseManifest } from "./prebuiltRelease.js";

const MANIFEST_FILENAME = "release-manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const RELEASE_DOWNLOAD_PREFIX = "prebuilt-download-";

export const PREBUILT_UPDATE_MANIFEST_URL_ENV = "VIGIL_PREBUILT_UPDATE_MANIFEST_URL";

type ReleaseFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DownloadedPrebuiltRelease {
  artifactPath: string;
  manifest: VigilPrebuiltReleaseManifest;
  manifestPath: string;
  root: string;
}

export function configuredPrebuiltUpdateManifestUrl(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = environment[PREBUILT_UPDATE_MANIFEST_URL_ENV]?.trim();
  if (!configured) return null;
  return validatedHttpsReleaseUrl(configured, "configured release manifest").toString();
}

/**
 * Download one exact manifest and its named artifact into an invocation-owned,
 * private directory. The caller still has to run the signed-release verifier;
 * this function deliberately treats all network bytes as untrusted.
 */
export async function downloadPrebuiltRelease({
  fetchImpl = globalThis.fetch,
  manifestUrl,
  selectedCommit,
  storageRoot
}: {
  fetchImpl?: ReleaseFetch;
  manifestUrl: string;
  selectedCommit: string;
  storageRoot: string;
}): Promise<DownloadedPrebuiltRelease> {
  if (!/^[a-f0-9]{40}$/u.test(selectedCommit)) {
    throw new Error("The selected upstream commit is missing or malformed.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Vigil runtime cannot download a prebuilt release over HTTPS.");
  }
  const sourceUrl = validatedHttpsReleaseUrl(manifestUrl, "release manifest");
  const privateStorage = await privateStorageDirectory(storageRoot);
  const root = await mkdtemp(join(privateStorage, RELEASE_DOWNLOAD_PREFIX));
  await chmod(root, 0o700);
  try {
    const manifestPath = join(root, MANIFEST_FILENAME);
    await downloadBoundedFile({
      destinationPath: manifestPath,
      fetchImpl,
      maxBytes: MAX_MANIFEST_BYTES,
      sourceUrl
    });
    const manifestBytes = await readPrivateDownloadedFile(manifestPath, MAX_MANIFEST_BYTES);
    const manifest = parsePrebuiltReleaseManifest(manifestBytes.toString("utf8"));
    if (manifest.commit !== selectedCommit) {
      throw new Error(
        `The prebuilt release targets commit ${manifest.commit}, not the selected upstream commit ${selectedCommit}.`
      );
    }

    const artifactUrl = new URL(manifest.artifact, sourceUrl);
    if (artifactUrl.protocol !== "https:" || artifactUrl.origin !== sourceUrl.origin) {
      throw new Error("The release manifest artifact must use the manifest's HTTPS origin.");
    }
    if (basename(artifactUrl.pathname) !== manifest.artifact) {
      throw new Error("The release manifest artifact URL does not preserve its exact filename.");
    }
    const artifactPath = join(root, manifest.artifact);
    await downloadBoundedFile({
      destinationPath: artifactPath,
      expectedBytes: manifest.bytes,
      fetchImpl,
      maxBytes: manifest.bytes,
      sourceUrl: artifactUrl
    });
    return { artifactPath, manifest, manifestPath, root };
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `The prebuilt release failed and its private download could not be cleaned up: ${errorMessage(error)} Cleanup: ${errorMessage(cleanupError)}`
      );
    }
    throw error;
  }
}

export async function cleanupDownloadedPrebuiltRelease(
  downloadRoot: string,
  expectedStorageRoot: string
): Promise<void> {
  const absoluteRoot = resolve(downloadRoot);
  const absoluteStorage = resolve(expectedStorageRoot);
  const [canonicalStorage, storageStat] = await Promise.all([
    realpath(absoluteStorage),
    lstat(absoluteStorage)
  ]);
  const uid = process.getuid?.();
  if (canonicalStorage !== absoluteStorage
    || !storageStat.isDirectory()
    || storageStat.isSymbolicLink()
    || (uid !== undefined && storageStat.uid !== uid)
    || (storageStat.mode & 0o022) !== 0
    || join(absoluteStorage, basename(absoluteRoot)) !== absoluteRoot) {
    throw new Error("Vigil refused to clean a prebuilt release outside the expected private updater directory.");
  }
  if (!/^prebuilt-download-[A-Za-z0-9]{6}$/u.test(basename(absoluteRoot))) {
    throw new Error("Vigil refused to clean an unrecognized prebuilt-release directory.");
  }
  let value: Awaited<ReturnType<typeof lstat>>;
  try {
    value = await lstat(absoluteRoot);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || (uid !== undefined && value.uid !== uid)
    || (value.mode & 0o777) !== 0o700) {
    throw new Error("Vigil refused to clean an unsafe prebuilt-release directory.");
  }
  await rm(absoluteRoot, { recursive: true, force: true });
}

/**
 * Called only while the caller owns the updater lock and no prior recovery
 * manifest is active. It removes bounded attempt directories left by a crash
 * without following or accepting an unsafe same-name entry.
 */
export async function cleanupOrphanedPrebuiltDownloads(storageRoot: string): Promise<void> {
  const privateStorage = await privateStorageDirectory(storageRoot);
  const entries = await readdir(privateStorage, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(RELEASE_DOWNLOAD_PREFIX)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Vigil preserved an unsafe orphaned prebuilt-release entry at ${entry.name}.`);
    }
    await cleanupDownloadedPrebuiltRelease(join(privateStorage, entry.name), privateStorage);
  }
}

async function privateStorageDirectory(storageRoot: string): Promise<string> {
  const absoluteRoot = resolve(storageRoot);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const [realRoot, value] = await Promise.all([realpath(absoluteRoot), lstat(absoluteRoot)]);
  const uid = process.getuid?.();
  if (realRoot !== absoluteRoot
    || !value.isDirectory()
    || value.isSymbolicLink()
    || (uid !== undefined && value.uid !== uid)
    || (value.mode & 0o022) !== 0) {
    throw new Error("Vigil's prebuilt-release storage directory is unsafe.");
  }
  return realRoot;
}

async function downloadBoundedFile({
  destinationPath,
  expectedBytes,
  fetchImpl,
  maxBytes,
  sourceUrl
}: {
  destinationPath: string;
  expectedBytes?: number;
  fetchImpl: ReleaseFetch;
  maxBytes: number;
  sourceUrl: URL;
}): Promise<void> {
  const response = await fetchImpl(sourceUrl, {
    credentials: "omit",
    redirect: "manual",
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new Error(`The HTTPS release download failed with status ${response.status}.`);
  }
  if (response.redirected) {
    throw new Error("Vigil refused a redirected release download.");
  }
  if (response.url) {
    const finalUrl = validatedHttpsReleaseUrl(response.url, "release response");
    if (finalUrl.origin !== sourceUrl.origin || finalUrl.href !== sourceUrl.href) {
      throw new Error("The release response did not come from the exact requested HTTPS URL.");
    }
  }
  const contentLengthText = response.headers.get("content-length");
  if (contentLengthText !== null) {
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength)
      || contentLength < 0
      || contentLength > maxBytes
      || (expectedBytes !== undefined && contentLength !== expectedBytes)) {
      throw new Error("The release server reported an invalid or unexpected byte count.");
    }
  }
  if (!response.body) throw new Error("The release server returned no response body.");

  const handle = await open(
    destinationPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  let bytesWritten = 0;
  let primaryError: unknown;
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (bytesWritten + value.byteLength > maxBytes) {
          throw new Error("The release download exceeded its verified byte limit.");
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(value, offset, value.byteLength - offset, bytesWritten);
          if (result.bytesWritten <= 0) throw new Error("The private release download stopped making progress.");
          offset += result.bytesWritten;
          bytesWritten += result.bytesWritten;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (expectedBytes !== undefined && bytesWritten !== expectedBytes) {
      throw new Error(`The release download ended at ${bytesWritten} bytes; expected ${expectedBytes}.`);
    }
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    const [descriptorStat, pathnameStat] = await Promise.all([
      handle.stat(),
      lstat(destinationPath)
    ]);
    if (!descriptorStat.isFile()
      || !pathnameStat.isFile()
      || pathnameStat.isSymbolicLink()
      || descriptorStat.dev !== pathnameStat.dev
      || descriptorStat.ino !== pathnameStat.ino
      || descriptorStat.size !== bytesWritten
      || pathnameStat.size !== bytesWritten
      || (descriptorStat.mode & 0o777) !== 0o400
      || (pathnameStat.mode & 0o777) !== 0o400) {
      throw new Error("The downloaded release file failed private-storage verification.");
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError === undefined) primaryError = closeError;
  }
  if (primaryError !== undefined) {
    await removeFailedDownload(destinationPath, primaryError);
  }
}

async function readPrivateDownloadedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes || (before.mode & 0o777) !== 0o400) {
      throw new Error("The downloaded release manifest has unsafe metadata.");
    }
    const bytes = await handle.readFile();
    const [after, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (!pathname.isFile()
      || pathname.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== pathname.dev
      || after.ino !== pathname.ino
      || before.size !== after.size
      || after.size !== bytes.length) {
      throw new Error("The downloaded release manifest changed while it was being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validatedHttpsReleaseUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The ${label} URL is invalid.`);
  }
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new Error(`The ${label} URL must be credential-free HTTPS.`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function removeFailedDownload(path: string, primaryError: unknown): Promise<never> {
  try {
    await rm(path, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${errorMessage(primaryError)} Cleanup also failed: ${errorMessage(cleanupError)}`
    );
  }
  throw primaryError;
}
