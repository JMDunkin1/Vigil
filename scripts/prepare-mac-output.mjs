import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform === "darwin") await prepareMacOutput(projectRoot);

export async function prepareMacOutput(root) {
  const outputLink = join(root, "dist", "mac.noindex");
  const outputRoot = join(homedir(), "Library", "Caches", "Vigil", "mac.noindex");
  await mkdir(dirname(outputLink), { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  try {
    const stats = await lstat(outputLink);
    if (stats.isSymbolicLink() && resolve(dirname(outputLink), await readlink(outputLink)) === outputRoot) return;
    await rm(outputLink, { recursive: true, force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await symlink(outputRoot, outputLink, "dir");
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}
