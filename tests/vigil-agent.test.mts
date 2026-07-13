import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agentScript = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/vigil-agent.mjs");

const invalidBatch = JSON.stringify({
  operations: [
    { resource: "schedule", values: { name: "Work hours" } },
    { resource: "scheduel", values: { name: "Evening" } }
  ]
});
const result = spawnSync(process.execPath, [agentScript, "apply", "-"], {
  cwd: process.cwd(),
  env: { ...process.env, VIGIL_URL: "http://127.0.0.1:1" },
  input: invalidBatch,
  encoding: "utf8"
});

assert.equal(result.status, 1, "an invalid agent batch must fail");
assert.match(result.stderr, /Operation 2 has unknown resource: scheduel/, "the full batch must be validated before the first request");
assert.doesNotMatch(result.stderr, /not reachable/, "validation must fail before any earlier operation mutates Vigil");
