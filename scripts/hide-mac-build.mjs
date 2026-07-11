import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launchServicesRegister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

if (process.platform === "darwin") await unregisterMacBuild(projectRoot);

export async function unregisterMacBuild(root) {
  const outputFolder = process.arch === "arm64" ? "mac-arm64" : "mac";
  const appPath = join(root, "dist", "mac.noindex", outputFolder, "Vigil.app");
  try {
    await access(appPath);
    try {
      await execFileAsync(launchServicesRegister, ["-u", await realpath(appPath)]);
    } catch {
      // A .noindex build is normally absent from Launch Services already.
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}
