import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const identityUuid = String(args.uuid || randomUUID()).trim();
const outPath = resolve(String(args.out || join("data", "secrets", "ios-mdm-identity.p12")));
const force = Boolean(args.force);
const commonName = sanitizeSubjectValue(String(args["common-name"] || `Vigil MDM ${identityUuid.slice(0, 8)}`)).slice(0, 64);
const passwordFromEnv = process.env.VIGIL_MDM_IDENTITY_P12_PASSWORD;
const generatedPassword = passwordFromEnv === undefined ? randomBytes(24).toString("base64url") : "";
const password = passwordFromEnv ?? generatedPassword;
const passwordPath = resolve(String(args["password-file"] || `${outPath}.password.txt`));
const keyPath = resolve(String(args["key-out"] || `${outPath}.key.pem`));
const certPath = resolve(String(args["cert-out"] || `${outPath}.cert.pem`));

validateUuid(identityUuid);
await ensureWritableOutput(outPath, force);
await ensureWritableOutput(keyPath, force);
await ensureWritableOutput(certPath, force);
if (generatedPassword) await ensureWritableOutput(passwordPath, force);

await mkdir(dirname(outPath), { recursive: true });
await mkdir(dirname(keyPath), { recursive: true });
await mkdir(dirname(certPath), { recursive: true });
if (generatedPassword) await mkdir(dirname(passwordPath), { recursive: true });

if (generatedPassword) {
  await writeFile(passwordPath, `${generatedPassword}\n`, { mode: 0o600 });
  await chmod(passwordPath, 0o600).catch(() => {});
}

const passout = generatedPassword ? `file:${passwordPath}` : `pass:${password}`;
await execOpenSsl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-sha256",
  "-days",
  "825",
  "-nodes",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-subj",
  `/CN=${commonName}/O=Vigil`
]);
await chmod(keyPath, 0o600).catch(() => {});
await chmod(certPath, 0o600).catch(() => {});

await execOpenSsl([
  "pkcs12",
  "-export",
  "-inkey",
  keyPath,
  "-in",
  certPath,
  "-out",
  outPath,
  "-name",
  "Vigil iPhone MDM Identity",
  "-passout",
  passout
]);
await chmod(outPath, 0o600).catch(() => {});

console.log("Created Vigil local MDM identity PKCS#12.");
console.log(`Identity UUID: ${identityUuid}`);
console.log(`PKCS#12: ${outPath}`);
console.log(`Certificate: ${certPath}`);
console.log(`Private key: ${keyPath}`);
if (generatedPassword) {
  console.log(`Password file: ${passwordPath}`);
} else {
  console.log("Password: read from VIGIL_MDM_IDENTITY_P12_PASSWORD");
}
console.log("");
console.log("Configure with:");
console.log(`VIGIL_MDM_IDENTITY_UUID=${identityUuid} \\`);
console.log(`VIGIL_MDM_IDENTITY_P12=${outPath} \\`);
console.log(`${generatedPassword ? `VIGIL_MDM_IDENTITY_P12_PASSWORD="$(cat ${shellQuote(passwordPath)})"` : "VIGIL_MDM_IDENTITY_P12_PASSWORD='<same env value>'"}`);
console.log("");
console.log("This identity is only for the MDM enrollment profile. It is not an Apple MDM APNs push certificate.");

function parseArgs(values: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || "";
    if (!value.startsWith("--")) continue;
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) {
      parsed[name] = inline;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[name] = values[index + 1];
      index += 1;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}

function validateUuid(value: string): void {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return;
  throw new Error(`Invalid identity UUID: ${value}`);
}

async function ensureWritableOutput(path: string, allowOverwrite: boolean): Promise<void> {
  const existing = await stat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (existing && !allowOverwrite) throw new Error(`${path} already exists. Re-run with --force to replace it.`);
}

async function execOpenSsl(args: string[]): Promise<void> {
  try {
    await execFileAsync("/usr/bin/openssl", args, { timeout: 15_000, maxBuffer: 1024 * 256 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openssl ${args[0]} failed: ${message}`, { cause: error });
  }
}

function sanitizeSubjectValue(value: string): string {
  return value.replace(/[/\n\r]/g, " ").trim() || "Vigil iPhone MDM Identity";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
