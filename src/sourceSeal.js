import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_SEAL_PATH, STATE_SEAL_KEY_PATH } from "./store.js";
import { verifyStateTextSeal, writeStateTextSeal } from "./seal.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRS = ["src", "scripts", "public", "extension"];
const SOURCE_FILES = ["package.json"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".json", ".html", ".css"]);

export async function sourceSealStatus(options = {}) {
  const root = options.root || ROOT;
  const text = await sourceManifestText({ root });
  const verification = await verifyStateTextSeal(text, {
    keyPath: options.keyPath || STATE_SEAL_KEY_PATH,
    sealPath: options.sealPath || SOURCE_SEAL_PATH
  });
  const manifest = JSON.parse(text);
  return sourceSealSummary(verification, manifest.files.length);
}

export async function writeSourceSeal(options = {}) {
  const root = options.root || ROOT;
  const text = await sourceManifestText({ root });
  const seal = await writeStateTextSeal(text, {
    keyPath: options.keyPath || STATE_SEAL_KEY_PATH,
    sealPath: options.sealPath || SOURCE_SEAL_PATH
  }, options.sealedAt || new Date().toISOString());
  const manifest = JSON.parse(text);
  return {
    ok: true,
    status: "sealed",
    detail: `Source files sealed (${manifest.files.length} files).`,
    sealedAt: seal.sealedAt,
    checkedAt: new Date().toISOString(),
    fileCount: manifest.files.length
  };
}

export async function sourceManifestText({ root = ROOT } = {}) {
  const files = await sourceManifestFiles(root);
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

export async function sourceManifestFiles(root = ROOT) {
  const files = [];

  for (const file of SOURCE_FILES) {
    await addFile(root, join(root, file), files);
  }

  for (const dir of SOURCE_DIRS) {
    await walkSourceDir(root, join(root, dir), files);
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sourceSealSummary(verification, fileCount) {
  if (verification.ok) {
    return {
      ok: true,
      status: "sealed",
      detail: `Source files match integrity seal (${fileCount} files).`,
      sealedAt: verification.sealedAt || null,
      checkedAt: verification.checkedAt,
      fileCount
    };
  }

  const detail = sourceSealDetail(verification, fileCount);
  return {
    ok: false,
    status: verification.status,
    detail,
    sealedAt: verification.sealedAt || null,
    checkedAt: verification.checkedAt,
    fileCount
  };
}

function sourceSealDetail(verification, fileCount) {
  if (verification.status === "missing" || verification.status === "missing-seal") {
    return `Source integrity seal is missing for ${fileCount} files. Run npm run seal:source after reviewing local code.`;
  }
  if (verification.status === "missing-key") {
    return "Source integrity seal key is missing. Run npm run seal:source after reviewing local code.";
  }
  if (verification.status === "mismatch") {
    return "Source files do not match the integrity seal. Review code changes, then run npm run seal:source if trusted.";
  }
  if (verification.status === "invalid-seal") {
    return "Source integrity seal is invalid. Review code changes, then run npm run seal:source if trusted.";
  }
  return verification.detail || "Source integrity seal could not be verified.";
}

async function walkSourceDir(root, dir, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSourceDir(root, fullPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      await addFile(root, fullPath, files);
    }
  }
}

async function addFile(root, fullPath, files) {
  try {
    const bytes = await readFile(fullPath);
    files.push({
      path: relative(root, fullPath).split(sep).join("/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
