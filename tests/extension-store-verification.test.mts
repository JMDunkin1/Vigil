import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyCrx3Publisher } from "../src/extensionStoreVerification.js";

function integer(value: number): Buffer {
  const bytes: number[] = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function field(number: number, bytes: Buffer): Buffer { return Buffer.concat([integer(number * 8 + 2), integer(bytes.length), bytes]); }
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ format: "der", type: "spki" });
const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
const id = digest.toString("hex").replace(/[0-9a-f]/gu, character => String.fromCharCode(97 + Number.parseInt(character, 16)));
const signedHeader = field(1, digest);
const length = Buffer.alloc(4);
length.writeUInt32LE(signedHeader.length);
const payload = Buffer.from("PK-owned-test-payload");
const signature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0"), length, signedHeader, payload]), keys.privateKey);
const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
const prefix = Buffer.alloc(12);
prefix.write("Cr24", 0, "ascii");
prefix.writeUInt32LE(3, 4);
prefix.writeUInt32LE(header.length, 8);
const crx = Buffer.concat([prefix, header, payload]);
assert.deepEqual(verifyCrx3Publisher(crx, id), payload);
assert.throws(() => verifyCrx3Publisher(crx, "a".repeat(32)), /identity mismatch/);
const tampered = Buffer.from(crx);
tampered[tampered.length - 1] ^= 1;
assert.throws(() => verifyCrx3Publisher(tampered, id), /signature verification failed/);
assert.throws(() => verifyCrx3Publisher(crx.subarray(0, 20), id), /Malformed/);
const tooLong = Buffer.from(crx);
tooLong.writeUInt32LE(2 * 1024 * 1024, 8);
assert.throws(() => verifyCrx3Publisher(tooLong, id), /Malformed/);
const wrongFormat = Buffer.from(crx);
wrongFormat.writeUInt32LE(2, 4);
assert.throws(() => verifyCrx3Publisher(wrongFormat, id), /signed CRX3/);
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPublicKey = otherKeys.publicKey.export({ format: "der", type: "spki" });
const otherSignature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0"), length, signedHeader, payload]), otherKeys.privateKey);
const wrongProofHeader = Buffer.concat([field(2, Buffer.concat([field(1, otherPublicKey), field(2, otherSignature)])), field(10000, signedHeader)]);
const wrongProofPrefix = Buffer.from(prefix);
wrongProofPrefix.writeUInt32LE(wrongProofHeader.length, 8);
assert.throws(() => verifyCrx3Publisher(Buffer.concat([wrongProofPrefix, wrongProofHeader, payload]), id), /signature verification failed/);
console.log("CRX3 publisher signatures, wrong identities, substituted signers, altered payloads, and malformed headers passed.");
