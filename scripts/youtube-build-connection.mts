import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { youtubeConnectionPath } from "../src/youtubeConnection.js";

// Bundle the same tested policy engine used by desktop. No server or credential
// is needed by the phone. A migration seed is used only on its first local run.
export async function youtubeLocalEngine(): Promise<string> {
  const compiled = await readFile(new URL("../src/youtubeLimits.js", import.meta.url), "utf8");
  return 'var structuredClone = value => JSON.parse(JSON.stringify(value));\n'
    + compiled.replace(/import \{ randomUUID \} from "node:crypto";/u, 'const randomUUID = () => __uuid();')
      .replace(/^export /gmu, "")
    + '\nfunction vigilLocalAction(state, body) { const value = JSON.parse(state); const reply = youtubeAction(value, JSON.parse(body)); return JSON.stringify({state:value,reply}); }\n';
}
export async function youtubeBuildConfiguration(): Promise<string> {
  const folder = dirname(youtubeConnectionPath());
  let seed = {};
  try {
    const state = JSON.parse(await readFile(join(folder, "state.json"), "utf8"));
    if (state.youtubeLimits) seed = { youtubeLimits: state.youtubeLimits };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(join(folder, "youtube-local"), { recursive: true, mode: 0o700 });
  const path = join(folder, "youtube-local", "youtube-connection.json");
  await writeFile(path, JSON.stringify({ mode: "local", engine: await youtubeLocalEngine(), seed }), { mode: 0o600 });
  return path;
}
