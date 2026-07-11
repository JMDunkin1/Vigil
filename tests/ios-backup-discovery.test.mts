import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface LayoutBackupCandidate {
  completedAt: string;
  path: string;
  reason?: string;
  source: string;
  usable: boolean;
}

interface BackupCandidateInput {
  path: string;
  source: string;
}

interface BackupResolverOptions {
  dataDir?: string;
  homeDir?: string;
  inputPath?: string;
  udid: string;
  volumesRoot?: string;
}

const sourceRoot = await findSourceRoot();
const backupLayoutModule = await import(pathToFileURL(join(sourceRoot, "scripts", "ios-backup-layout.mjs")).href);
const supervisionSource = await readFile(join(sourceRoot, "scripts", "supervise-ios-preserving-layout.mjs"), "utf8");
const resolveNewestLayoutBackup = backupLayoutModule.resolveNewestLayoutBackup as (options: BackupResolverOptions) => Promise<LayoutBackupCandidate>;
const inspectLayoutBackupCandidates = backupLayoutModule.inspectLayoutBackupCandidates as (
  candidates: BackupCandidateInput[],
  udid?: string
) => Promise<LayoutBackupCandidate[]>;
const assertRestorableLayoutBackup = backupLayoutModule.assertRestorableLayoutBackup as (
  path: string,
  options?: { source?: string; udid?: string }
) => Promise<LayoutBackupCandidate>;
assert.match(
  supervisionSource,
  /async function restoreCheckpoint[\s\S]*?await assertRestorableLayoutBackup\([\s\S]*?await validateCheckpointPayload\([\s\S]*?"--remove"/u,
  "the destructive restore must revalidate metadata and payload completeness immediately before backup2 restore --remove"
);
assert.ok(
  supervisionSource.indexOf("await validateCheckpointPayload(checkpointRoot, udid, options.password")
    < supervisionSource.indexOf("await restorePreSupervisionSetupState("),
  "the full checkpoint payload must be validated before the first iPhone restore or supervision mutation"
);

const workspace = await mkdtemp(join(tmpdir(), "vigil-ios-backups-"));
const udid = "00008150-000954C63628401C";
const homeDir = join(workspace, "home", "jamesdunkin");
const volumesRoot = join(workspace, "Volumes");
const dataDir = join(workspace, "data");

try {
  const localBackup = join(homeDir, "Library", "Application Support", "MobileSync", "Backup", udid);
  const externalBackup = join(volumesRoot, "iPhone Backups", "MobileSync", "Backup", udid);
  const externalChildBackup = join(volumesRoot, "iPhone Backups", "EncryptionRefresh", udid);
  const t7FinishedSnapshot = join(
    volumesRoot,
    "T7 Shield",
    "2026-06-23-215914.previous",
    "Data",
    "Users",
    "jamesdunkin",
    "Library",
    "Application Support",
    "MobileSync",
    "Backup",
    udid
  );
  const t7UploadingSnapshot = join(
    volumesRoot,
    "T7 Shield",
    "2026-07-09-014454.inprogress",
    "Data",
    "Users",
    "jamesdunkin",
    "Library",
    "Application Support",
    "MobileSync",
    "Backup",
    udid
  );
  const newestIncomplete = join(volumesRoot, "iPhone Backups", "PyMobileBackups", udid);
  const missingSnapshotState = join(volumesRoot, "iPhone Backups", "Missing Snapshot State", udid);
  const mixedRequestedRoot = join(volumesRoot, "Mixed Requested Root");
  const mixedCorrectBackup = join(mixedRequestedRoot, "Older Good Backup", udid);

  await createCompleteBackup(localBackup, "2026-06-01T12:00:00Z");
  await createCompleteBackup(t7FinishedSnapshot, "2026-06-23T22:24:20Z");
  await createCompleteBackup(externalBackup, "2026-07-01T12:00:00Z");
  await createCompleteBackup(externalChildBackup, "2026-07-02T12:00:00Z");
  await createCompleteBackup(t7UploadingSnapshot, "2026-07-09T05:57:15Z", "uploading");
  await createIncompleteBackup(newestIncomplete, "2026-07-09T06:00:00Z");
  await createCompleteBackup(missingSnapshotState, "2026-07-10T06:00:00Z", null);
  await createCompleteBackup(mixedRequestedRoot, "2026-07-05T12:00:00Z", "finished", "00008150-WRONGDEVICE");
  await createCompleteBackup(mixedCorrectBackup, "2026-06-30T12:00:00Z");

  const selected = await resolveNewestLayoutBackup({ dataDir, homeDir, udid, volumesRoot });
  assert.equal(selected.path, externalChildBackup);
  assert.equal(selected.completedAt, "2026-07-02T12:00:00.000Z");
  assert.equal(selected.source, "external backup folder on iPhone Backups");

  const [missingState, partialState, finishedState] = await inspectLayoutBackupCandidates([
    { path: missingSnapshotState, source: "missing state fixture" },
    { path: t7UploadingSnapshot, source: "partial state fixture" },
    { path: externalChildBackup, source: "finished state fixture" }
  ], udid);
  assert.equal(missingState.usable, false);
  assert.match(missingState.reason || "", /no readable SnapshotState/);
  assert.equal(partialState.usable, false);
  assert.match(partialState.reason || "", /SnapshotState=uploading/);
  assert.equal(finishedState.usable, true);
  assert.equal(finishedState.completedAt, "2026-07-02T12:00:00.000Z");
  await assert.rejects(
    () => assertRestorableLayoutBackup(missingSnapshotState, { udid }),
    /completion cannot be proven/
  );
  await assert.rejects(
    () => assertRestorableLayoutBackup(t7UploadingSnapshot, { udid }),
    /SnapshotState=uploading/
  );
  assert.equal((await assertRestorableLayoutBackup(externalChildBackup, { udid })).usable, true);

  const selectedFromVolumeRoot = await resolveNewestLayoutBackup({
    homeDir,
    inputPath: join(volumesRoot, "iPhone Backups"),
    udid
  });
  assert.equal(selectedFromVolumeRoot.path, externalChildBackup);

  const selectedFromSnapshotRoot = await resolveNewestLayoutBackup({
    homeDir,
    inputPath: join(volumesRoot, "T7 Shield"),
    udid
  });
  assert.equal(selectedFromSnapshotRoot.path, t7FinishedSnapshot);
  assert.match(selectedFromSnapshotRoot.source, /mounted snapshot/);

  const selectedFromMixedRequestedRoot = await resolveNewestLayoutBackup({
    homeDir,
    inputPath: mixedRequestedRoot,
    udid
  });
  assert.equal(selectedFromMixedRequestedRoot.path, mixedCorrectBackup);

  await assert.rejects(
    () => resolveNewestLayoutBackup({
      homeDir,
      inputPath: join(volumesRoot, "Only Incomplete"),
      udid
    }),
    /Could not find a complete iPhone layout backup/
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}

async function createCompleteBackup(
  path: string,
  date: string,
  snapshotState: string | null = "finished",
  backupUdid = udid
): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "Info.plist"), plist({ "Unique Identifier": backupUdid }));
  await writeFile(join(path, "Manifest.plist"), plist({ Version: "9.1" }));
  await writeFile(join(path, "Manifest.db"), "sqlite placeholder\n");
  await writeFile(join(path, "Status.plist"), statusPlist(date, snapshotState));
}

async function createIncompleteBackup(path: string, date: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "Info.plist"), plist({ "Unique Identifier": udid }));
  await writeFile(join(path, "Manifest.plist"), "");
  await writeFile(join(path, "Status.plist"), statusPlist(date, "finished"));
}

function statusPlist(date: string, snapshotState: string | null): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "<key>BackupState</key>",
    "<string>new</string>",
    "<key>Date</key>",
    `<date>${date}</date>`,
    "<key>IsFullBackup</key>",
    "<true/>",
    ...(snapshotState === null ? [] : ["<key>SnapshotState</key>", `<string>${snapshotState}</string>`]),
    "<key>Version</key>",
    "<string>3.3</string>",
    "</dict>",
    "</plist>"
  ].join("\n");
}

function plist(values: Record<string, string>): string {
  const entries = Object.entries(values).flatMap(([key, value]) => [
    `<key>${escapePlist(key)}</key>`,
    `<string>${escapePlist(value)}</string>`
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>"
  ].join("\n");
}

function escapePlist(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function findSourceRoot(): Promise<string> {
  const cwd = process.cwd();
  if (await fileExists(join(cwd, "tsconfig.json"))) return cwd;
  return join(cwd, "..", "..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
