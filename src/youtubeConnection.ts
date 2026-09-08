import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { resolveDefaultDataDir } from "./dataPaths.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const youtubeConnectionPath = () => join(process.env.VIGIL_DATA_DIR || resolveDefaultDataDir(runtimeRoot), "youtube-connection.json");
export async function ensureYouTubeConnection() {
  const path = youtubeConnectionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacyHost = hostname().replace(/\.local$/i, "");
  let host = legacyHost.split(".")[0];
  if (process.platform === "darwin") {
    try {
      const localName = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (/^[A-Za-z0-9-]+$/.test(localName)) host = localName;
    } catch { /* Fall back to the short local host name. */ }
  }
  const fresh = { server: `http://${host}.local:8789`, token: randomBytes(32).toString("hex") };
  try { await writeFile(path, JSON.stringify(fresh), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const value = JSON.parse(await readFile(path, "utf8")) as typeof fresh;
  if (!/^https?:\/\//.test(value.server) || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid YouTube companion connection configuration.");
  if (host !== legacyHost && value.server === `http://${legacyHost}.local:8789`) {
    value.server = fresh.server;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  }
  return value;
}
export function youtubeTokenMatches(supplied: unknown): boolean {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const value = JSON.parse(readFileSync(youtubeConnectionPath(), "utf8")) as { token?: string };
    const expected = Buffer.from(value.token || ""); const candidate = Buffer.from(supplied);
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  } catch { return false; }
}
