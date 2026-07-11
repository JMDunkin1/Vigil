import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

interface PayloadValidationResult {
  durationMs: number;
  encrypted: boolean;
  manifestEntries: number;
  manifestFiles: number;
  ok: boolean;
  payloadFilesFound: number;
}

interface FixtureEntry {
  domain?: string;
  fileId: string;
  kind?: "directory" | "file";
  path?: string;
  size?: number;
  wrappedKey?: string;
}

const sourceRoot = await findSourceRoot();
const backupLayoutPath = join(sourceRoot, "scripts", "ios-backup-layout.mjs");
const backupLayoutSource = await readFile(backupLayoutPath, "utf8");
const backupLayoutModule = await import(pathToFileURL(backupLayoutPath).href);
const validateRestorableBackupPayload = backupLayoutModule.validateRestorableBackupPayload as (options: {
  backupPath: string;
  password?: string;
  pythonPath: string;
  timeoutMs?: number;
}) => Promise<PayloadValidationResult>;

const workspace = await mkdtemp(join(tmpdir(), "sentinel-ios-payload-validation-"));
const pythonFixtureRoot = join(workspace, "python-fixture");
const originalPythonPath = process.env.PYTHONPATH;
const localPythonPath = join(sourceRoot, "data", "ios-tools", "pymobiledevice3-venv", "bin", "python");
const pythonPath = process.env.PYIOSBACKUP_PYTHON
  || ((await fileExists(localPythonPath)) ? localPythonPath : "python3");
const execFileAsync = promisify(execFile);
const zeroFileId = "0".repeat(40);
const dataFileId = "a".repeat(40);
const missingFileId = "b".repeat(40);
const presentFileId = "c".repeat(40);
const linkedFileId = "d".repeat(40);
const encryptedZeroFileId = "e".repeat(40);
const wrappingKey = Buffer.alloc(32, 0x11);
const fileKey = Buffer.alloc(32, 0x22);
const wrappedFileKey = wrapFileKey(wrappingKey, fileKey).toString("hex");

