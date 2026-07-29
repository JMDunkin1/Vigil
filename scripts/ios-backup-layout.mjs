import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MOBILESYNC_RELATIVE_BACKUP_ROOT = ["Library", "Application Support", "MobileSync", "Backup"];
const COMPLETE_BACKUP_FILES = ["Info.plist", "Manifest.plist", "Manifest.db", "Status.plist"];
const FINISHED_SNAPSHOT_STATE = "finished";
const DEFAULT_PAYLOAD_VALIDATION_TIMEOUT_MS = 60 * 60 * 1000;

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

const PYIOSBACKUP_PAYLOAD_VALIDATION_SCRIPT = `
import json
import os
import re
import stat
import sys
import time
from pathlib import Path
from pyiosbackup.backup import Backup

backup_path = Path(sys.argv[1]).resolve()
password = os.environ.get("PYIOSBACKUP_PASSWORD", "")
started = time.monotonic()
backup = Backup.from_path(backup_path, password)
if backup.is_encrypted:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.keywrap import aes_key_unwrap
    from pyiosbackup.keybag import encryption_key_struct
issue_counts = {
    "invalidFileIds": 0,
    "invalidManifestSizes": 0,
    "invalidPayloadBuckets": 0,
    "missingPayloads": 0,
    "nonRegularPayloads": 0,
    "emptyPayloads": 0,
    "invalidCiphertextShapes": 0,
    "decryptFailures": 0,
    "paddingFailures": 0,
    "unreadablePayloads": 0,
}
observation_counts = {
    # BackupAgent can snapshot a live SQLite payload before or after it archives
    # that file's metadata. MobileBackup2 restores the real payload stream
    # length, so a non-zero mismatch is useful diagnostics but not corruption.
    "manifestSizeMismatches": 0,
}
samples = {key: [] for key in issue_counts}
observation_samples = {key: [] for key in observation_counts}
manifest_entries = 0
manifest_files = 0
payload_files_found = 0
expected_bytes = 0
payload_bytes = 0
checked_buckets = {}

def record_issue(kind, label):
    issue_counts[kind] += 1
    if len(samples[kind]) < 12:
        samples[kind].append(label)

def record_observation(kind, label):
    observation_counts[kind] += 1
    if len(observation_samples[kind]) < 12:
        observation_samples[kind].append(label)

for entry in backup.iter_entries():
    manifest_entries += 1
    if not entry.is_file():
        continue
    manifest_files += 1
    label = f"{entry.domain}/{entry.relative_path}" if entry.domain or entry.relative_path else str(entry.file_id)
    file_id = str(entry.file_id or "")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", file_id):
        record_issue("invalidFileIds", label)
        continue
    try:
        expected_size = int(entry.size)
    except (TypeError, ValueError):
        record_issue("invalidManifestSizes", label)
        continue
    if expected_size < 0:
        record_issue("invalidManifestSizes", label)
        continue
    expected_bytes += expected_size
    hash_path = Path(entry.hash_path)
    valid_hash_paths = {(file_id,), (file_id[:2], file_id)}
    if hash_path.is_absolute() or ".." in hash_path.parts or tuple(hash_path.parts) not in valid_hash_paths:
        record_issue("invalidFileIds", label)
        continue
    payload_path = backup_path / hash_path
    bucket_path = payload_path.parent
    bucket_valid = checked_buckets.get(bucket_path)
    if bucket_valid is None:
        try:
            bucket_valid = stat.S_ISDIR(bucket_path.lstat().st_mode)
        except OSError:
            bucket_valid = False
        checked_buckets[bucket_path] = bucket_valid
    if not bucket_valid:
        record_issue("invalidPayloadBuckets", label)
        continue
    try:
        payload_stat = payload_path.lstat()
    except FileNotFoundError:
        record_issue("missingPayloads", label)
        continue
    except OSError:
        record_issue("unreadablePayloads", label)
        continue
    if not stat.S_ISREG(payload_stat.st_mode):
        record_issue("nonRegularPayloads", label)
        continue
    payload_files_found += 1
    actual_size = payload_stat.st_size
    payload_bytes += actual_size
    if expected_size > 0 and actual_size <= 0:
        record_issue("emptyPayloads", label)
    try:
        with payload_path.open("rb") as payload_file:
            if actual_size > 0:
                if len(payload_file.read(1)) != 1:
                    raise OSError("could not read first payload byte")
                payload_file.seek(-1, 2)
                if len(payload_file.read(1)) != 1:
                    raise OSError("could not read final payload byte")
    except OSError:
        record_issue("unreadablePayloads", label)
        continue
    if not backup.is_encrypted and actual_size != expected_size:
        record_observation("manifestSizeMismatches", f"{label} expected={expected_size} actual={actual_size}")
    if backup.is_encrypted:
        if actual_size <= 0 or actual_size % 16 != 0:
            record_issue("invalidCiphertextShapes", f"{label} ciphertext={actual_size}")
            continue
        try:
            parsed_key = encryption_key_struct.parse(entry.encryption_key)
            file_key = aes_key_unwrap(backup.keybag.get_key(parsed_key.class_), parsed_key.key)
            with payload_path.open("rb") as payload_file:
                if actual_size >= 32:
                    payload_file.seek(-32, 2)
                    final_blocks = payload_file.read(32)
                    previous_block = final_blocks[:16]
                    final_block = final_blocks[16:]
                else:
                    payload_file.seek(-16, 2)
                    previous_block = bytes(16)
                    final_block = payload_file.read(16)
            if len(previous_block) != 16 or len(final_block) != 16:
                raise ValueError("could not read final CBC block")
            decryptor = Cipher(algorithms.AES(file_key), modes.CBC(previous_block)).decryptor()
            final_plaintext = decryptor.update(final_block) + decryptor.finalize()
        except Exception:
            record_issue("decryptFailures", label)
            continue
        pad_length = final_plaintext[-1]
        if pad_length < 1 or pad_length > 16 or final_plaintext[-pad_length:] != bytes([pad_length]) * pad_length:
            record_issue("paddingFailures", label)
            continue
        decrypted_size = actual_size - pad_length
        if decrypted_size != expected_size:
            record_observation("manifestSizeMismatches", f"{label} expected={expected_size} decrypted={decrypted_size}")

result = {
    "ok": not any(issue_counts.values()),
    "encrypted": bool(backup.is_encrypted),
    "manifestEntries": manifest_entries,
    "manifestFiles": manifest_files,
    "payloadFilesFound": payload_files_found,
    "expectedBytes": expected_bytes,
    "payloadBytes": payload_bytes,
    "durationMs": round((time.monotonic() - started) * 1000),
    "issueCounts": issue_counts,
    "samples": {key: value for key, value in samples.items() if value},
    "observationCounts": observation_counts,
    "observationSamples": {key: value for key, value in observation_samples.items() if value},
}
print(json.dumps(result, sort_keys=True))
if not result["ok"]:
    raise SystemExit(2)
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
      ].join("\n"), { cause: error });
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

export async function assertRestorableLayoutBackup(backupPath, { udid = "", source = "selected backup" } = {}) {
  const inspected = await inspectLayoutBackupCandidate({ path: backupPath, source }, udid);
  if (inspected.usable) return inspected;
  throw new Error([
    `Refusing to restore an iPhone backup whose completion cannot be proven: ${inspected.path}`,
    `Reason: ${inspected.reason}`,
    "A restorable backup must have non-empty Info.plist, Manifest.plist, Manifest.db, and Status.plist metadata with SnapshotState=finished."
  ].join("\n"));
}

export async function validateRestorableBackupPayload({
  backupPath,
  password = "",
  pythonPath,
  timeoutMs = DEFAULT_PAYLOAD_VALIDATION_TIMEOUT_MS
}) {
  if (!backupPath) throw new Error("Deep iPhone backup validation requires a backup path.");
  if (!pythonPath) throw new Error("Deep iPhone backup validation requires a Python path with pyiosbackup installed.");
  try {
    const { stdout } = await execFileAsync(pythonPath, ["-c", PYIOSBACKUP_PAYLOAD_VALIDATION_SCRIPT, resolve(backupPath)], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PYIOSBACKUP_PASSWORD: password
      }
    });
    const result = JSON.parse(stdout);
    if (result?.ok !== true
      || !Number.isInteger(result.manifestEntries)
      || !Number.isInteger(result.manifestFiles)
      || result.manifestFiles < 1) {
      throw new Error("Deep iPhone backup validation returned an invalid result.");
    }
    return result;
  } catch (error) {
    throw new Error([
      `Deep iPhone backup payload validation failed for ${resolve(backupPath)}.`,
      "Vigil fully traversed the backup manifest and will not use this recovery source for a device mutation unless every file entry has a valid hashed payload.",
      errorDetail(error)
    ].filter(Boolean).join("\n"), { cause: error });
  }
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
  let snapshotState;
  try {
    snapshotState = (await readPlistValue(statusPath, "SnapshotState")).trim().toLowerCase();
  } catch {
    return unusableCandidate(candidate, backupRoot, "backup snapshot completion is not proven: Status.plist has no readable SnapshotState");
  }
  if (!snapshotState) {
    return unusableCandidate(candidate, backupRoot, "backup snapshot completion is not proven: SnapshotState is empty");
  }
  if (snapshotState !== FINISHED_SNAPSHOT_STATE) {
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
        candidates.push({ path: join(checkpointRoot, entry.name, udid), source: "Vigil layout checkpoint" });
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
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], {
      timeout: 5000,
      maxBuffer: 1024 * 16
    });
    return stdout.trim();
  }

  // CI and fixture validation also run on hosts without Apple's plutil. Only
  // accept a bounded XML plist there; binary or malformed production backups
  // remain unreadable and therefore fail the mutation gate closed.
  const text = await readFile(path, "utf8");
  if (text.length > 1024 * 1024 || !/<plist(?:\s|>)/u.test(text)) {
    throw new Error(`A portable XML plist value could not be read from ${path}`);
  }
  const encodedKey = escapeRegExp(escapeXml(key));
  const match = text.match(new RegExp(`<key>\\s*${encodedKey}\\s*</key>\\s*<(string|date|integer|real)>([\\s\\S]*?)</\\1>`, "u"));
  if (!match) throw new Error(`Plist key is missing: ${key}`);
  return decodeXml(match[2]).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
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
        "Searched the local MobileSync backup folder, Vigil layout checkpoints, and mounted external volumes.",
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
    ].join("\n"), { cause: error });
  }
}

function errorDetail(error) {
  return `${error?.stdout || ""}\n${error?.stderr || error?.message || error}`.trim();
}
