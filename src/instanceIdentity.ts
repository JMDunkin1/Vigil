import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const INSTANCE_KEY_FILENAME = "instance.key";

export async function getInstanceSecret(dataDir: string): Promise<string> {
  const path = join(dataDir, INSTANCE_KEY_FILENAME);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 43) {
      await chmod(path, 0o600);
      return existing;
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return secret;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing.length >= 43) return existing;
    }
    throw error;
  }
}

export function instanceChallengeSignature(secret: string, challenge: string): string {
  return createHmac("sha256", secret).update(challenge).digest("base64url");
}

export function verifyInstanceChallenge(secret: string, challenge: string, supplied: string): boolean {
  if (!secret || !challenge || !supplied) return false;
  const expected = Buffer.from(instanceChallengeSignature(secret, challenge));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
