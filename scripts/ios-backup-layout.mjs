import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MOBILESYNC_RELATIVE_BACKUP_ROOT = ["Library", "Application Support", "MobileSync", "Backup"];
const COMPLETE_BACKUP_FILES = ["Info.plist", "Manifest.plist", "Manifest.db", "Status.plist"];
const FINISHED_SNAPSHOT_STATE = "finished";

const LAYOUT_QUERY = `
SELECT domain || '/' || relativePath
FROM Files
WHERE domain = 'HomeDomain'
AND (
  lower(relativePath) LIKE '%iconstate%'
  OR lower(relativePath) LIKE '%homescreen%'
  OR lower(relativePath) LIKE '%springboard%'
  OR lower(relativePath) LIKE '%applicationstate%'
  OR lower(relativePath) LIKE '%widget%'
)
ORDER BY relativePath;
`;

const PYIOSBACKUP_LAYOUT_SCRIPT = `
import json
import os
import sys
from pathlib import Path
from pyiosbackup.backup import Backup

backup_path = Path(sys.argv[1])
password = os.environ.get("PYIOSBACKUP_PASSWORD", "")
needles = ("iconstate", "homescreen", "springboard", "applicationstate", "widget")
backup = Backup.from_path(backup_path, password)
matches = []
for entry in backup.iter_entries():
    domain = entry.domain or ""
    relative_path = entry.relative_path or ""
    if domain == "HomeDomain" and any(needle in relative_path.lower() for needle in needles):
        matches.append(f"{domain}/{relative_path}")
print(json.dumps(sorted(matches)))
`;

export async function readLayoutPaths({ manifestPath, password = "", pythonPath, timeoutMs }) {
  if (password) {
    return await readLayoutPathsWithPyiosbackup({ manifestPath, password, pythonPath, timeoutMs });
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", [manifestPath, LAYOUT_QUERY], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    const detail = errorDetail(error);
    if (/not a database|file is encrypted|authorization denied/i.test(detail)) {
      throw new Error([
        `Could not inspect iPhone backup layout records in ${manifestPath}.`,
        /not a database|file is encrypted/i.test(detail)
          ? "This backup appears to be encrypted; rerun with --password or set IOS_BACKUP_PASSWORD."
          : "macOS denied access to the backup database; grant Full Disk Access to the terminal app running this command.",
        detail
      ].join("\n"));
    }
    throw error;
  }
}

export async function resolveNewestLayoutBackup({
  inputPath = "",
  udid,
  dataDir = "",
  homeDir = homedir(),
  volumesRoot = "/Volumes"
} = {}) {
  if (!udid) throw new Error("Cannot resolve an iPhone layout backup without a UDID.");
  const candidates = inputPath
    ? await requestedBackupCandidates({ inputPath, udid, homeDir })
    : await defaultBackupCandidates({ udid, dataDir, homeDir, volumesRoot });
  const inspected = await inspectLayoutBackupCandidates(candidates, udid);
  const usable = inspected
    .filter((candidate) => candidate.usable)
    .sort(compareBackupCandidates);
  if (usable.length) return usable[0];
  throw new Error(unusableBackupMessage({ inputPath, udid, inspected, volumesRoot }));
}

export async function inspectLayoutBackupCandidates(candidates, udid = "") {
  const unique = uniqueCandidates(candidates);
  return await Promise.all(unique.map((candidate) => inspectLayoutBackupCandidate(candidate, udid)));
}

async function inspectLayoutBackupCandidate(candidate, udid) {
  const backupRoot = resolve(candidate.path);
  const root = await stat(backupRoot).catch(() => null);
  if (!root?.isDirectory()) {
    return unusableCandidate(candidate, backupRoot, "missing backup folder");
  }

  const fileStats = await Promise.all(COMPLETE_BACKUP_FILES.map(async (file) => ({
    file,
    stats: await stat(join(backupRoot, file)).catch(() => null)
  })));
  const missing = fileStats
    .filter((item) => !item.stats?.isFile() || item.stats.size <= 0)
    .map((item) => item.file);
  if (missing.length) {
    return unusableCandidate(candidate, backupRoot, `incomplete backup metadata: missing ${missing.join(", ")}`);
  }

  if (udid) {
    const ids = await readBackupDeviceIds(join(backupRoot, "Info.plist"));
    if (ids.length && !ids.includes(udid)) {
      return unusableCandidate(candidate, backupRoot, `backup metadata belongs to another device: ${ids.join(", ")}`);
    }
    if (!ids.length && basename(backupRoot) !== udid) {
      return unusableCandidate(candidate, backupRoot, "backup device identity is not proven by Info.plist or folder name");
    }
  }

  const statusPath = join(backupRoot, "Status.plist");
  const snapshotState = (await readPlistValue(statusPath, "SnapshotState").catch(() => "")).toLowerCase();
  if (snapshotState && snapshotState !== FINISHED_SNAPSHOT_STATE) {
    return unusableCandidate(candidate, backupRoot, `backup snapshot is not finished: SnapshotState=${snapshotState}`);
  }

  const statusDate = await readPlistValue(statusPath, "Date").catch(() => "");
  const statusDateMs = Date.parse(statusDate);
  const metadataDateMs = Math.max(...fileStats.map((item) => item.stats?.mtimeMs || 0));
  const completedAtMs = Number.isFinite(statusDateMs) ? statusDateMs : metadataDateMs;
  return {
    path: backupRoot,
    source: candidate.source,
    completedAt: new Date(completedAtMs).toISOString(),
    completedAtMs,
    usable: true
  };
}

