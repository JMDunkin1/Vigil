import { execFile } from "node:child_process";
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  readLayoutPaths,
  resolveNewestLayoutBackup,
  validateRestorableBackupPayload
} from "./ios-backup-layout.mjs";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.VIGIL_DATA_DIR || join(ROOT, "data");
const TOOL_ROOT = join(DATA_DIR, "ios-tools");
const VENV_DIR = join(TOOL_ROOT, "pymobiledevice3-venv");
const PYMOBILEDEVICE3_PATH = process.env.PYMOBILEDEVICE3 || join(VENV_DIR, "bin", "pymobiledevice3");
const PYIOSBACKUP_PYTHON_PATH = process.env.PYIOSBACKUP_PYTHON || join(VENV_DIR, "bin", "python");
const DEFAULT_SUPERVISOR_KEYBAG_PATH = join(DATA_DIR, "vigil-supervisor.keybag");
const LAYOUT_RESTORE_ROOT = join(DATA_DIR, "ios-home-layout-restore");
const QUICK_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const RESTORE_TIMEOUT_MS = 60 * 60 * 1000;

// Never use this standalone restore after an iPhone is supervised. Even a
// pruned system/settings restore can clear the supervision state. Layout records
// must instead be included in the one pre-supervision restore described in
// AGENTS.md, followed immediately (while the phone remains locked) by no-erase
// supervision and Vigil profile verification.

const options = parseArgs(process.argv.slice(2));
await ensurePymobiledevice3();
const udid = await resolveUsbDevice(options.udid);
const backupCandidate = await resolveNewestLayoutBackup({
  inputPath: options.backup,
  udid,
  dataDir: DATA_DIR
});
const backupRoot = backupCandidate.path;
await verifyBackupDevice(backupRoot, udid);
const manifestPath = join(backupRoot, "Manifest.db");
const layoutPaths = await readLayoutPaths({
  manifestPath,
  password: options.password,
  pythonPath: PYIOSBACKUP_PYTHON_PATH,
  timeoutMs: QUICK_TIMEOUT_MS
});
if (!layoutPaths.length) {
  throw new Error([
    "The selected iPhone backup does not contain SpringBoard/Home Screen/widget layout records.",
    `Backup: ${backupRoot}`,
    "Do not use it as a layout recovery source."
  ].join("\n"));
}

const payloadRoot = await createLayoutRestorePayload({
  backupRoot,
  layoutPaths,
  password: options.password,
  udid
});

console.log([
  "Prepared Vigil iPhone Home Screen layout restore payload.",
  `UDID: ${udid}`,
  `Backup: ${backupRoot}`,
  `Backup date: ${backupCandidate.completedAt}`,
  `Backup source: ${backupCandidate.source}`,
  `Payload: ${payloadRoot}`,
  `Verified layout/widget records: ${layoutPaths.length}`,
  ...layoutPaths.slice(0, 16).map((item) => `- ${item}`)
].join("\n"));

if (!options.confirm) {
  console.log([
    "Dry run only; the iPhone was not changed.",
    "Rerun with --yes-restore-layout after confirming these are the records you want restored."
  ].join("\n"));
  process.exit(0);
}

await validateLayoutRestorePayload(payloadRoot, udid, options.password);
await ensureRestorePairing(udid, options.supervisorKeybag);
await restoreLayoutPayload(udid, payloadRoot, options.password);
console.log([
  "Vigil staged the selected iPhone Home Screen layout payload.",
  "The restore intentionally deferred its reboot so Vigil and companion apps can be verified first.",
  "Restart the iPhone once after all phone configuration work is complete to load the restored layout.",
  `Payload: ${payloadRoot}`
].join("\n"));

