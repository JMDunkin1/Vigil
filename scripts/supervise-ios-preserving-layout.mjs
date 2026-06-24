import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLayoutPaths } from "./ios-backup-layout.mjs";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const BUNDLED_PYTHON_PATH = join(VENV_DIR, "bin", "python");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const PYIOSBACKUP_PYTHON_PATH = process.env.PYIOSBACKUP_PYTHON || BUNDLED_PYTHON_PATH;
const CHECKPOINT_ROOT = join(DATA_DIR, "ios-checkpoints");
const PRE_SUPERVISION_RESTORE_ROOT = join(DATA_DIR, "ios-pre-supervision-restore");
const DEFAULT_SUPERVISOR_KEYBAG_PATH = join(DATA_DIR, "vigil-supervisor.keybag");
const DEFAULT_ORGANIZATION = "Vigil";
const INSTALL_TIMEOUT_MS = 120_000;
const BACKUP_TIMEOUT_MS = 60 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 60 * 60 * 1000;
const RECONNECT_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 20_000;
const GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_GIB = 80;
const PRE_SUPERVISION_RESTORE_ENTRIES = [
  {
    domain: "SysSharedContainerDomain-systemgroup.com.apple.configurationprofiles",
    relativePath: "Library/ConfigurationProfiles/CloudConfigurationDetails.plist"
  },
  {
    domain: "HomeDomain",
    relativePath: "Library/Preferences/com.apple.purplebuddy.plist"
  }
];
const PRE_SUPERVISION_RESTORE_FILE_LABELS = PRE_SUPERVISION_RESTORE_ENTRIES.map((entry) => `${entry.domain}/${entry.relativePath}`);

const options = parseArgs(process.argv.slice(2));
if (!options.confirm) {
  throw new Error([
    "Refusing to supervise and restore without explicit confirmation.",
    "This slow path protects user data, Home Screen layout, folders, Apple ID setup state, and settings before Vigil touches supervision.",
    "It creates or verifies a full local backup, applies a tiny setup-state restore to clear Apple's activated-device cloud-configuration gate, supervises without erasing, restores the full backup to recover layout/settings, re-supervises if the restore clears supervision, pairs supervised, then applies Vigil.",
    "Rerun with --yes-supervise-and-restore after confirming Find My is off, the phone is unlocked, trusted, connected by cable, and has enough time/power to finish.",
    "If you already have a verified layout recovery backup, pass it with --checkpoint /path/to/checkpoint-or-backup-folder."
  ].join("\n"));
}

await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
console.log([
  `Vigil layout-preserving iPhone setup starting for ${udid}.`,
  "This is intentionally slow because it prioritizes preserving user data, Home Screen layout, folders, Apple ID setup state, and settings.",
  "Keep Find My off, keep the cable connected, and unlock/Trust the phone whenever iOS asks."
].join("\n"));
const initialCloud = await readCloudConfiguration(udid);
if (isSupervisedCloud(initialCloud)) {
  console.log(`iPhone ${udid} is already supervised; skipping backup/restore supervision and applying Vigil normally.`);
  if (!options.skipApplyProfile) await applyVigilProfile(udid, await requireSupervisorKeybag(options.supervisorKeybag));
  process.exit(0);
}

await ensurePyiosbackupPython();
const checkpointRoot = options.existingCheckpoint
  ? await resolveExistingCheckpointRoot(options.existingCheckpoint, udid)
  : await createCheckpoint(udid, options);
const layoutPaths = await verifyCheckpoint(checkpointRoot, udid, options.password);
const supervisorKeybagPath = await ensureSupervisorKeybag(options.supervisorKeybag, options.organization);

