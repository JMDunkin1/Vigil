import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => {});
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
