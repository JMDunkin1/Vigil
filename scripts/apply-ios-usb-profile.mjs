import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLayoutPaths } from "./ios-backup-layout.mjs";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const DEFAULT_SUPERVISOR_KEYBAG_PATH = join(DATA_DIR, "vigil-supervisor.keybag");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const PYIOSBACKUP_PYTHON_PATH = process.env.PYIOSBACKUP_PYTHON || join(VENV_DIR, "bin", "python");
const VIGIL_SERVER = String(process.env.VIGIL_SERVER || process.env.VIGIL_SERVER || "http://127.0.0.1:8787").replace(/\/+$/, "");
const IOS_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
const INSTALL_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
if (options.requireCheckpoint) await verifyCheckpoint(await resolveCheckpointRoot(options.requireCheckpoint, udid), udid, options.password);

const supervisorKeybagPath = await requireSupervisorKeybag(options.supervisorKeybag);
const cloud = await readCloudConfiguration(udid, supervisorKeybagPath);
if (!isSupervisedCloud(cloud)) {
  throw new Error([
    "iPhone is paired over USB but is not supervised.",
    "Vigil uses the same supervised-device enforcement model as SHIFT, and iOS will not accept app or web restriction payloads until the phone is supervised.",
    "Vigil will not attempt a partial-restore/no-erase supervision trick from this script because that can disturb Apple ID, setup, and Home Screen layout state; a checkpoint proves a recovery source exists, not that the supervision flow is safe.",
    "Use `npm run ios:supervise-preserve-layout -- --yes-supervise-and-restore` to create a verified layout checkpoint, supervise with a persistent Vigil keybag, restore the checkpoint, then apply this profile."
  ].join("\n"));
}

const profilePath = options.profile ? await validateProvidedProfile(options.profile) : await prepareAndDownloadActiveProfile();
await ensureProfileAccess(udid, supervisorKeybagPath);
if (!profilePath) {
  await removeProfile(udid, supervisorKeybagPath);
  const installedAfterRemove = await profileInstalled(udid, supervisorKeybagPath);
  if (installedAfterRemove) {
    throw new Error(`Vigil profile remove command completed, but ${IOS_PROFILE_IDENTIFIER} is still present in the device profile list.`);
  }
  console.log([
    `Vigil iPhone profile removed over USB from ${udid}.`,
    `Profile: ${IOS_PROFILE_IDENTIFIER}`,
    "Reason: Vigil has no active iPhone policy."
  ].join("\n"));
  process.exit(0);
}
await installProfile(udid, profilePath, supervisorKeybagPath);
const installed = await profileInstalled(udid, supervisorKeybagPath);
if (!installed) {
  throw new Error(`Vigil profile install command completed, but ${IOS_PROFILE_IDENTIFIER} was not found in the device profile list.`);
}

console.log([
  `Vigil iPhone profile applied over USB to ${udid}.`,
  `Profile: ${IOS_PROFILE_IDENTIFIER}`,
  `Supervisor keybag: ${supervisorKeybagPath}`
].join("\n"));

function parseArgs(args) {
  const output = {
    requireCheckpoint: "",
    password: process.env.IOS_BACKUP_PASSWORD || "",
    profile: "",
    supervisorKeybag: String(process.env.VIGIL_SUPERVISOR_KEYBAG || "").trim(),
    udid: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === "--udid") {
      output.udid = String(args[index + 1] || "").trim();
      index += 1;
    }
    if (arg.startsWith("--udid=")) output.udid = arg.slice("--udid=".length).trim();
    if (arg === "--require-checkpoint") {
      output.requireCheckpoint = String(args[index + 1] || "").trim();
      index += 1;
    }
    if (arg.startsWith("--require-checkpoint=")) output.requireCheckpoint = arg.slice("--require-checkpoint=".length).trim();
    if (arg === "--password") {
      output.password = String(args[index + 1] || "");
      index += 1;
    }
    if (arg.startsWith("--password=")) output.password = arg.slice("--password=".length);
    if (arg === "--profile") {
      output.profile = String(args[index + 1] || "").trim();
      index += 1;
    }
    if (arg.startsWith("--profile=")) output.profile = arg.slice("--profile=".length).trim();
    if (arg === "--supervisor-keybag" || arg === "--keybag") {
      output.supervisorKeybag = String(args[index + 1] || "").trim();
      index += 1;
    }
    if (arg.startsWith("--supervisor-keybag=")) output.supervisorKeybag = arg.slice("--supervisor-keybag=".length).trim();
    if (arg.startsWith("--keybag=")) output.supervisorKeybag = arg.slice("--keybag=".length).trim();
  }
  return output;
}