const preSupervisionPayloadRoot = await createPreSupervisionRestorePayload(checkpointRoot, udid, options.password);
console.log([
  "Applying tiny pre-supervision setup-state restore.",
  "This restore is limited to the two live-proven setup/cloud-configuration files; it is not the full layout restore.",
  ...PRE_SUPERVISION_RESTORE_FILE_LABELS.map((entry) => `- ${entry}`)
].join("\n"));
await restorePreSupervisionSetupState(udid, preSupervisionPayloadRoot, options.password);
console.log("Waiting for the iPhone to reconnect after the tiny restore. Unlock the phone and accept Trust if prompted.");
await waitForUsbDevice(udid, "after pre-supervision setup-state restore", RECONNECT_TIMEOUT_MS);
await waitForCloudConfigurationCleared(udid, "after pre-supervision setup-state restore", RECONNECT_TIMEOUT_MS);

console.log("Running no-erase supervision with the persistent Vigil supervisor identity.");
await superviseDevice(udid, options.organization, supervisorKeybagPath);
await waitForUsbDevice(udid, "after supervision", RECONNECT_TIMEOUT_MS);
const supervisedCloud = await readCloudConfiguration(udid);
if (!isSupervisedCloud(supervisedCloud)) {
  throw new Error("iPhone supervision command completed, but the device still does not report IsSupervised=true. Stopping before backup restore/profile install.");
}

console.log("Restoring the full verified checkpoint to recover layout, app placement, folders, and settings.");
await restoreCheckpoint(udid, checkpointRoot, options.password);
console.log("Waiting for the iPhone to reconnect after the full layout restore. Unlock the phone and accept Trust if prompted.");
await waitForUsbDevice(udid, "after layout restore", RECONNECT_TIMEOUT_MS);
await waitForCloudConfigurationReadable(udid, "after layout restore", RECONNECT_TIMEOUT_MS);
let restoredCloud = await readCloudConfiguration(udid);
if (!isSupervisedCloud(restoredCloud)) {
  console.log("Layout restore cleared supervision; re-running no-erase supervision before applying Vigil.");
  await superviseDevice(udid, options.organization, supervisorKeybagPath);
  await waitForUsbDevice(udid, "after post-restore supervision", RECONNECT_TIMEOUT_MS);
  restoredCloud = await readCloudConfiguration(udid);
  if (!isSupervisedCloud(restoredCloud)) {
    throw new Error([
      "The post-restore supervision command completed, but the iPhone still does not report IsSupervised=true.",
      "Vigil will not apply the supervised restrictions profile until supervision is intact.",
      `The verified checkpoint remains at: ${checkpointRoot}`
    ].join("\n"));
  }
}
await pairSupervised(udid, supervisorKeybagPath);

if (!options.skipApplyProfile) await applyVigilProfile(udid, supervisorKeybagPath, checkpointRoot, options.password);

console.log([
  `Vigil supervised ${udid} with layout recovery.`,
  `Checkpoint restored from: ${checkpointRoot}`,
  `Verified layout records before supervision: ${layoutPaths.length}`,
  `Supervisor keybag: ${supervisorKeybagPath}`,
  options.skipApplyProfile ? "Vigil profile install was skipped." : "Vigil profile was applied after layout restore."
].join("\n"));