function parseArgs(args) {
  const output = {
    backup: String(process.env.IOS_LAYOUT_BACKUP || "").trim(),
    confirm: false,
    password: process.env.IOS_BACKUP_PASSWORD || "",
    supervisorKeybag: String(process.env.VIGIL_SUPERVISOR_KEYBAG || "").trim(),
    udid: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    if (arg === "--backup") {
      output.backup = String(args[index + 1] || "").trim();
      index += 1;
    } else if (arg.startsWith("--backup=")) {
      output.backup = arg.slice("--backup=".length).trim();
    } else if (arg === "--password") {
      output.password = String(args[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--password=")) {
      output.password = arg.slice("--password=".length);
    } else if (arg === "--udid") {
      output.udid = String(args[index + 1] || "").trim();
      index += 1;
    } else if (arg.startsWith("--udid=")) {
      output.udid = arg.slice("--udid=".length).trim();
    } else if (arg === "--yes-restore-layout") {
      output.confirm = true;
    } else if (arg === "--supervisor-keybag" || arg === "--keybag") {
      output.supervisorKeybag = String(args[index + 1] || "").trim();
      index += 1;
    } else if (arg.startsWith("--supervisor-keybag=")) {
      output.supervisorKeybag = arg.slice("--supervisor-keybag=".length).trim();
    } else if (arg.startsWith("--keybag=")) {
      output.supervisorKeybag = arg.slice("--keybag=".length).trim();
    }
  }
  return output;
}

async function ensureRestorePairing(udid, supervisorKeybag = "") {
  const keybagPath = supervisorKeybag ? resolve(supervisorKeybag) : DEFAULT_SUPERVISOR_KEYBAG_PATH;
  const keybag = await stat(keybagPath).catch(() => null);
  if (!keybag?.isFile() || keybag.size <= 0) {
    throw new Error([
      `Supervisor keybag is required to refresh the restore pairing: ${keybagPath}`,
      "Restore needs an iPhone pairing record with backup escrow material.",
      "Pass --supervisor-keybag=/path/to/supervisor.keybag or place it at data/vigil-supervisor.keybag."
    ].join("\n"));
  }
  await runPymobiledevice3([
    "lockdown",
    "pair-supervised",
    "--udid",
    udid,
    keybagPath
  ], QUICK_TIMEOUT_MS);
}

async function createLayoutRestorePayload({ backupRoot, layoutPaths, password, udid }) {
  const payloadRoot = join(LAYOUT_RESTORE_ROOT, `${timestamp()}-${udid}`);
  const payloadBackup = join(payloadRoot, udid);
  await mkdir(payloadBackup, { recursive: true });
  for (const file of ["Info.plist", "Manifest.plist", "Manifest.db", "Status.plist"]) {
    await copyFile(join(backupRoot, file), join(payloadBackup, file));
  }
  const payload = await prepareLayoutPayloadWithPython({
    layoutPaths,
    password,
    payloadBackup,
    sourceBackup: backupRoot
  });
  if (!payload.entries.length || !payload.files.length) {
    throw new Error([
      "Home Screen layout restore payload was empty after pruning.",
      `Backup: ${backupRoot}`,
      "Stopped before touching the iPhone."
    ].join("\n"));
  }
  return payloadRoot;
}

async function prepareLayoutPayloadWithPython({ sourceBackup, payloadBackup, password, layoutPaths }) {
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
layout_paths = json.loads(sys.argv[3])
password = os.environ.get("PYIOSBACKUP_PASSWORD", "")

targets = set()
for label in layout_paths:
    domain, _, relative_path = label.partition("/")
    if not domain or not relative_path:
        continue
    targets.add((domain, relative_path))
    parts = [part for part in relative_path.split("/") if part]
    for index in range(1, len(parts)):
        targets.add((domain, "/".join(parts[:index])))

backup = Backup.from_path(source_backup, password)
copied = []
for domain, relative_path in sorted(targets):
    try:
        entry = backup.get_entry_by_domain_and_path(domain, relative_path)
    except Exception:
        continue
    hash_path = getattr(entry, "hash_path", "") or ""
    if not hash_path:
        continue
    source_file = source_backup / hash_path
    if not source_file.is_file():
        continue
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
  const { stdout } = await execFileAsync(PYIOSBACKUP_PYTHON_PATH, ["-c", script, sourceBackup, payloadBackup, JSON.stringify(layoutPaths)], {
    timeout: QUICK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PYIOSBACKUP_PASSWORD: password
    }
  });
  return JSON.parse(stdout);
}

async function restoreLayoutPayload(udid, payloadRoot, password = "") {
  const script = `
import asyncio
import os
import sys

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service

udid = sys.argv[1]
payload_root = sys.argv[2]
password = os.environ.get("PYIOSBACKUP_PASSWORD", "")

async def main():
    lockdown = await create_using_usbmux(serial=udid, autopair=True)
    backup = Mobilebackup2Service(lockdown)

    # Supervised pairing responses on current iOS can omit EscrowBag. The
    # unlocked device still authorizes MobileBackup2 through that verified
    # supervised session. Do not replace it with repeated interactive trust
    # pairings: that can invalidate the supervisor pairing without producing
    # the escrow token. This is intentionally the same service with only its
    # optional StartService escrow attachment disabled.
    backup._include_escrow_bag = False
    try:
        async with backup:
            await backup.restore(
                backup_directory=payload_root,
                system=True,
                reboot=False,
                copy=True,
                settings=True,
                remove=False,
                password=password,
                source=udid,
                skip_apps=True,
            )
    finally:
        await lockdown.close()

asyncio.run(main())
`;
  await execFileAsync(PYIOSBACKUP_PYTHON_PATH, ["-c", script, udid, payloadRoot], {
    timeout: RESTORE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PYIOSBACKUP_PASSWORD: password
    }
  });
}

async function validateLayoutRestorePayload(payloadRoot, udid, password = "") {
  const payloadValidation = await validateRestorableBackupPayload({
    backupPath: join(payloadRoot, udid),
    password,
    pythonPath: PYIOSBACKUP_PYTHON_PATH,
    timeoutMs: RESTORE_TIMEOUT_MS
  });
  console.log([
    "Deep-validated the pruned iPhone Home Screen restore payload before pairing or restore.",
    `Manifest entries traversed: ${payloadValidation.manifestEntries}`,
    `Manifest file entries: ${payloadValidation.manifestFiles}`,
    `Regular payload files found: ${payloadValidation.payloadFilesFound}`,
    `Encrypted backup: ${payloadValidation.encrypted ? "yes" : "no"}`
  ].join("\n"));
  return payloadValidation;
}

async function verifyBackupDevice(backupRoot, udid) {
  const infoPath = join(backupRoot, "Info.plist");
  const info = await stat(infoPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Selected backup is missing Info.plist: ${infoPath}`);
  const ids = await readBackupDeviceIds(infoPath);
  if (!ids.length || ids.includes(udid)) return;
  throw new Error([
    `Selected backup does not match the connected iPhone ${udid}.`,
    `Backup device ids: ${ids.join(", ")}`,
    `Backup: ${backupRoot}`
  ].join("\n"));
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
      // Older backups omit some identifiers.
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

function deviceUdid(device) {
  return String(device?.Identifier || device?.UniqueDeviceID || "").trim();
}

function usbDeviceSummary(device) {
  return `${device?.DeviceName || "iOS device"} (${deviceUdid(device) || "unknown udid"})`;
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}
