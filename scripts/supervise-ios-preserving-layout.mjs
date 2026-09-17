import { execFile } from "node:child_process";
import { access, chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const BUNDLED_PYTHON_PATH = join(VENV_DIR, "bin", "python");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const DEFAULT_SUPERVISOR_KEYBAG_PATH = join(DATA_DIR, "vigil-supervisor.keybag");
const INSTALL_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 20_000;

// Enrollment remains disabled until the escrow-backed, single pre-supervision
// restore in AGENTS.md is implemented and verified. Never resurrect the old
// full-checkpoint restore: it clears supervision. Already-supervised devices
// can still use this command to apply Vigil with their existing keybag.
const options = parseArgs(process.argv.slice(2));
if (!options.confirm) {
  throw new Error([
    "Refusing to supervise and restore without explicit confirmation.",
    "New enrollment is disabled pending the verified single-restore flow documented in AGENTS.md.",
    "For an already-supervised iPhone, rerun with --yes-supervise-and-restore to apply Vigil with its existing supervisor keybag."
  ].join("\n"));
}

await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
const initialCloud = await readCloudConfiguration(udid);
if (isSupervisedCloud(initialCloud)) {
  console.log(`iPhone ${udid} is already supervised; skipping backup/restore supervision and applying Vigil normally.`);
  if (!options.skipApplyProfile) await applyVigilProfile(udid, await requireSupervisorKeybag(options.supervisorKeybag), options.existingCheckpoint, options.password);
  process.exit(0);
}

throw new Error([
  "New iPhone enrollment is disabled because a post-supervision system restore clears supervision.",
  "The escrow-backed single pre-supervision restore documented in AGENTS.md must be implemented and verified before enrollment resumes.",
  "No backup, restore, supervision, or profile mutation was started. Existing checkpoints remain unchanged."
].join("\n"));

function parseArgs(args) {
  const output = {
    confirm: false,
    password: process.env.IOS_BACKUP_PASSWORD || "",
    skipApplyProfile: false,
    supervisorKeybag: String(process.env.VIGIL_SUPERVISOR_KEYBAG || "").trim(),
    existingCheckpoint: "",
    udid: ""
  };
  const valueOptions = new Map([
    ["--udid", "udid"],
    ["--checkpoint", "existingCheckpoint"],
    ["--existing-checkpoint", "existingCheckpoint"],
    ["--use-checkpoint", "existingCheckpoint"],
    ["--password", "password"],
    ["--supervisor-keybag", "supervisorKeybag"],
    ["--keybag", "supervisorKeybag"]
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes-supervise-and-restore") { output.confirm = true; continue; }
    if (arg === "--skip-apply-profile") { output.skipApplyProfile = true; continue; }
    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const key = valueOptions.get(name);
    if (!key) throw new Error(`Unknown or retired enrollment option: ${name}`);
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (value === undefined || (separator < 0 && value.startsWith("--"))) {
      throw new Error(`Missing value for ${name}`);
    }
    output[key] = key === "password" ? value : value.trim();
  }
  return output;
}

async function ensurePymobiledevice3() {
  if (process.env.PYMOBILEDEVICE3) {
    await access(PYMOBILEDEVICE3_PATH);
    return;
  }
  if (await fileExists(PYMOBILEDEVICE3_PATH)) return;
  await installBundledIosPythonRuntime();
}

async function installBundledIosPythonRuntime() {
  await mkdir(TOOL_ROOT, { recursive: true });
  if (!(await fileExists(BUNDLED_PYTHON_PATH))) {
    await execFileAsync("python3", ["-m", "venv", VENV_DIR], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 256 });
  }
  await execFileAsync(BUNDLED_PYTHON_PATH, ["-m", "pip", "install", "--upgrade", "pip", "wheel"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  await execFileAsync(BUNDLED_PYTHON_PATH, ["-m", "pip", "install", "pymobiledevice3"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
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
  const text = stdout.trim();
  if (!text || text === "null") return null;
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function isSupervisedCloud(cloud) {
  return Boolean(cloud && typeof cloud === "object" && cloud.IsSupervised === true);
}

async function applyVigilProfile(udid, supervisorKeybagPath, checkpointRoot = "", password = "") {
  const args = [
    join(ROOT, "scripts", "apply-ios-usb-profile.mjs"),
    "--udid",
    udid,
    "--supervisor-keybag",
    supervisorKeybagPath
  ];
  if (checkpointRoot) args.push("--require-checkpoint", checkpointRoot);
  if (password) args.push("--password", password);
  await execFileAsync(process.execPath, args, {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
}

async function runPymobiledevice3(args, timeout) {
  try {
    return await execFileAsync(PYMOBILEDEVICE3_PATH, args, {
      timeout,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    throw new Error(`${error?.stdout || ""}\n${error?.stderr || error}`.trim(), { cause: error });
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