try {
  await installFakePyiosbackup(pythonFixtureRoot);
  process.env.PYTHONPATH = [pythonFixtureRoot, originalPythonPath].filter(Boolean).join(delimiter);
  const supportsCryptography = await canImportCryptography(pythonPath);

  const validBackup = await createFixture("valid", {
    entries: [
      { fileId: "directory", kind: "directory", path: "Library" },
      { fileId: zeroFileId, path: "Library/empty", size: 0 },
      { fileId: dataFileId, path: "Library/value", size: 4 }
    ],
    payloads: new Map([
      [zeroFileId, Buffer.alloc(0)],
      [dataFileId, Buffer.from("data")]
    ])
  });
  const valid = await validateRestorableBackupPayload({ backupPath: validBackup, pythonPath });
  assert.equal(valid.ok, true);
  assert.equal(valid.encrypted, false);
  assert.equal(valid.manifestEntries, 3);
  assert.equal(valid.manifestFiles, 2);
  assert.equal(valid.payloadFilesFound, 2);

  const missingBackup = await createFixture("missing", {
    entries: [
      { fileId: missingFileId, path: "Library/missing", size: 5 },
      { fileId: presentFileId, path: "Library/present", size: 4 }
    ],
    payloads: new Map([[presentFileId, Buffer.from("data")]])
  });
  await assert.rejects(
    () => validateRestorableBackupPayload({ backupPath: missingBackup, pythonPath }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /missingPayloads/);
      assert.match(message, /"manifestEntries": 2/);
      return true;
    }
  );

  const emptyBackup = await createFixture("unexpected-empty", {
    entries: [{ fileId: dataFileId, path: "Library/value", size: 4 }],
    payloads: new Map([[dataFileId, Buffer.alloc(0)]])
  });
  await assert.rejects(
    () => validateRestorableBackupPayload({ backupPath: emptyBackup, pythonPath }),
    /emptyPayloads/
  );

  if (supportsCryptography) {
    const encryptedBackup = await createFixture("encrypted", {
      encrypted: true,
      password: "correct horse",
      wrappingKey: wrappingKey.toString("hex"),
      entries: [
        { fileId: dataFileId, path: "Library/value", size: 4, wrappedKey: wrappedFileKey },
        { fileId: encryptedZeroFileId, path: "Library/empty", size: 0, wrappedKey: wrappedFileKey }
      ],
      payloads: new Map([
        [dataFileId, encryptPayload(Buffer.from("data"), fileKey)],
        [encryptedZeroFileId, encryptPayload(Buffer.alloc(0), fileKey)]
      ])
    });
    const encrypted = await validateRestorableBackupPayload({
      backupPath: encryptedBackup,
      password: "correct horse",
      pythonPath
    });
    assert.equal(encrypted.ok, true);
    assert.equal(encrypted.encrypted, true);

    const truncatedBackup = await createFixture("encrypted-truncated", {
      encrypted: true,
      password: "correct horse",
      wrappingKey: wrappingKey.toString("hex"),
      entries: [{ fileId: dataFileId, path: "Library/value", size: 4, wrappedKey: wrappedFileKey }],
      payloads: new Map([[dataFileId, encryptPayload(Buffer.from("data"), fileKey).subarray(0, 15)]])
    });
    await assert.rejects(
      () => validateRestorableBackupPayload({ backupPath: truncatedBackup, password: "correct horse", pythonPath }),
      /invalidCiphertextShapes/
    );

    const badPadding = Buffer.concat([Buffer.from("data"), Buffer.alloc(11, 12), Buffer.from([11])]);
    const wrongPaddingBackup = await createFixture("encrypted-wrong-padding", {
      encrypted: true,
      password: "correct horse",
      wrappingKey: wrappingKey.toString("hex"),
      entries: [{ fileId: dataFileId, path: "Library/value", size: 4, wrappedKey: wrappedFileKey }],
      payloads: new Map([[dataFileId, encryptPaddedBlocks(badPadding, fileKey)]])
    });
    await assert.rejects(
      () => validateRestorableBackupPayload({ backupPath: wrongPaddingBackup, password: "correct horse", pythonPath }),
      /paddingFailures/
    );
  } else {
    assert.match(
      backupLayoutSource,
      /if backup\.is_encrypted:\n\s+from cryptography\.hazmat\.primitives\.ciphers import Cipher, algorithms, modes/,
      "encrypted validation must keep cryptography behind the encrypted-backup branch when runtime coverage is unavailable"
    );
  }

  const symlinkBucketBackup = await createFixture("symlink-bucket", {
    entries: [{ fileId: linkedFileId, path: "Library/linked", size: 4 }],
    payloads: new Map()
  });
  const outsideBucket = join(workspace, "outside-bucket");
  await mkdir(outsideBucket, { recursive: true });
  await writeFile(join(outsideBucket, linkedFileId), "data");
  await symlink(outsideBucket, join(symlinkBucketBackup, linkedFileId.slice(0, 2)), "dir");
  await assert.rejects(
    () => validateRestorableBackupPayload({ backupPath: symlinkBucketBackup, pythonPath }),
    /invalidPayloadBuckets/
  );
} finally {
  if (originalPythonPath === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = originalPythonPath;
  await rm(workspace, { recursive: true, force: true });
}

async function createFixture(name: string, {
  encrypted = false,
  entries,
  password = "",
  payloads,
  wrappingKey = ""
}: {
  encrypted?: boolean;
  entries: FixtureEntry[];
  password?: string;
  payloads: Map<string, Buffer>;
  wrappingKey?: string;
}): Promise<string> {
  const backupPath = join(workspace, name);
  await mkdir(backupPath, { recursive: true });
  await writeFile(join(backupPath, "entries.json"), `${JSON.stringify({ encrypted, entries, password, wrappingKey })}\n`);
  for (const [fileId, content] of payloads) {
    const bucket = join(backupPath, fileId.slice(0, 2));
    await mkdir(bucket, { recursive: true });
    await writeFile(join(bucket, fileId), content);
  }
  return backupPath;
}

async function installFakePyiosbackup(root: string): Promise<void> {
  const packageRoot = join(root, "pyiosbackup");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "__init__.py"), "");
  await writeFile(join(packageRoot, "keybag.py"), `
class ParsedKey:
    def __init__(self, key):
        self.class_ = 1
        self.key = key

class EncryptionKeyStruct:
    def parse(self, value):
        return ParsedKey(value)

encryption_key_struct = EncryptionKeyStruct()
`);
  await writeFile(join(packageRoot, "backup.py"), `
import json
from pathlib import Path

class Keybag:
    def __init__(self, wrapping_key):
        self.wrapping_key = wrapping_key

    def get_key(self, class_):
        if class_ != 1:
            raise ValueError("unknown fixture key class")
        return self.wrapping_key

class Entry:
    def __init__(self, backup, value):
        self.backup = backup
        self.domain = value.get("domain", "HomeDomain")
        self.file_id = value.get("fileId", "")
        self.relative_path = value.get("path", "")
        self.size = value.get("size", 0)
        self.kind = value.get("kind", "file")
        self.encryption_key = bytes.fromhex(value.get("wrappedKey", ""))

    @property
    def hash_path(self):
        return Path(self.file_id[:2]) / self.file_id

    def is_file(self):
        return self.kind == "file"

class Backup:
    def __init__(self, path, value):
        self.path = path
        self.is_encrypted = bool(value.get("encrypted", False))
        self.entries = value.get("entries", [])
        self.keybag = Keybag(bytes.fromhex(value.get("wrappingKey", "")))

    @staticmethod
    def from_path(path, password=""):
        path = Path(path)
        value = json.loads((path / "entries.json").read_text())
        if value.get("password", "") != password:
            raise ValueError("incorrect fixture password")
        return Backup(path, value)

    def iter_entries(self):
        for value in self.entries:
            yield Entry(self, value)
`);
}

function wrapFileKey(wrappingKey: Buffer, value: Buffer): Buffer {
  const cipher = createCipheriv("id-aes256-wrap", wrappingKey, Buffer.alloc(8, 0xa6));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

function encryptPayload(value: Buffer, key: Buffer): Buffer {
  const padLength = 16 - (value.length % 16);
  return encryptPaddedBlocks(Buffer.concat([value, Buffer.alloc(padLength, padLength)]), key);
}

function encryptPaddedBlocks(value: Buffer, key: Buffer): Buffer {
  assert.equal(value.length % 16, 0);
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(value), cipher.final()]);
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

async function canImportCryptography(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ["-c", "import cryptography"], { env: process.env });
    return true;
  } catch {
    return false;
  }
}
