import { execFile } from "node:child_process";
import { access, chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.SENTINEL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const CHECKPOINT_ROOT = join(DATA_DIR, "ios-checkpoints");
const DEFAULT_SUPERVISOR_KEYBAG_PATH = join(DATA_DIR, "sentinel-supervisor.keybag");
const DEFAULT_ORGANIZATION = "Sentinel";
const INSTALL_TIMEOUT_MS = 120_000;
const BACKUP_TIMEOUT_MS = 60 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 60 * 60 * 1000;
const RECONNECT_TIMEOUT_MS = 10 * 60 * 1000;
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
if (!options.confirm) {
  throw new Error([
    "Refusing to supervise and restore without explicit confirmation.",
    "This flow creates a full local backup, supervises the iPhone, restores that backup to recover Home Screen layout, then applies Sentinel.",
    "Rerun with --yes-supervise-and-restore after confirming the phone is unlocked, trusted, and has enough time/power to finish."
  ].join("\n"));
}

await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
const initialCloud = await readCloudConfiguration(udid);
if (isSupervisedCloud(initialCloud)) {
  console.log(`iPhone ${udid} is already supervised; skipping backup/restore supervision and applying Sentinel normally.`);
  if (!options.skipApplyProfile) await applySentinelProfile(udid, await requireSupervisorKeybag(options.supervisorKeybag));
  process.exit(0);
}

const checkpointRoot = await createCheckpoint(udid, options);
const layoutPaths = await verifyCheckpoint(checkpointRoot, udid);
const supervisorKeybagPath = await ensureSupervisorKeybag(options.supervisorKeybag, options.organization);

await superviseDevice(udid, options.organization, supervisorKeybagPath);
await waitForUsbDevice(udid, "after supervision", RECONNECT_TIMEOUT_MS);
const supervisedCloud = await readCloudConfiguration(udid);
if (!isSupervisedCloud(supervisedCloud)) {
  throw new Error("iPhone supervision command completed, but the device still does not report IsSupervised=true. Stopping before backup restore/profile install.");
}

await restoreCheckpoint(udid, checkpointRoot, options.password);
await waitForUsbDevice(udid, "after layout restore", RECONNECT_TIMEOUT_MS);
const restoredCloud = await readCloudConfiguration(udid);
if (!isSupervisedCloud(restoredCloud)) {
  throw new Error([
    "The layout restore finished, but the iPhone no longer reports IsSupervised=true.",
    "Sentinel will not apply the supervised restrictions profile until supervision is intact.",
    `The verified checkpoint remains at: ${checkpointRoot}`
  ].join("\n"));
}

if (!options.skipApplyProfile) await applySentinelProfile(udid, supervisorKeybagPath, checkpointRoot);

console.log([
  `Sentinel supervised ${udid} with layout recovery.`,
  `Checkpoint restored from: ${checkpointRoot}`,
  `Verified layout records before supervision: ${layoutPaths.length}`,
  `Supervisor keybag: ${supervisorKeybagPath}`,
  options.skipApplyProfile ? "Sentinel profile install was skipped." : "Sentinel profile was applied after layout restore."
].join("\n"));

function parseArgs(args) {
  const output = {
    confirm: false,
    minFreeGib: Number(process.env.IOS_CHECKPOINT_MIN_FREE_GB || DEFAULT_MIN_FREE_GIB),
    organization: process.env.SENTINEL_SUPERVISOR_ORGANIZATION || DEFAULT_ORGANIZATION,
    output: "",
    password: process.env.IOS_BACKUP_PASSWORD || "",
    skipApplyProfile: false,
    supervisorKeybag: String(process.env.SENTINEL_SUPERVISOR_KEYBAG || "").trim(),
    udid: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    if (arg === "--yes-supervise-and-restore") output.confirm = true;
    if (arg === "--skip-apply-profile") output.skipApplyProfile = true;
    if (arg === "--udid") output.udid = String(args[index + 1] || "").trim();
    if (arg.startsWith("--udid=")) output.udid = arg.slice("--udid=".length).trim();
    if (arg === "--output") output.output = String(args[index + 1] || "").trim();
    if (arg.startsWith("--output=")) output.output = arg.slice("--output=".length).trim();
    if (arg === "--password") output.password = String(args[index + 1] || "");
    if (arg.startsWith("--password=")) output.password = arg.slice("--password=".length);
    if (arg === "--min-free-gb") output.minFreeGib = Number(args[index + 1] || output.minFreeGib);
    if (arg.startsWith("--min-free-gb=")) output.minFreeGib = Number(arg.slice("--min-free-gb=".length));
    if (arg === "--organization") output.organization = String(args[index + 1] || output.organization).trim();
    if (arg.startsWith("--organization=")) output.organization = arg.slice("--organization=".length).trim();
    if (arg === "--supervisor-keybag" || arg === "--keybag") output.supervisorKeybag = String(args[index + 1] || "").trim();
    if (arg.startsWith("--supervisor-keybag=")) output.supervisorKeybag = arg.slice("--supervisor-keybag=".length).trim();
    if (arg.startsWith("--keybag=")) output.supervisorKeybag = arg.slice("--keybag=".length).trim();
  }
  if (!Number.isFinite(output.minFreeGib) || output.minFreeGib <= 0) output.minFreeGib = DEFAULT_MIN_FREE_GIB;
  if (!output.organization) output.organization = DEFAULT_ORGANIZATION;
  return output;
}

async function createCheckpoint(udid, options) {
  const minFreeBytes = Math.max(1, options.minFreeGib || DEFAULT_MIN_FREE_GIB) * GIB;
  const checkpointRoot = resolve(options.output || join(CHECKPOINT_ROOT, `${timestamp()}-${udid}`));
  await mkdir(checkpointRoot, { recursive: true });
  await assertFreeSpace(checkpointRoot, minFreeBytes);
  await runPymobiledevice3([
    "backup2",
    "backup",
    "--udid",
    udid,
    "--full",
    ...passwordArgs(options.password),
    checkpointRoot
  ], BACKUP_TIMEOUT_MS);
  await verifyCheckpoint(checkpointRoot, udid);
  return checkpointRoot;
}

async function verifyCheckpoint(path, udid) {
  const manifestPath = join(path, udid, "Manifest.db");
  const statusPath = join(path, udid, "Status.plist");
  const infoPath = join(path, udid, "Info.plist");
  const manifest = await stat(manifestPath).catch(() => null);
  const status = await stat(statusPath).catch(() => null);
  const info = await stat(infoPath).catch(() => null);
  if (!manifest?.isFile() || manifest.size <= 0) {
    throw new Error(`Required iPhone checkpoint is missing Manifest.db for ${udid}: ${manifestPath}`);
  }
  if (!status?.isFile() || status.size <= 0 || !info?.isFile() || info.size <= 0) {
    throw new Error(`Required iPhone checkpoint is missing complete backup metadata for ${udid}: ${path}`);
  }
  const layoutPaths = await readLayoutPaths(manifestPath);
  if (!layoutPaths.length) {
    throw new Error([
      `Required iPhone checkpoint has Manifest.db for ${udid}, but no SpringBoard/Home Screen layout records were found.`,
      `Checkpoint path: ${path}`,
      "Do not use this checkpoint as a layout recovery source."
    ].join("\n"));
  }
  return layoutPaths;
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

async function ensureSupervisorKeybag(requestedPath = "", organization = DEFAULT_ORGANIZATION) {
  const keybagPath = requestedPath ? resolve(requestedPath) : DEFAULT_SUPERVISOR_KEYBAG_PATH;
  const existing = await stat(keybagPath).catch(() => null);
  if (existing?.isFile() && existing.size > 0) {
    await chmod(keybagPath, 0o600);
    return keybagPath;
  }
  await mkdir(dirname(keybagPath), { recursive: true });
  await runPymobiledevice3(["profile", "create-keybag", keybagPath, organization], QUICK_TIMEOUT_MS);
  await chmod(keybagPath, 0o600);
  return keybagPath;
}

async function requireSupervisorKeybag(requestedPath = "") {
  const keybagPath = requestedPath ? resolve(requestedPath) : DEFAULT_SUPERVISOR_KEYBAG_PATH;
  const keybag = await stat(keybagPath).catch(() => null);
  if (!keybag?.isFile() || keybag.size <= 0) {
    throw new Error(`Already-supervised apply requires the matching supervisor keybag: ${keybagPath}`);
  }
  await chmod(keybagPath, 0o600);
  return keybagPath;
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

async function waitForUsbDevice(udid, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSummary = "";
  while (Date.now() < deadline) {
    const devices = await listUsbDevices().catch((error) => {
      lastSummary = String(error?.message || error || "");
      return [];
    });
    if (devices.some((device) => deviceUdid(device) === udid)) return;
    lastSummary = devices.map(usbDeviceSummary).join(", ");
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${udid} to reappear over USB ${phase}.${lastSummary ? ` Last seen: ${lastSummary}` : ""}`);
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

async function readCloudConfiguration(udid) {
  const { stdout } = await runPymobiledevice3(["profile", "cloud-configuration", "--udid", udid], QUICK_TIMEOUT_MS);
  const parsed = JSON.parse(stdout.trim());
  return parsed && typeof parsed === "object" ? parsed : {};
}

function isSupervisedCloud(cloud) {
  return Boolean(cloud && typeof cloud === "object" && cloud.IsSupervised);
}

async function superviseDevice(udid, organization, supervisorKeybagPath) {
  await runPymobiledevice3([
    "profile",
    "supervise",
    "--udid",
    udid,
    "--keybag",
    supervisorKeybagPath,
    organization
  ], QUICK_TIMEOUT_MS);
}

async function restoreCheckpoint(udid, checkpointRoot, password) {
  await runPymobiledevice3([
    "backup2",
    "restore",
    "--udid",
    udid,
    "--system",
    "--settings",
    "--remove",
    "--source",
    udid,
    ...passwordArgs(password),
    checkpointRoot
  ], RESTORE_TIMEOUT_MS);
}

async function applySentinelProfile(udid, supervisorKeybagPath, checkpointRoot = "") {
  const args = [
    join(ROOT, "scripts", "apply-ios-usb-profile.mjs"),
    "--udid",
    udid,
    "--supervisor-keybag",
    supervisorKeybagPath
  ];
  if (checkpointRoot) args.push("--require-checkpoint", checkpointRoot);
  await execFileAsync("node", args, {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
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
    "Free space or pass --output=/Volumes/ExternalDrive/sentinel-ios-checkpoints before supervising."
  ].join("\n"));
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

function passwordArgs(password) {
  return password ? ["--password", password] : [];
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
