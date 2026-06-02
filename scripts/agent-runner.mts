import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "src", "server.js");
const healthUrl = "http://127.0.0.1:8787/api/state";

let child: ChildProcess | null = null;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

while (true) {
  if (await serverIsHealthy()) {
    await sleep(10_000);
    continue;
  }

  const runningChild = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LOCAL_VIGIL_AGENT_CHILD: "1" }
  });
  child = runningChild;

  const exitCode = await new Promise<string | number | null>((resolve) => {
    runningChild.once("exit", (code, signal) => resolve(signal || code));
  });
  child = null;
  console.error(`Vigil child exited: ${exitCode}`);
  await sleep(2_000);
}

async function serverIsHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const health = await fetchVigilStateHealth(healthUrl, {
      signal: controller.signal,
      expectedPort: 8787
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function shutdown(): void {
  if (child) child.kill("SIGTERM");
  process.exit(0);
}
