import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBrowserActivityWake, parseHumanActivitySample } from "../src/macos.js";

if (process.platform === "darwin") {
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const helperPath = join(runtimeRoot, "bin", "vigil-human-idle");
  await access(helperPath);

  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end("watch\nunwatch\n\n");

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, `helper failed: ${stderr}`);

  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  const samples = lines.map((line) => parseHumanActivitySample(line)).filter(Boolean);
  assert.equal(samples.length, 1, "watch/unwatch commands must not be mistaken for idle-sample requests");
  for (const line of lines) {
    assert.ok(parseHumanActivitySample(line) || parseBrowserActivityWake(line), `unexpected helper record: ${line}`);
  }
}
