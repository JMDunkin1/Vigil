#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "# Vigil terminal command";
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export async function installVigilCommand({ root, home = homedir(), node = process.execPath }) {
  const destination = join(home, ".local", "bin", "vigil");
  let existing;
  try { existing = await readFile(destination, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && !existing.includes(marker)) throw new Error(`${destination} already belongs to another command; it was not replaced.`);
  const contents = `#!/bin/sh\n${marker}\nexec ${quote(node)} ${quote(join(resolve(root), "scripts", "vigil.mjs"))} "$@"\n`;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o755 });
  await chmod(temporary, 0o755); await rename(temporary, destination);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  console.log(`Installed ${await installVigilCommand({ root })}\nRun from any folder: vigil update phone`);
}
