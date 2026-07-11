import { cp, lstat, mkdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (await isDirectRun(import.meta.url, process.argv[1])) await prepareBuildDirectory(projectRoot);

export async function prepareBuildDirectory(root) {
  const buildLink = join(root, "dist");
  const buildRoot = join(root, "dist.nosync");
  let linkReady = false;
  try {
    const stats = await lstat(buildLink);
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(buildLink), await readlink(buildLink));
      if (target !== buildRoot) {
        throw new Error(`Refusing to replace unexpected dist symlink: ${target}`);
      }
      linkReady = true;
    } else if (stats.isDirectory()) {
      if (await pathExists(buildRoot)) {
        await cp(buildLink, buildRoot, { recursive: true, force: true, preserveTimestamps: true });
        await rm(buildLink, { recursive: true, force: true });
      } else {
        await rename(buildLink, buildRoot);
      }
    } else {
      throw new Error("Refusing to replace non-directory dist path.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await mkdir(buildRoot, { recursive: true });
  await writeFile(join(buildRoot, ".metadata_never_index"), "");
  if (!linkReady) await symlink("dist.nosync", buildLink, "dir");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isDirectRun(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return await realpath(fileURLToPath(moduleUrl)) === await realpath(resolve(argvPath));
  } catch {
    return false;
  }
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}
