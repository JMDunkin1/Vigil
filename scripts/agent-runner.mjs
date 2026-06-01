import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "src", "server.js");
const healthUrl = "http://127.0.0.1:8787/api/state";

let child = null;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

while (true) {
  if (await serverIsHealthy()) {
    await sleep(10_000);
    continue;
  }

  child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LOCAL_VIGIL_AGENT_CHILD: "1" }
  });

  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(signal || code));
  });
  child = null;
  console.error(`Vigil child exited: ${exitCode}`);
  await sleep(2_000);
}

async function serverIsHealthy() {
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

function shutdown() {
  if (child) child.kill("SIGTERM");
  process.exit(0);
}
