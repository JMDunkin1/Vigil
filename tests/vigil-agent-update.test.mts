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
const targetCommit = "a".repeat(40);
let statusReads = 0;
let startCalls = 0;
let startIntent = "";

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && url.pathname === "/api/app-update/status") {
    statusReads += 1;
    if (startCalls === 0) {
      response.end(JSON.stringify({
        ok: true,
        checkOk: true,
        supported: true,
        running: false,
        updateAvailable: true,
        localChanges: false,
        upstreamCommit: targetCommit,
        phase: "available",
        message: "Update available"
      }));
      return;
    }
    if (statusReads < 3) {
      response.end(JSON.stringify({
        ok: true,
        checkOk: true,
        supported: true,
        running: true,
        updateAvailable: false,
        phase: "installing",
        message: "Installing"
      }));
      return;
    }
    response.end(JSON.stringify({
      ok: true,
      checkOk: true,
      supported: true,
      running: false,
      recoveryPending: false,
      updateAvailable: false,
      installedAppCurrent: true,
      appCommit: targetCommit,
      phase: "complete",
      message: "Update complete"
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/app-update/start") {
    startCalls += 1;
    startIntent = String(request.headers["x-vigil-intent"] || "");
    response.statusCode = 202;
    response.end(JSON.stringify({
      ok: true,
      supported: true,
      running: true,
      phase: "starting",
      message: "Starting"
    }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    response.end(JSON.stringify({
      liveness: { ok: true, status: "alive" },
      readiness: { ok: true, status: "ready", blockers: [] }
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
    "update",
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
  assert.equal(output.updated, true);
  assert.equal(output.phase, "complete");
  assert.equal((output.target as { commit?: unknown }).commit, targetCommit);
  assert.equal(startCalls, 1, "the one-command pathway must start exactly one protected transaction");
  assert.equal(startIntent, "vigil-app", "the agent CLI must retain the loopback mutation intent guard");
  assert.ok(statusReads >= 3, "the agent CLI must wait for post-restart installed-build verification");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}