async function verifyCheckpoint(path, udid, password = "") {
  const manifestPath = join(path, udid, "Manifest.db");
  const manifest = await stat(manifestPath).catch(() => null);
  if (!manifest?.isFile() || manifest.size <= 0) {
    throw new Error(`Required iPhone checkpoint is missing Manifest.db for ${udid}: ${manifestPath}`);
  }
  const layoutPaths = await readLayoutPaths({
    manifestPath,
    password,
    pythonPath: PYIOSBACKUP_PYTHON_PATH,
    timeoutMs: QUICK_TIMEOUT_MS
  });
  if (!layoutPaths.length) {
    throw new Error([
      `Required iPhone checkpoint has Manifest.db for ${udid}, but no SpringBoard/Home Screen layout records were found.`,
      `Checkpoint path: ${path}`,
      "Do not use this checkpoint as a layout recovery source."
    ].join("\n"));
  }
}

async function resolveCheckpointRoot(inputPath, udid) {
  const checkpointPath = resolve(inputPath);
  const rootManifestPath = join(checkpointPath, udid, "Manifest.db");
  if (await fileExists(rootManifestPath)) return checkpointPath;
  const backupFolderManifestPath = join(checkpointPath, "Manifest.db");
  if (await fileExists(backupFolderManifestPath)) {
    if (checkpointPath.split(/[\\/]/).at(-1) !== udid) {
      throw new Error([
        `Existing iPhone backup folder is not named for the connected UDID ${udid}: ${checkpointPath}`,
        "Pass the parent checkpoint folder that contains the UDID-named backup folder, or use the matching backup for this iPhone."
      ].join("\n"));
    }
    return dirname(checkpointPath);
  }
  throw new Error([
    `Existing iPhone checkpoint is missing Manifest.db for ${udid}: ${checkpointPath}`,
    `Expected either ${rootManifestPath} or ${backupFolderManifestPath}.`
  ].join("\n"));
}

async function prepareIosServerState() {
  const state = await vigilJson("/api/state");
  const ios = state?.state?.deviceControls?.ios;
  if (!ios || typeof ios !== "object" || Array.isArray(ios)) {
    throw new Error("Vigil API /api/state did not include state.deviceControls.ios; cannot safely preserve iOS settings before applying over USB.");
  }
  if (ios.enabled) return { state, active: true };
  if (!hasActivePhonePolicy(state)) return { state, active: false };
  await vigilJson("/api/devices/ios/usb-profile-apply", { method: "POST" });
  return { state: await vigilJson("/api/state"), active: true };
}

async function prepareAndDownloadActiveProfile() {
  const prepared = await prepareIosServerState();
  if (!prepared.active) return "";
  return await downloadActiveProfile();
}

function hasActivePhonePolicy(state) {
  return Boolean(state?.state?.devicePolicies?.phone);
}

async function downloadActiveProfile() {
  const response = await fetch(`${VIGIL_SERVER}/api/devices/ios/profile.mobileconfig`);
  if (!response.ok) throw new Error(`Vigil profile download failed: HTTP ${response.status}`);
  const dir = await mkdtemp(join(tmpdir(), "vigil-ios-profile-"));
  const path = join(dir, "vigil-iphone-lock.mobileconfig");
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("/usr/bin/plutil", ["-lint", path], { timeout: 5000, maxBuffer: 1024 * 64 });
  return path;
}

async function validateProvidedProfile(inputPath) {
  const path = resolve(inputPath);
  const profile = await stat(path).catch(() => null);
  if (!profile?.isFile() || profile.size <= 0) {
    throw new Error(`Provided iOS profile is missing or empty: ${path}`);
  }
  await execFileAsync("/usr/bin/plutil", ["-lint", path], { timeout: 5000, maxBuffer: 1024 * 64 });
  return path;
}

