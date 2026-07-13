import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { UnknownRecord } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const JOURNAL_KEY_FILE = "journal-encryption.key";
const JOURNAL_AAD = Buffer.from("vigil-journal-entries:v1", "utf8");

interface EncryptedJournalEntries {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function journalEncryptionKeyPath(dataDir: string): string {
  return join(dataDir, JOURNAL_KEY_FILE);
}

export async function encryptJournalEntries(entries: unknown, dataDir: string): Promise<EncryptedJournalEntries> {
  const key = await getJournalEncryptionKey(dataDir);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(JOURNAL_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(Array.isArray(entries) ? entries : []), "utf8"),
    cipher.final()
  ]);
  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export async function decryptJournalEntries(value: unknown, dataDir: string): Promise<unknown[]> {
  if (!isEncryptedJournalEntries(value)) {
    throw new Error("The encrypted journal archive has an unsupported or invalid format.");
  }
  try {
    const key = await getJournalEncryptionKey(dataDir, false);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(JOURNAL_AAD);
    decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    const entries: unknown = JSON.parse(plaintext);
    if (!Array.isArray(entries)) throw new Error("Journal plaintext is not an array.");
    return entries;
  } catch (error) {
    throw new Error("Vigil could not decrypt the journal archive. The encryption key may be missing or the archive may have been changed.", { cause: error });
  }
}

export function hasEncryptedJournalEntries(value: unknown): value is UnknownRecord & { journalEntriesEncrypted: unknown } {
  return Boolean(value && typeof value === "object" && "journalEntriesEncrypted" in value);
}

async function getJournalEncryptionKey(dataDir: string, create = true): Promise<Buffer> {
  const path = journalEncryptionKeyPath(dataDir);
  try {
    const encoded = (await readFile(path, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== KEY_BYTES) throw new Error("The journal encryption key is invalid.");
    await chmod(path, 0o600).catch(() => {});
    return key;
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT") || !create) throw error;
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  const key = randomBytes(KEY_BYTES);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600).catch(() => {});
    return key;
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) throw error;
    return getJournalEncryptionKey(dataDir, false);
  }
}

function isEncryptedJournalEntries(value: unknown): value is EncryptedJournalEntries {
  if (!value || typeof value !== "object") return false;
  const record = value as UnknownRecord;
  return record.version === 1
    && record.algorithm === ALGORITHM
    && typeof record.iv === "string"
    && typeof record.authTag === "string"
    && typeof record.ciphertext === "string";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
