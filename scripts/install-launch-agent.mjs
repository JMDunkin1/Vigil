import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.HOME;
const label = "com.vigil.agent";
const legacyLabel = "tech.caseline.vigil.agent";
const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
const legacyPlistPath = join(home, "Library", "LaunchAgents", `${legacyLabel}.plist`);
const logDir = join(home, "Library", "Logs", "Vigil");
const nodePath = process.execPath;
const runnerPath = join(root, "scripts", "agent-runner.mjs");
const environment = launchAgentEnvironment();

await cleanupLegacyLaunchAgent();
await mkdir(dirname(plistPath), { recursive: true });
await mkdir(logDir, { recursive: true });
await writeFile(plistPath, plist(), "utf8");

await runLaunchctl(["bootout", `gui/${process.getuid()}`, plistPath]);
await runLaunchctl(["bootstrap", `gui/${process.getuid()}`, plistPath]);
await runLaunchctl(["enable", `gui/${process.getuid()}/${label}`]);
await runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], { optional: true });

console.log(`Installed LaunchAgent: ${plistPath}`);

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(runnerPath)}</string>
  </array>
${environment}
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, "err.log"))}</string>
</dict>
</plist>
`;
}

function launchAgentEnvironment() {
  const values = {};
  if (process.versions.electron) values.ELECTRON_RUN_AS_NODE = "1";
  if (process.env.VIGIL_DATA_DIR) values.VIGIL_DATA_DIR = process.env.VIGIL_DATA_DIR;
  if (process.env.VIGIL_PORT) values.VIGIL_PORT = process.env.VIGIL_PORT;
  if (process.env.VIGIL_PORT) values.VIGIL_PORT = process.env.VIGIL_PORT;

  const entries = Object.entries(values);
  if (!entries.length) return "";

  const body = entries
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>\n`;
}

async function cleanupLegacyLaunchAgent() {
  await runLaunchctl(["bootout", `gui/${process.getuid()}/${legacyLabel}`], { optional: true });
  await runLaunchctl(["bootout", `gui/${process.getuid()}`, legacyPlistPath], { optional: true });
  await rm(legacyPlistPath, { force: true });
}

async function runLaunchctl(args, options = {}) {
  try {
    await execFileAsync("/bin/launchctl", args, { timeout: 5000 });
  } catch (error) {
    if (args[0] !== "bootout" && !options.optional) throw error;
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  })[char]);
}
