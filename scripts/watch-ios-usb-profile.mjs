import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPLY_SCRIPT = join(ROOT, "scripts", "apply-ios-usb-profile.mjs");
const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const profileLabel = options.profile
  ? `profile ${resolve(options.profile)}`
  : "the active Sentinel iPhone profile from the local server";
console.log(`Waiting for an iPhone over USB to install ${profileLabel}.`);
console.log("Unlock the phone and approve Trust This Computer if iOS asks.");

const startedAt = Date.now();
let attempts = 0;
let lastWaitingMessage = "";

while (true) {
  attempts += 1;
  const result = await runApply(options);
  if (result.code === 0) {
    writeOutput(result);
    console.log("Sentinel USB profile install completed.");
    process.exit(0);
  }

  const detail = `${result.stdout}\n${result.stderr}`.trim();
  const waitingMessage = transientUsbMessage(detail);
  if (!waitingMessage) {
    writeOutput(result);
    console.error("Sentinel USB profile install failed before a safe retry point.");
    process.exit(result.code || 1);
  }

  if (waitingMessage !== lastWaitingMessage || attempts === 1 || attempts % 10 === 0) {
    console.log(`[${new Date().toISOString()}] ${waitingMessage}`);
    lastWaitingMessage = waitingMessage;
  }

  if (options.timeoutMs > 0 && Date.now() - startedAt >= options.timeoutMs) {
    console.error(`Timed out after ${formatDuration(options.timeoutMs)} waiting for a usable iPhone USB connection.`);
    process.exit(1);
  }

  await sleep(options.intervalMs);
}

function parseArgs(values) {
  const parsed = {
    help: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    password: "",
    profile: "",
    requireCheckpoint: "",
    supervisorKeybag: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    udid: ""
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || "";
    if (value === "--help" || value === "-h") parsed.help = true;
    else if (value === "--interval") {
      parsed.intervalMs = parseDuration(values[index + 1], "interval");
      index += 1;
    } else if (value.startsWith("--interval=")) parsed.intervalMs = parseDuration(value.slice("--interval=".length), "interval");
    else if (value === "--timeout") {
      parsed.timeoutMs = parseDuration(values[index + 1], "timeout");
      index += 1;
    } else if (value.startsWith("--timeout=")) parsed.timeoutMs = parseDuration(value.slice("--timeout=".length), "timeout");
    else if (value === "--no-timeout") parsed.timeoutMs = 0;
    else if (value === "--profile") {
      parsed.profile = String(values[index + 1] || "").trim();
      index += 1;
    } else if (value.startsWith("--profile=")) parsed.profile = value.slice("--profile=".length).trim();
    else if (value === "--udid") {
      parsed.udid = String(values[index + 1] || "").trim();
      index += 1;
    } else if (value.startsWith("--udid=")) parsed.udid = value.slice("--udid=".length).trim();
    else if (value === "--require-checkpoint") {
      parsed.requireCheckpoint = String(values[index + 1] || "").trim();
      index += 1;
    } else if (value.startsWith("--require-checkpoint=")) parsed.requireCheckpoint = value.slice("--require-checkpoint=".length).trim();
    else if (value === "--password") {
      parsed.password = String(values[index + 1] || "");
      index += 1;
    } else if (value.startsWith("--password=")) parsed.password = value.slice("--password=".length);
    else if (value === "--supervisor-keybag" || value === "--keybag") {
      parsed.supervisorKeybag = String(values[index + 1] || "").trim();
      index += 1;
    } else if (value.startsWith("--supervisor-keybag=")) parsed.supervisorKeybag = value.slice("--supervisor-keybag=".length).trim();
    else if (value.startsWith("--keybag=")) parsed.supervisorKeybag = value.slice("--keybag=".length).trim();
    else throw new Error(`Unknown option: ${value}`);
  }

  if (parsed.intervalMs < 500) throw new Error("--interval must be at least 500ms.");
  return parsed;
}

function applyArgs(options) {
  const args = [APPLY_SCRIPT];
  if (options.udid) args.push("--udid", options.udid);
  if (options.profile) args.push("--profile", options.profile);
  if (options.requireCheckpoint) args.push("--require-checkpoint", options.requireCheckpoint);
  if (options.password) args.push("--password", options.password);
  if (options.supervisorKeybag) args.push("--supervisor-keybag", options.supervisorKeybag);
  return args;
}

function runApply(options) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, applyArgs(options), {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveRun({ code: 1, stdout, stderr: `${stderr}${String(error?.stack || error)}` });
    });
    child.on("close", (code) => {
      resolveRun({ code: code === null ? 1 : Number(code), stdout, stderr });
    });
  });
}

function transientUsbMessage(detail) {
  if (/No iPhone\/iPad is visible over USB/i.test(detail)) {
    return "No trusted iPhone over USB yet; still waiting.";
  }
  if (/is not visible over USB/i.test(detail)) {
    return "The requested iPhone is not visible over USB yet; still waiting.";
  }
  if (/Trust This Computer|approve Trust|not paired|pairing dialog|PasswordProtectedError|Please unlock/i.test(detail)) {
    return "The iPhone is present but not ready; unlock it and approve Trust This Computer.";
  }
  if (/Status['"]?:\s*['"]?NotNow|ProfileError:\s*invalid response .*NotNow/i.test(detail)) {
    return "The iPhone is present but iOS is not ready for profile install yet; keep it unlocked and still connected.";
  }
  if (/NoDeviceConnected|No device found|Could not find device|Device is not connected|MuxError|MuxException|Connection refused/i.test(detail)) {
    return "USB connection is not ready yet; still waiting.";
  }
  return "";
}

function writeOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function parseDuration(input, label) {
  const raw = String(input || "").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error(`Invalid ${label}: ${input}`);
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid ${label}: ${input}`);
  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1000);
  if (unit === "m") return Math.round(amount * 60 * 1000);
  if (unit === "h") return Math.round(amount * 60 * 60 * 1000);
  throw new Error(`Invalid ${label}: ${input}`);
}

function formatDuration(ms) {
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printHelp() {
  console.log(`Usage: node scripts/watch-ios-usb-profile.mjs [options]

Wait for an iPhone over USB, then delegate to scripts/apply-ios-usb-profile.mjs once.

Options:
  --profile PATH              Install a specific .mobileconfig instead of the active Sentinel profile.
  --udid UDID                 Wait for and apply to a specific USB device.
  --supervisor-keybag PATH    Use the matching supervised-device keybag.
  --require-checkpoint PATH   Require and verify an existing layout checkpoint before applying.
  --password VALUE            Backup password used when verifying --require-checkpoint.
  --interval 3s               Poll interval. Supports ms, s, m, h.
  --timeout 15m               Stop waiting after this duration.
  --no-timeout                Wait indefinitely.
`);
}
