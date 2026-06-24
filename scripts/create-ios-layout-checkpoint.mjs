import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const CHECKPOINT_ROOT = join(DATA_DIR, "ios-checkpoints");
const INSTALL_TIMEOUT_MS = 120_000;
const BACKUP_TIMEOUT_MS = 60 * 60 * 1000;
const QUICK_TIMEOUT_MS = 20_000;
const GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_GIB = 80;
const LAYOUT_QUERY = `
SELECT domain || '/' || relativePath
FROM Files
WHERE domain = 'HomeDomain'
AND (
  lower(relativePath) LIKE '%iconstate%'
  OR lower(relativePath) LIKE '%homescreen%'
  OR lower(relativePath) LIKE '%springboard%'
  OR lower(relativePath) LIKE '%applicationstate%'
)
ORDER BY relativePath;
`;

const options = parseArgs(process.argv.slice(2));
await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
const minFreeBytes = Math.max(1, options.minFreeGib || DEFAULT_MIN_FREE_GIB) * GIB;
const checkpointRoot = resolve(options.output || join(CHECKPOINT_ROOT, `${timestamp()}-${udid}`));
await mkdir(checkpointRoot, { recursive: true });
await assertFreeSpace(checkpointRoot, minFreeBytes);

await createBackup(udid, checkpointRoot, options.password);
const manifestPath = join(checkpointRoot, udid, "Manifest.db");
await access(manifestPath);
const layoutPaths = await readLayoutPaths(manifestPath);
if (!layoutPaths.length) {
  throw new Error([
    "Local iPhone checkpoint completed, but no SpringBoard/Home Screen layout records were found in Manifest.db.",
    `Checkpoint left in place for inspection: ${checkpointRoot}`,
    "Do not use this checkpoint as a layout recovery source."
  ].join("\n"));
}

console.log([
  "Vigil iPhone layout checkpoint created.",
  `UDID: ${udid}`,
  `Path: ${checkpointRoot}`,
  `Verified layout records: ${layoutPaths.length}`,
  ...layoutPaths.slice(0, 12).map((item) => `- ${item}`)
].join("\n"));

function parseArgs(args) {
  const output = {
    minFreeGib: Number(process.env.IOS_CHECKPOINT_MIN_FREE_GB || DEFAULT_MIN_FREE_GIB),
    output: "",
    password: process.env.IOS_BACKUP_PASSWORD || "",
    udid: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    if (arg === "--udid") output.udid = String(args[index + 1] || "").trim();
    if (arg.startsWith("--udid=")) output.udid = arg.slice("--udid=".length).trim();
    if (arg === "--output") output.output = String(args[index + 1] || "").trim();
    if (arg.startsWith("--output=")) output.output = arg.slice("--output=".length).trim();
    if (arg === "--password") output.password = String(args[index + 1] || "");
    if (arg.startsWith("--password=")) output.password = arg.slice("--password=".length);
    if (arg === "--min-free-gb") output.minFreeGib = Number(args[index + 1] || output.minFreeGib);
    if (arg.startsWith("--min-free-gb=")) output.minFreeGib = Number(arg.slice("--min-free-gb=".length));
  }
  if (!Number.isFinite(output.minFreeGib) || output.minFreeGib <= 0) output.minFreeGib = DEFAULT_MIN_FREE_GIB;
  return output;
}

async function ensurePymobiledevice3() {
  if (process.env.PYMOBILEDEVICE3) {
    await access(PYMOBILEDEVICE3_PATH);
    return;
  }
  if (await fileExists(PYMOBILEDEVICE3_PATH)) return;
  await mkdir(TOOL_ROOT, { recursive: true });
  await execFileAsync("python3", ["-m", "venv", VENV_DIR], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 256 });
  const pip = join(VENV_DIR, "bin", "python");
  await execFileAsync(pip, ["-m", "pip", "install", "--upgrade", "pip", "wheel"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  await execFileAsync(pip, ["-m", "pip", "install", "pymobiledevice3"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
}

async function resolveUsbDevice(requestedUdid = "") {
  const devices = await listUsbDevices();
  if (!Array.isArray(devices) || !devices.length) {
    throw new Error("No iPhone/iPad is visible over USB. Plug the phone in, unlock it, and accept Trust This Computer.");
  }
  if (requestedUdid) {
    const match = devices.find((device) => deviceUdid(device) === requestedUdid);
    if (!match) {
      const summary = devices.map(usbDeviceSummary).join(", ");
      throw new Error(`iPhone/iPad ${requestedUdid} is not visible over USB. Connected USB devices: ${summary}`);
    }
    return requestedUdid;
  }
  if (devices.length > 1) {
    const summary = devices.map(usbDeviceSummary).join(", ");
    throw new Error(`Multiple USB devices found; rerun with --udid. Devices: ${summary}`);
  }
  const udid = deviceUdid(devices[0]);
  if (!udid) throw new Error("USB device did not report a UDID.");
  return udid;
}

async function listUsbDevices() {
  const { stdout } = await runPymobiledevice3(["usbmux", "list", "--usb"], QUICK_TIMEOUT_MS);
  const devices = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(devices) ? devices : [];
}

function deviceUdid(device) {
  return String(device?.Identifier || device?.UniqueDeviceID || "").trim();
}

function usbDeviceSummary(device) {
  return `${device?.DeviceName || "iOS device"} (${deviceUdid(device) || "unknown udid"})`;
}

async function assertFreeSpace(path, minFreeBytes) {
  const { stdout } = await execFileAsync("/bin/df", ["-Pk", path], { timeout: QUICK_TIMEOUT_MS, maxBuffer: 1024 * 32 });
  const lines = stdout.trim().split(/\r?\n/);
  const parts = String(lines.at(-1) || "").trim().split(/\s+/);
  const availableKiB = Number(parts[3] || 0);
  const availableBytes = availableKiB * 1024;
  if (availableBytes >= minFreeBytes) return;
  throw new Error([
    `Not enough free disk space for a local iPhone checkpoint at ${path}.`,
    `Available: ${formatGib(availableBytes)} GiB.`,
    `Required minimum: ${formatGib(minFreeBytes)} GiB.`,
    "Free space or pass --output=/Volumes/ExternalDrive/vigil-ios-checkpoints before supervising."
  ].join("\n"));
}

async function createBackup(udid, checkpointRoot, password) {
  const args = ["backup2", "backup", "--udid", udid, "--full"];
  if (password) args.push("--password", password);
  args.push(checkpointRoot);
  await runPymobiledevice3(args, BACKUP_TIMEOUT_MS);
}

async function readLayoutPaths(manifestPath) {
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", [manifestPath, LAYOUT_QUERY], {
    timeout: QUICK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function runPymobiledevice3(args, timeout) {
  try {
    return await execFileAsync(PYMOBILEDEVICE3_PATH, args, {
      timeout,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    throw new Error(`${error?.stdout || ""}\n${error?.stderr || error}`.trim());
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function formatGib(bytes) {
  return (bytes / GIB).toFixed(1);
}
