import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const labels = ["com.sentinel.agent", "com.local-screen-time.agent"];
const home = process.env.HOME;
if (!home) throw new Error("HOME is required to uninstall Sentinel LaunchAgents.");
const uid = process.getuid?.();
if (uid === undefined) throw new Error("process.getuid is required to uninstall Sentinel LaunchAgents.");

for (const label of labels) {
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 5000 });
  } catch {
    // Already unloaded.
  }
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], { timeout: 5000 });
  } catch {
    // Already unloaded.
  }
  await rm(plistPath, { force: true });
  console.log(`Removed LaunchAgent: ${plistPath}`);
}