function parseArgs(args) {
  const output = {
    confirm: false,
    minFreeGib: Number(process.env.IOS_CHECKPOINT_MIN_FREE_GB || DEFAULT_MIN_FREE_GIB),
    organization: process.env.VIGIL_SUPERVISOR_ORGANIZATION || DEFAULT_ORGANIZATION,
    output: "",
    password: process.env.IOS_BACKUP_PASSWORD || "",
    skipApplyProfile: false,
    supervisorKeybag: String(process.env.VIGIL_SUPERVISOR_KEYBAG || "").trim(),
    existingCheckpoint: "",
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
    if (arg === "--checkpoint" || arg === "--existing-checkpoint" || arg === "--use-checkpoint") output.existingCheckpoint = String(args[index + 1] || "").trim();
    if (arg.startsWith("--checkpoint=")) output.existingCheckpoint = arg.slice("--checkpoint=".length).trim();
    if (arg.startsWith("--existing-checkpoint=")) output.existingCheckpoint = arg.slice("--existing-checkpoint=".length).trim();
    if (arg.startsWith("--use-checkpoint=")) output.existingCheckpoint = arg.slice("--use-checkpoint=".length).trim();
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
  await verifyCheckpoint(checkpointRoot, udid, options.password);
  return checkpointRoot;
}

async function resolveExistingCheckpointRoot(inputPath, udid) {
  const checkpointPath = resolve(inputPath);
  const rootManifestPath = join(checkpointPath, udid, "Manifest.db");
  if (await fileExists(rootManifestPath)) {
    return checkpointPath;
  }
  const backupFolderManifestPath = join(checkpointPath, "Manifest.db");
  if (await fileExists(backupFolderManifestPath)) {
    if (checkpointPath.split(/[\\/]/).at(-1) !== udid) {
      throw new Error([
        `Existing iPhone backup folder is not named for the connected UDID ${udid}: ${checkpointPath}`,
        "Pass the parent checkpoint folder that contains the UDID-named backup folder, or use the matching backup for this iPhone.",
        "Vigil will not restore a backup unless the backup folder identity matches the connected device."
      ].join("\n"));
    }
    return dirname(checkpointPath);
  }
  throw new Error([
    `Existing iPhone checkpoint is missing Manifest.db for ${udid}: ${checkpointPath}`,
    `Expected either ${rootManifestPath} or ${backupFolderManifestPath}.`,
    "Do not supervise until the known-good layout recovery backup can be verified."
  ].join("\n"));
}

async function verifyCheckpoint(path, udid, password = "") {
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
  const backupDeviceIds = await readBackupDeviceIds(infoPath);
  if (backupDeviceIds.length && !backupDeviceIds.includes(udid)) {
    throw new Error([
      `Required iPhone checkpoint metadata does not match the connected device ${udid}.`,
      `Checkpoint path: ${path}`,
      `Backup device identifiers: ${backupDeviceIds.join(", ")}`,
      "Vigil will not restore a backup from a different iPhone."
    ].join("\n"));
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
  return layoutPaths;
}

async function createPreSupervisionRestorePayload(checkpointRoot, udid, password = "") {
  const sourceBackup = join(checkpointRoot, udid);
  const payloadRoot = join(PRE_SUPERVISION_RESTORE_ROOT, `${timestamp()}-${udid}`);
  const payloadBackup = join(payloadRoot, udid);
  await mkdir(payloadBackup, { recursive: true });
  for (const file of ["Info.plist", "Manifest.plist", "Manifest.db", "Status.plist"]) {
    await copyFile(join(sourceBackup, file), join(payloadBackup, file));
  }
  const payload = await preparePreSupervisionPayloadWithPython({
    sourceBackup,
    payloadBackup,
    password
  });
  const expectedFiles = [...PRE_SUPERVISION_RESTORE_FILE_LABELS].sort();
  const expectedEntries = preSupervisionRestoreManifestEntries().sort();
  if (JSON.stringify(payload.files) !== JSON.stringify(expectedFiles) || JSON.stringify(payload.entries) !== JSON.stringify(expectedEntries)) {
    throw new Error([
      "Pre-supervision setup-state restore payload did not contain exactly the expected files.",
      `Expected files: ${expectedFiles.join(", ")}`,
      `Actual files: ${payload.files.join(", ")}`,
      `Expected manifest entries: ${expectedEntries.join(", ")}`,
      `Actual manifest entries: ${payload.entries.join(", ")}`,
      "Vigil stopped before rewriting setup state or supervising the phone."
    ].join("\n"));
  }
  console.log([
    "Created pre-supervision setup-state restore payload.",
    `Path: ${payloadRoot}`,
    ...payload.entries.map((entry) => `- ${entry}`)
  ].join("\n"));
  return payloadRoot;
}

function preSupervisionRestoreManifestEntries() {
  const entries = new Set();
  for (const entry of PRE_SUPERVISION_RESTORE_ENTRIES) {
    entries.add(`${entry.domain}/${entry.relativePath}`);
    const parts = entry.relativePath.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      entries.add(`${entry.domain}/${parts.slice(0, index).join("/")}`);
    }
  }
  return [...entries];
}

async function preparePreSupervisionPayloadWithPython({ sourceBackup, payloadBackup, password }) {
  const script = `
import json
import os
import shutil
import sys
from pathlib import Path

from pyiosbackup.backup import Backup
from pymobiledevice3.services.mobilebackup2 import BackupFile, Mobilebackup2Service

source_backup = Path(sys.argv[1])
payload_backup = Path(sys.argv[2])
password = os.environ.get("PYIOSBACKUP_PASSWORD", "")
target_files = [
    (
        "SysSharedContainerDomain-systemgroup.com.apple.configurationprofiles",
        "Library/ConfigurationProfiles/CloudConfigurationDetails.plist",
    ),
    ("HomeDomain", "Library/Preferences/com.apple.purplebuddy.plist"),
]
targets = set(target_files)
for domain, relative_path in target_files:
    parts = [part for part in relative_path.split("/") if part]
    for index in range(1, len(parts)):
        targets.add((domain, "/".join(parts[:index])))

backup = Backup.from_path(source_backup, password)
copied = []
for domain, relative_path in target_files:
    entry = backup.get_entry_by_domain_and_path(domain, relative_path)
    source_file = source_backup / entry.hash_path
    target_file = payload_backup / entry.hash_path
    target_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_file, target_file)
    copied.append(f"{domain}/{relative_path}")

def keep(item: BackupFile):
    return (item.domain, item.relative_path) in targets

Mobilebackup2Service.prune_backup_directory(payload_backup, keep, password=password)
verified = Backup.from_path(payload_backup, password)
entries = sorted(f"{entry.domain}/{entry.relative_path}" for entry in verified.iter_entries())
print(json.dumps({"entries": entries, "files": sorted(copied)}))
`;
  const { stdout } = await execFileAsync(PYIOSBACKUP_PYTHON_PATH, ["-c", script, sourceBackup, payloadBackup], {
    timeout: QUICK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PYIOSBACKUP_PASSWORD: password
    }
  });
  return JSON.parse(stdout);
}

