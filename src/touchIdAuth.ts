import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const TOUCH_ID_SECRET_FILE = "touch-id.key";
const SECRET_BYTES = 32;
const cachedSecrets = new Map<string, Promise<string>>();

export function touchIdSecretPath(dataDir: string): string {
  return join(dataDir, TOUCH_ID_SECRET_FILE);
}

export function getTouchIdSecret(dataDir: string): Promise<string> {
  const path = touchIdSecretPath(dataDir);
  const cached = cachedSecrets.get(path);
  if (cached) return cached;
  const pending = readOrCreateSecret(dataDir, path).catch((error) => {
    cachedSecrets.delete(path);
    throw error;
  });
  cachedSecrets.set(path, pending);
  return pending;
}

async function readOrCreateSecret(dataDir: string, path: string): Promise<string> {
  const existing = await readSecret(path);
  if (existing) return existing;

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${secret}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600).catch(() => {});
    return secret;
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) throw error;
    const concurrentlyCreated = await readSecret(path);
    if (concurrentlyCreated) return concurrentlyCreated;
    throw new Error("The persistent Touch ID key is empty.");
  }
}

async function readSecret(path: string): Promise<string> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!value) return "";
    await chmod(path, 0o600).catch(() => {});
    return value;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
