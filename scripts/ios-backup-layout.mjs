import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