async function restorePreSupervisionSetupState(udid, payloadRoot, password = "") {
  await runPymobiledevice3([
    "--reconnect",
    "backup2",
    "restore",
    "--udid",
    udid,
    "--system",
    "--settings",
    "--no-remove",
    "--skip-apps",
    "--source",
    udid,
    ...passwordArgs(password),
    payloadRoot
  ], RESTORE_TIMEOUT_MS);
}

async function readBackupDeviceIds(infoPath) {
  const keys = ["Unique Identifier", "Target Identifier", "UniqueDeviceID", "Unique Device ID"];
  const values = [];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPath], {
        timeout: QUICK_TIMEOUT_MS,
        maxBuffer: 1024 * 16
      });
      const value = stdout.trim();
      if (value && !values.includes(value)) values.push(value);
    } catch {
      // Older backup formats omit some of these keys.
    }
  }
  return values;
}

async function ensurePymobiledevice3() {
  if (process.env.PYMOBILEDEVICE3) {
    await access(PYMOBILEDEVICE3_PATH);
    return;
  }
  if (await fileExists(PYMOBILEDEVICE3_PATH)) return;
  await installBundledIosPythonRuntime();
}

async function ensurePyiosbackupPython() {
  if (process.env.PYIOSBACKUP_PYTHON) {
    await access(PYIOSBACKUP_PYTHON_PATH);
    await assertPyiosbackupPython(PYIOSBACKUP_PYTHON_PATH);
    return;
  }
  if (!(await isPyiosbackupPythonReady(PYIOSBACKUP_PYTHON_PATH))) {
    await installBundledIosPythonRuntime();
  }
  await assertPyiosbackupPython(PYIOSBACKUP_PYTHON_PATH);
}

