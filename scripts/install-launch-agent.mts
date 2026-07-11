import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAgentDataDirFromPlist, launchAgentDataRootsConflict, resolveDefaultDataDir } from "../src/dataPaths.js";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required to install the Vigil LaunchAgent.");
const homeDir = home;
const uid = process.getuid?.();
if (uid === undefined) throw new Error("process.getuid is required to install the Vigil LaunchAgent.");
const label = "com.vigil.agent";
const legacyLabel = "tech.caseline.vigil.agent";
const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
const legacyPlistPath = join(home, "Library", "LaunchAgents", `${legacyLabel}.plist`);
const logDir = join(home, "Library", "Logs", "Vigil");
const nodePath = process.execPath;
const runnerPath = join(root, "scripts", "agent-runner.mjs");
const dataDir = await resolveLaunchAgentDataDir();
const environment = launchAgentEnvironment();

await cleanupLegacyLaunchAgent();
await mkdir(dirname(plistPath), { recursive: true });
await mkdir(logDir, { recursive: true });
await writeFile(plistPath, plist(), "utf8");

await runLaunchctl(["bootout", `gui/${uid}`, plistPath]);
await runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
await runLaunchctl(["enable", `gui/${uid}/${label}`]);
await runLaunchctl(["kickstart", "-k", `gui/${uid}/${label}`], { optional: true });

console.log(`Installed LaunchAgent: ${plistPath}`);

function plist(): string {
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

function launchAgentEnvironment(): string {
  const values: Record<string, string> = {
    VIGIL_DATA_DIR: dataDir
  };
  if (process.versions.electron) values.ELECTRON_RUN_AS_NODE = "1";
  if (process.env.VIGIL_PORT) values.VIGIL_PORT = process.env.VIGIL_PORT;
  if (process.env.VIGIL_PORT) values.VIGIL_PORT = process.env.VIGIL_PORT;

  const entries = Object.entries(values);
  if (!entries.length) return "";

  const body = entries
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>\n`;
}

async function resolveLaunchAgentDataDir(): Promise<string> {
  if (process.env.VIGIL_DATA_DIR) return process.env.VIGIL_DATA_DIR;
  const existingPlist = await optionalRead(plistPath);
  if (existingPlist !== null) {
    const existing = launchAgentDataDirFromPlist(existingPlist);
    if (existing.source === "environment") return existing.dataDir;
    if (existing.source === "working-directory") {
      const currentDataDir = resolveDefaultDataDir(root);
      if (existing.dataDir !== currentDataDir) {
        const [existingHasState, currentHasState] = await Promise.all([
          hasVigilState(existing.dataDir),
          hasVigilState(currentDataDir)
        ]);
        if (launchAgentDataRootsConflict(existing.dataDir, currentDataDir, existingHasState, currentHasState)) {
          throw new Error(
            `Vigil found state in both the existing LaunchAgent data directory ${existing.dataDir} and the current runtime data directory ${currentDataDir}. Set VIGIL_DATA_DIR explicitly before reinstalling the LaunchAgent.`
          );
        }
      }
      return existing.dataDir;
    }
    return resolveDefaultDataDir(root);
  }

  const repositoryData = resolveDefaultDataDir(root);
  const applicationSupportData = join(homeDir, "Library", "Application Support", "Vigil");
  const [repositoryHasState, applicationSupportHasState] = await Promise.all([
    hasVigilState(repositoryData),
    hasVigilState(applicationSupportData)
  ]);
  if (repositoryHasState && applicationSupportHasState) {
    throw new Error(
      `Vigil found state in both ${repositoryData} and ${applicationSupportData}. Set VIGIL_DATA_DIR explicitly before installing the LaunchAgent.`
    );
  }
  return repositoryHasState ? repositoryData : applicationSupportData;
}

async function hasVigilState(directory: string): Promise<boolean> {
  for (const name of [
    "state.json",
    "usage.json",
    "accounts.json",
    "state-seal.key",
    "state.seal.json",
    "source.seal.json",
    "touch-id.key",
    "adult-blocklist.json"
  ]) {
    try {
      await access(join(directory, name));
      return true;
    } catch {
      // Try the next Vigil state file.
    }
  }
  return false;
}

async function optionalRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanupLegacyLaunchAgent(): Promise<void> {
  await runLaunchctl(["bootout", `gui/${uid}/${legacyLabel}`], { optional: true });
  await runLaunchctl(["bootout", `gui/${uid}`, legacyPlistPath], { optional: true });
  await rm(legacyPlistPath, { force: true });
}

async function runLaunchctl(args: string[], options: { optional?: boolean } = {}): Promise<void> {
  try {
    await execFileAsync("/bin/launchctl", args, { timeout: 5000 });
  } catch (error) {
    if (args[0] !== "bootout" && !options.optional) throw error;
  }
}

function escapeXml(value: unknown): string {
  const entities: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  };
  return String(value).replace(/[<>&'"]/g, (char) => entities[char] || char);
}