async function requestedBackupCandidates({ inputPath, udid, homeDir }) {
  const root = resolve(inputPath);
  const candidates = [
    { path: root, source: "requested backup" },
    { path: join(root, udid), source: "requested backup root" },
    { path: join(root, "MobileSync", "Backup", udid), source: "requested MobileSync backup root" },
    { path: join(root, "PyMobileBackups", udid), source: "requested PyMobile backup root" }
  ];
  const entries = await safeReadDir(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    candidates.push({ path: join(child, udid), source: "requested backup child" });
    candidates.push({ path: timeMachineUserBackupPath(child, homeDir, udid), source: "requested mounted snapshot" });
  }
  return candidates;
}

async function defaultBackupCandidates({ udid, dataDir, homeDir, volumesRoot }) {
  const candidates = [
    { path: join(mobileSyncBackupRoot(homeDir), udid), source: "local MobileSync backup" }
  ];

  if (dataDir) {
    const checkpointRoot = join(dataDir, "ios-checkpoints");
    const checkpoints = await safeReadDir(checkpointRoot);
    for (const entry of checkpoints) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        candidates.push({ path: join(checkpointRoot, entry.name, udid), source: "Sentinel layout checkpoint" });
      }
    }
  }

  const volumes = await safeReadDir(volumesRoot);
  for (const volume of volumes) {
    if (!volume.isDirectory() || volume.name.startsWith(".") || volume.name === "Macintosh HD") continue;
    const volumeRoot = join(volumesRoot, volume.name);
    candidates.push({ path: join(volumeRoot, "MobileSync", "Backup", udid), source: `external MobileSync backup on ${volume.name}` });
    candidates.push({ path: join(volumeRoot, "PyMobileBackups", udid), source: `external PyMobile backup on ${volume.name}` });
    candidates.push({ path: join(volumeRoot, udid), source: `external UDID backup on ${volume.name}` });

    const snapshots = await safeReadDir(volumeRoot);
    for (const snapshot of snapshots) {
      if (!snapshot.isDirectory() || snapshot.name.startsWith(".")) continue;
      candidates.push({
        path: join(volumeRoot, snapshot.name, udid),
        source: `external backup folder on ${volume.name}`
      });
      candidates.push({
        path: timeMachineUserBackupPath(join(volumeRoot, snapshot.name), homeDir, udid),
        source: `mounted snapshot on ${volume.name}`
      });
    }
  }

  return candidates;
}

function timeMachineUserBackupPath(root, homeDir, udid) {
  return join(root, "Data", "Users", basename(homeDir), ...MOBILESYNC_RELATIVE_BACKUP_ROOT, udid);
}

function mobileSyncBackupRoot(homeDir) {
  return join(homeDir, ...MOBILESYNC_RELATIVE_BACKUP_ROOT);
}

async function readPlistValue(path, key) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], {
    timeout: 5000,
    maxBuffer: 1024 * 16
  });
  return stdout.trim();
}

async function readBackupDeviceIds(infoPath) {
  const keys = ["Unique Identifier", "Target Identifier", "UniqueDeviceID", "Unique Device ID"];
  const values = [];
  for (const key of keys) {
    try {
      const value = await readPlistValue(infoPath, key);
      if (value && !values.includes(value)) values.push(value);
    } catch {
      // Older backups omit some identifiers.
    }
  }
  return values;
}

async function safeReadDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareBackupCandidates(left, right) {
  if (right.completedAtMs !== left.completedAtMs) return right.completedAtMs - left.completedAtMs;
  return left.path.localeCompare(right.path);
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const path = resolve(String(candidate.path || ""));
    if (seen.has(path)) continue;
    seen.add(path);
    output.push({ ...candidate, path });
  }
  return output;
}

function unusableCandidate(candidate, backupRoot, reason) {
  return {
    path: backupRoot,
    source: candidate.source,
    reason,
    usable: false
  };
}

function unusableBackupMessage({ inputPath, udid, inspected, volumesRoot }) {
  const searched = inputPath
    ? [`Requested backup/search root: ${resolve(inputPath)}`]
    : [
        "Searched the local MobileSync backup folder, Sentinel layout checkpoints, and mounted external volumes.",
        `Mounted volume root: ${volumesRoot}`
      ];
  const skipped = inspected
    .filter((candidate) => candidate.reason)
    .slice(0, 12)
    .map((candidate) => `- ${candidate.path} (${candidate.source}): ${candidate.reason}`);
  return [
    `Could not find a complete iPhone layout backup for ${udid}.`,
    ...searched,
    skipped.length ? "Skipped candidates:" : "",
    ...skipped,
    "Wait for the current backup to finish, or pass --backup=/path/to/a/complete/UDID-backup-folder."
  ].filter(Boolean).join("\n");
}

async function readLayoutPathsWithPyiosbackup({ manifestPath, password, pythonPath, timeoutMs }) {
  if (!pythonPath) throw new Error("Encrypted iPhone backup verification requires a Python path with pyiosbackup installed.");
  try {
    const { stdout } = await execFileAsync(pythonPath, ["-c", PYIOSBACKUP_LAYOUT_SCRIPT, dirname(manifestPath)], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PYIOSBACKUP_PASSWORD: password
      }
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = errorDetail(error);
    throw new Error([
      `Could not decrypt or inspect iPhone backup layout records in ${manifestPath}.`,
      "Confirm the backup password is correct before supervising.",
      detail
    ].join("\n"));
  }
}

function errorDetail(error) {
  return `${error?.stdout || ""}\n${error?.stderr || error?.message || error}`.trim();
}
