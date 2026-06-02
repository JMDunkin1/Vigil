import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { distanceKeyQrMatrix } from "../../public/distance-key-qr.js";

function recordValue(value: unknown, label = "value"): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown, label = "value"): string[] {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === "string"), `${label} should be a string array`);
  return value as string[];
}

const root = process.cwd();
const appSource = await readFile(join(root, "public", "app.js"), "utf8");
const domSource = await readFile(join(root, "public", "dom.js"), "utf8");
const focusSoundSource = await readFile(join(root, "public", "focus-sound.js"), "utf8");
const formatSource = await readFile(join(root, "public", "format.js"), "utf8");
const qrSource = await readFile(join(root, "public", "distance-key-qr.js"), "utf8");
const serverSource = await readFile(join(root, "src", "server.js"), "utf8");
const devServerSource = await readFile(join(root, "scripts", "dev-server.mjs"), "utf8");
const statePayloadSource = await readFile(join(root, "src", "server", "statePayload.js"), "utf8");
const packageJson = recordValue(JSON.parse(await readFile(join(root, "package.json"), "utf8")), "package.json");

assert.match(appSource, /from "\.\/api-client\.js"/);
assert.match(appSource, /from "\.\/device-targets\.js"/);
assert.match(appSource, /from "\.\/dom\.js"/);
assert.match(appSource, /from "\.\/distance-key-qr\.js"/);
assert.match(appSource, /from "\.\/focus-sound\.js"/);
assert.match(appSource, /from "\.\/format\.js"/);
assert.doesNotMatch(appSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
assert.doesNotMatch(appSource, /function distanceKeyQrSvg|function distanceKeyQrMatrix|function qrReedSolomon/);
assert.doesNotMatch(appSource, /function createNoiseSource|async function parseResponse/);
assert.match(domSource, /document\.createElement/);
assert.match(focusSoundSource, /function createNoiseSource/);
assert.match(formatSource, /export function formatDuration/);
assert.match(qrSource, /createElementNS/);

assert.doesNotMatch(serverSource, /function blockedPage|function hardeningAudit|async function runLocalScript|function sendJson/);
assert.match(serverSource, /from "\.\/server\/pages\.js"/);
assert.match(serverSource, /from "\.\/server\/http\.js"/);
assert.match(serverSource, /from "\.\/server\/localScripts\.js"/);
assert.match(serverSource, /from "\.\/server\/apiRoutes\.js"/);
assert.match(serverSource, /from "\.\/server\/statePayload\.js"/);
assert.match(statePayloadSource, /from "\.\/hardeningSummary\.js"/);

const build = recordValue(packageJson.build, "package build");
const scripts = recordValue(packageJson.scripts, "package scripts");
assert.match(String(scripts.dev), /--watch-path=src/);
assert.match(String(scripts.dev), /dist\/runtime\/scripts\/dev-server\.mjs/);
assert.match(devServerSource, /npm", \["run", "build"\]/);
assert.equal(build.asar, true);
assert.ok(stringArrayValue(build.files, "build files").includes("dist/runtime/**/*"));
assert.ok(stringArrayValue(build.asarUnpack, "asar unpack").includes("dist/runtime/scripts/**/*"));
assert.ok(stringArrayValue(build.asarUnpack, "asar unpack").includes("dist/runtime/extension/**/*"));

const matrix = distanceKeyQrMatrix("ABCD-EFGH-1234");
assert.equal(matrix.length, 21);
assert.equal(matrix.every((row) => row.length === 21), true);
assert.equal(matrix.flat().every((value) => typeof value === "boolean"), true);
assert.throws(() => distanceKeyQrMatrix("emoji-😀"), /cannot be encoded/);
