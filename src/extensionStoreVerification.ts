import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHROME_WEB_STORE_UPDATE_URL, verifyExtensionRelease } from "./managedChatgptExtension.js";
import type { ExtensionPublication } from "./managedChatgptExtension.js";

const runFile = promisify(execFile);
const MAX_CRX_BYTES = 16 * 1024 * 1024;

// Verify the publisher's CRX3 proof for the expected ID, not merely a HTTPS download.
export function verifyCrx3Publisher(crx: Buffer, extensionId: string): Buffer {
  if (crx.length < 12 || crx.length > MAX_CRX_BYTES || crx.toString("ascii", 0, 4) !== "Cr24" || crx.readUInt32LE(4) !== 3) {
    throw new Error("Expected a bounded signed CRX3 package.");
  }
  const headerLength = crx.readUInt32LE(8);
  if (headerLength > 1024 * 1024 || 12 + headerLength >= crx.length) throw new Error("Malformed CRX3 header.");
  const fields = protobufFields(crx.subarray(12, 12 + headerLength));
  const signedHeaders = fields.filter(field => field.number === 10000);
  if (signedHeaders.length !== 1) throw new Error("Missing or ambiguous CRX3 signed header.");
  const signedHeader = signedHeaders[0]!.bytes;
  const ids = protobufFields(signedHeader).filter(field => field.number === 1);
  if (ids.length !== 1 || ids[0]!.bytes.length !== 16 || idFromDigest(ids[0]!.bytes) !== extensionId) throw new Error("Signed CRX3 identity mismatch.");
  const archive = crx.subarray(12 + headerLength);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signedBytes = Buffer.concat([Buffer.from("CRX3 SignedData\0", "ascii"), length, signedHeader, archive]);
  let expectedPublisherFound = false;
  const proofs = fields.filter(field => field.number === 2 || field.number === 3);
  const valid = proofs.length > 0 && proofs.every(field => {
    try {
      const proof = protobufFields(field.bytes);
      const keys = proof.filter(item => item.number === 1);
      const signatures = proof.filter(item => item.number === 2);
      if (keys.length !== 1 || signatures.length !== 1) return false;
      const publicKey = keys[0]!.bytes;
      const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
      if (field.number === 2 ? key.asymmetricKeyType !== "rsa"
        : key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
      if (!verify("sha256", signedBytes, key, signatures[0]!.bytes)) return false;
      expectedPublisherFound ||= idFromDigest(createHash("sha256").update(publicKey).digest().subarray(0, 16)) === extensionId;
      return true;
    } catch { return false; }
  });
  if (!valid || !expectedPublisherFound) throw new Error("CRX3 publisher signature verification failed.");
  return archive;
}

export async function verifyChromeWebStoreRelease(directory: string, chromiumVersion: string): Promise<ExtensionPublication> {
  const release = await verifyExtensionRelease(directory);
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(chromiumVersion)) throw new Error("The installed Chromium version is required for the store check.");
  const url = new URL(CHROME_WEB_STORE_UPDATE_URL);
  url.search = new URLSearchParams({ response: "redirect", prodversion: chromiumVersion, acceptformat: "crx3", x: `id=${release.extensionId}&uc` }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`The exact companion is not available from the Chrome Web Store (HTTP ${response.status}). No policy was exported.`);
  const finalHost = new URL(response.url).hostname;
  if (!(finalHost === "clients2.google.com" || finalHost.endsWith(".googleusercontent.com"))) throw new Error("Unexpected extension distribution host.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty store response.");
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > MAX_CRX_BYTES) { await reader.cancel(); throw new Error("Store package exceeds the verified size limit."); }
    chunks.push(Buffer.from(next.value));
  }
  const archive = verifyCrx3Publisher(Buffer.concat(chunks), release.extensionId);
  const temporary = await mkdtemp(join(tmpdir(), "vigil-store-verification-"));
  try {
    const archivePath = join(temporary, "package.zip");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    const entries = (await runFile("/usr/bin/unzip", ["-Z1", archivePath], { maxBuffer: 1024 * 1024 })).stdout.trim().split("\n");
    const delivered = entries.filter(path => !["icons/", "_metadata/", "_metadata/verified_contents.json", "_metadata/computed_hashes.json"].includes(path)).sort();
    if (JSON.stringify(delivered) !== JSON.stringify(release.files.map(file => file.path))) throw new Error("The published package has a different file inventory.");
    for (const file of release.files) {
      const bytes = (await runFile("/usr/bin/unzip", ["-p", archivePath, file.path], { encoding: "buffer", maxBuffer: MAX_CRX_BYTES })).stdout;
      if (file.path === "manifest.json") {
        const expected = JSON.parse(await readFile(join(directory, "payload", file.path), "utf8"));
        const actual = JSON.parse(bytes.toString());
        if (actual.version !== release.version || (actual.update_url && actual.update_url !== CHROME_WEB_STORE_UPDATE_URL)
          || (actual.key && actual.key !== expected.key)) throw new Error("Published manifest identity or version mismatch.");
        delete actual.key;
        delete expected.key;
        delete actual.update_url;
        delete expected.update_url;
        if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("The published manifest changes permissions or behavior.");
      } else if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error(`Published asset differs from the reviewed release: ${file.path}`);
      }
    }
    return { extensionId: release.extensionId, published: true, publishedVersion: release.version };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function idFromDigest(digest: Buffer): string { return digest.toString("hex").replace(/[0-9a-f]/gu, character => String.fromCharCode(97 + Number.parseInt(character, 16))); }

function protobufFields(bytes: Buffer): Array<{ number: number; bytes: Buffer }> {
  let cursor = 0;
  const fields: Array<{ number: number; bytes: Buffer }> = [];
  const integer = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (cursor >= bytes.length) throw new Error("Truncated CRX3 protobuf.");
      const next = bytes[cursor++]!;
      value += (next & 127) * 2 ** shift;
      if (!(next & 128)) return value;
    }
    throw new Error("Oversized CRX3 protobuf integer.");
  };
  while (cursor < bytes.length) {
    const tag = integer();
    if (Math.floor(tag / 8) === 0) throw new Error("Invalid CRX3 protobuf field.");
    if (tag % 8 === 0) { integer(); continue; }
    if (tag % 8 !== 2) throw new Error("Unsupported CRX3 protobuf field.");
    const length = integer();
    if (length > bytes.length - cursor) throw new Error("Truncated CRX3 protobuf field.");
    fields.push({ number: Math.floor(tag / 8), bytes: bytes.subarray(cursor, cursor + length) });
    cursor += length;
  }
  return fields;
}
