import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = existsSync(resolve(process.cwd(), "scripts", "vigil-agent.mjs"))
  ? resolve(process.cwd())
  : resolve(process.cwd(), "..", "..");
const firstStartedAt = "2026-07-26T04:44:02.715Z";
const secondStartedAt = "2026-07-26T05:44:02.715Z";
let relaunchCalls = 0;
let relaunchIntent = "";
let healthReads = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && url.pathname === "/api/health") {
    healthReads += 1;
    response.end(JSON.stringify({
      app: {
        startedAt: relaunchCalls > 0 ? secondStartedAt : firstStartedAt
      },
      liveness: { ok: true, status: "alive" },
      readiness: {
        ok: false,
        status: "not-ready",
        blockers: ["an unrelated optional integration is degraded"]
      }
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/app-relaunch") {
    relaunchCalls += 1;
    relaunchIntent = String(request.headers["x-vigil-intent"] || "");
    response.statusCode = 202;
    response.end(JSON.stringify({
      ok: true,
      relaunching: true,
      message: "Vigil is relaunching under its restart supervisor."
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
});

await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await execFileAsync(process.execPath, [
    resolve(sourceRoot, "scripts", "vigil-agent.mjs"),
    "relaunch",
    "--poll-milliseconds", "10",
    "--timeout-seconds", "2"
  ], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      VIGIL_URL: `http://127.0.0.1:${address.port}`
    }
  });
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.ok, true);
  assert.equal(output.relaunched, true);
  assert.equal(output.previousStartedAt, firstStartedAt);
  assert.equal(output.startedAt, secondStartedAt);
  assert.equal(relaunchCalls, 1, "the agent must schedule exactly one protected relaunch");
  assert.equal(relaunchIntent, "vigil-app", "the agent relaunch command must retain the strict local intent guard");
  assert.ok(healthReads >= 2, "the agent must verify a distinct post-relaunch runtime generation");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}