async function installBundledIosPythonRuntime() {
  await mkdir(TOOL_ROOT, { recursive: true });
  if (!(await fileExists(BUNDLED_PYTHON_PATH))) {
    await execFileAsync("python3", ["-m", "venv", VENV_DIR], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 256 });
  }
  await execFileAsync(BUNDLED_PYTHON_PATH, ["-m", "pip", "install", "--upgrade", "pip", "wheel"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  await execFileAsync(BUNDLED_PYTHON_PATH, ["-m", "pip", "install", "pymobiledevice3"], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
}

async function isPyiosbackupPythonReady(pythonPath) {
  try {
    await assertPyiosbackupPython(pythonPath);
    return true;
  } catch {
    return false;
  }
}

async function assertPyiosbackupPython(pythonPath) {
  try {
    await execFileAsync(pythonPath, ["-c", [
      "from pyiosbackup.backup import Backup",
      "from pymobiledevice3.services.mobilebackup2 import BackupFile, Mobilebackup2Service"
    ].join("\n")], {
      timeout: QUICK_TIMEOUT_MS,
      maxBuffer: 1024 * 256
    });
  } catch (error) {
    const detail = `${error?.stdout || ""}\n${error?.stderr || error?.message || error}`.trim();
    throw new Error([
      `Python runtime for iPhone backup payloads is missing pyiosbackup support: ${pythonPath}`,
      "Unset PYIOSBACKUP_PYTHON to let Vigil install its local runtime, or point it at a Python that can import pyiosbackup and pymobiledevice3.services.mobilebackup2.",
      detail
    ].filter(Boolean).join("\n"));
  }
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

async function waitForCloudConfigurationReadable(udid, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await readCloudConfiguration(udid);
      return;
    } catch (error) {
      lastError = String(error?.message || error || "");
      await sleep(5000);
    }
  }
  throw new Error(`Timed out waiting for ${udid} cloud configuration to be readable ${phase}.${lastError ? ` Last error: ${lastError}` : ""}`);
}

async function waitForCloudConfigurationCleared(udid, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCloud = null;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const cloud = await readCloudConfiguration(udid);
      if (isClearedCloudConfiguration(cloud)) {
        console.log(`Cloud configuration is cleared ${phase}; proceeding with no-erase supervision.`);
        return;
      }
      lastCloud = cloud;
    } catch (error) {
      lastError = String(error?.message || error || "");
    }
    await sleep(5000);
  }
  throw new Error([
    `Timed out waiting for ${udid} cloud configuration to clear ${phase}.`,
    "Vigil stopped before no-erase supervision because Apple's activated-device cloud-configuration gate is still present.",
    "Leave Find My off, keep the cable connected, unlock the phone, accept Trust, then rerun once `pymobiledevice3 profile cloud-configuration` returns null or an empty object.",
    lastError ? `Last read error: ${lastError}` : `Last cloud configuration: ${cloudConfigurationSummary(lastCloud)}`
  ].join("\n"));
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
  return Boolean(cloud && typeof cloud === "object" && cloud.IsSupervised);
}

function isClearedCloudConfiguration(cloud) {
  return cloud === null || (typeof cloud === "object" && Object.keys(cloud).length === 0);
}

function cloudConfigurationSummary(cloud) {
  if (cloud === null) return "null";
  try {
    return JSON.stringify(cloud);
  } catch {
    return String(cloud);
  }
}

async function superviseDevice(udid, organization, supervisorKeybagPath) {
  const result = await runPymobiledevice3([
    "profile",
    "supervise",
    "--udid",
    udid,
    "--keybag",
    supervisorKeybagPath,
    organization
  ], QUICK_TIMEOUT_MS);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/cloud configuration is already present/i.test(output)) {
    throw new Error([
      "iOS refused no-erase supervision because a cloud configuration is already present on the activated iPhone.",
      "Vigil stopped before backup restore/profile install.",
      "Rerun the layout-preserving flow so the tiny pre-supervision setup-state restore can clear the cloud-configuration gate before supervision."
    ].join("\n"));
  }
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

async function restoreCheckpoint(udid, checkpointRoot, password) {
  await runPymobiledevice3([
    "--reconnect",
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
    "Free space or pass --output=/Volumes/ExternalDrive/vigil-ios-checkpoints before supervising."
  ].join("\n"));
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