async function vigilJson(path, options = {}) {
  const response = await fetch(`${VIGIL_SERVER}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "x-vigil-intent": "vigil-app"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Vigil API ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return await response.json();
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

async function requireSupervisorKeybag(requestedPath = "") {
  const keybagPath = requestedPath ? resolve(requestedPath) : DEFAULT_SUPERVISOR_KEYBAG_PATH;
  const keybag = await stat(keybagPath).catch(() => null);
  if (!keybag?.isFile() || keybag.size <= 0) {
    throw new Error([
      `Supervisor keybag is required before USB profile install: ${keybagPath}`,
      "Use the keybag for the same supervision identity that already supervises this iPhone.",
      "Pass it with --supervisor-keybag=/path/to/supervisor.keybag, set VIGIL_SUPERVISOR_KEYBAG, or place it at data/vigil-supervisor.keybag.",
      "Vigil will not create a new keybag here because a new supervision identity cannot pair with a device supervised by Apple Configurator, SHIFT, or another existing identity."
    ].join("\n"));
  }
  if (!requestedPath) await chmod(keybagPath, 0o600);
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

async function readCloudConfiguration(udid, supervisorKeybagPath) {
  const initial = await runPymobiledevice3(["profile", "cloud-configuration", "--udid", udid], QUICK_TIMEOUT_MS, { reject: false });
  let stdout = initial.stdout;
  if (initial.code !== 0 && isProtectedPairingError(initial)) {
    await pairSupervised(udid, supervisorKeybagPath);
    stdout = (await runPymobiledevice3(["profile", "cloud-configuration", "--udid", udid], QUICK_TIMEOUT_MS)).stdout;
  } else if (initial.code !== 0) {
    throw new Error(`${initial.stdout}\n${initial.stderr}`.trim());
  }
  const parsed = JSON.parse(stdout.trim());
  return parsed && typeof parsed === "object" ? parsed : {};
}

function isSupervisedCloud(cloud) {
  return Boolean(cloud && typeof cloud === "object" && cloud.IsSupervised);
}

async function pairSupervised(udid, supervisorKeybagPath) {
  await runPymobiledevice3([
    "lockdown",
    "pair-supervised",
    "--udid",
    udid,
    supervisorKeybagPath
  ], QUICK_TIMEOUT_MS);
}

async function installProfile(udid, profilePath, supervisorKeybagPath) {
  await runPymobiledevice3([
    "profile",
    "install",
    "--udid",
    udid,
    "--keybag",
    supervisorKeybagPath,
    profilePath
  ], QUICK_TIMEOUT_MS);
}

async function ensureProfileAccess(udid, supervisorKeybagPath) {
  const initial = await runPymobiledevice3(["profile", "list", "--udid", udid], QUICK_TIMEOUT_MS, { reject: false });
  if (initial.code === 0) return;
  if (!isProtectedPairingError(initial)) throw new Error(`${initial.stdout}\n${initial.stderr}`.trim());
  await pairSupervised(udid, supervisorKeybagPath);
}

async function removeProfile(udid, supervisorKeybagPath) {
  const installed = await profileInstalled(udid, supervisorKeybagPath);
  if (!installed) return;
  await runPymobiledevice3([
    "profile",
    "remove",
    "--udid",
    udid,
    "--keybag",
    supervisorKeybagPath,
    IOS_PROFILE_IDENTIFIER
  ], QUICK_TIMEOUT_MS);
}

async function profileInstalled(udid, supervisorKeybagPath = "") {
  const initial = await runPymobiledevice3(["profile", "list", "--udid", udid], QUICK_TIMEOUT_MS, { reject: false });
  let stdout = initial.stdout;
  if (initial.code !== 0 && isProtectedPairingError(initial)) {
    if (!supervisorKeybagPath) throw new Error(`${initial.stdout}\n${initial.stderr}`.trim());
    await pairSupervised(udid, supervisorKeybagPath);
    stdout = (await runPymobiledevice3(["profile", "list", "--udid", udid], QUICK_TIMEOUT_MS)).stdout;
  } else if (initial.code !== 0) {
    throw new Error(`${initial.stdout}\n${initial.stderr}`.trim());
  }
  const profiles = JSON.parse(stdout);
  return Boolean(profiles?.ProfileMetadata?.[IOS_PROFILE_IDENTIFIER]);
}

function isProtectedPairingError(result) {
  return /MCProtected|protected/i.test(`${result.stdout}\n${result.stderr}`);
}

async function runPymobiledevice3(args, timeout, options = {}) {
  try {
    const result = await execFileAsync(PYMOBILEDEVICE3_PATH, args, {
      timeout,
      maxBuffer: 1024 * 1024
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = {
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error || ""),
      code: Number(error?.code || 1)
    };
    if (options.reject === false) return result;
    throw new Error(`${result.stdout}\n${result.stderr}`.trim());
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
