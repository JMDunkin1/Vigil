import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const labels = ["com.vigil.agent", "tech.caseline.vigil.agent"];

for (const label of labels) {
  const plistPath = join(process.env.HOME, "Library", "LaunchAgents", `${label}.plist`);
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { timeout: 5000 });
  } catch {
    // Already unloaded.
  }
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { timeout: 5000 });
  } catch {
    // Already unloaded.
  }
  await rm(plistPath, { force: true });
  console.log(`Removed LaunchAgent: ${plistPath}`);
}
