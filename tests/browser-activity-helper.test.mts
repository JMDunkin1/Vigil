import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApplicationActivity, parseBrowserActivityWake, parseBrowserActivityWatchHeartbeat, parseHumanActivitySample } from "../src/macos.js";

if (process.platform === "darwin") {
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const helperPath = join(runtimeRoot, "bin", "vigil-human-idle");
  await access(helperPath);

  const child = spawn(helperPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OBJC_DEBUG_MISSING_POOLS: "YES" }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write("watch\n");
  // Exercise the idle watch loop as well as explicit sample requests. The
  // command-line process must supply pools normally supplied by NSApplication.
  const endWatch = setTimeout(() => child.stdin.end("unwatch\n\n"), 1_200);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(endWatch);
  assert.deepEqual(result, { code: 0, signal: null }, `helper failed: ${stderr}`);
  assert.doesNotMatch(stderr, /autoreleased with no pool|MISSING POOLS/iu);

  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  const samples = lines.map((line) => parseHumanActivitySample(line)).filter(Boolean);
  assert.ok(lines.some(parseBrowserActivityWatchHeartbeat), "watch mode must remain healthy while no sample is requested");
  assert.equal(samples.length, 1, "watch/unwatch commands must not be mistaken for idle-sample requests");
  for (const line of lines) {
    assert.ok(parseApplicationActivity(line) || parseHumanActivitySample(line) || parseBrowserActivityWake(line) || parseBrowserActivityWatchHeartbeat(line),
      `unexpected helper record: ${line}`);
  }
}
