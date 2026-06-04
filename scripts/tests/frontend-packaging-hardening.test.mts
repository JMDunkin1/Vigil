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
const sourceRoot = join(root, "..", "..");
const appTsSource = await readFile(join(sourceRoot, "public", "app.ts"), "utf8");
const appModelTsSource = await readFile(join(sourceRoot, "public", "app-model.ts"), "utf8");
const appSource = await readFile(join(root, "public", "app.js"), "utf8");
const devicePanelSource = await readFile(join(root, "public", "device-panel.js"), "utf8");
const domSource = await readFile(join(root, "public", "dom.js"), "utf8");
const distanceKeyUiSource = await readFile(join(root, "public", "distance-key-ui.js"), "utf8");
const focusSoundSource = await readFile(join(root, "public", "focus-sound.js"), "utf8");
const formatSource = await readFile(join(root, "public", "format.js"), "utf8");
const hardeningPanelSource = await readFile(join(root, "public", "hardening-panel.js"), "utf8");
const qrSource = await readFile(join(root, "public", "distance-key-qr.js"), "utf8");
const monitorSource = await readFile(join(root, "src", "monitor.js"), "utf8");
const monitorPolicySource = await readFile(join(root, "src", "monitor", "policy.js"), "utf8");
const serverSource = await readFile(join(root, "src", "server.js"), "utf8");
const extensionApiSource = await readFile(join(root, "src", "server", "extensionApi.js"), "utf8");
const policyRoutesSource = await readFile(join(root, "src", "server", "policyRoutes.js"), "utf8");
const sessionRoutesSource = await readFile(join(root, "src", "server", "sessionRoutes.js"), "utf8");
const settingsRoutesSource = await readFile(join(root, "src", "server", "settingsRoutes.js"), "utf8");
const devServerSource = await readFile(join(root, "scripts", "dev-server.mjs"), "utf8");
const statePayloadSource = await readFile(join(root, "src", "server", "statePayload.js"), "utf8");
const packageJson = recordValue(JSON.parse(await readFile(join(root, "package.json"), "utf8")), "package.json");

assert.match(appSource, /from "\.\/api-client\.js"/);
assert.match(appSource, /from "\.\/device-targets\.js"/);
assert.match(appSource, /from "\.\/device-panel\.js"/);
assert.match(appSource, /from "\.\/distance-key-ui\.js"/);
assert.match(appSource, /from "\.\/dom\.js"/);
assert.match(appSource, /from "\.\/focus-sound\.js"/);
assert.match(appSource, /from "\.\/format\.js"/);
assert.match(appSource, /from "\.\/hardening-panel\.js"/);
assert.doesNotMatch(appSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
assert.doesNotMatch(appSource, /function distanceKeyQrSvg|function distanceKeyQrMatrix|function qrReedSolomon/);
assert.doesNotMatch(appSource, /function createNoiseSource|async function parseResponse|function normalizeDistanceKeyScan/);
assert.doesNotMatch(appSource, /iosMdmForm|installLaunchAgent|applyHostsBlock/);
assert.match(appTsSource, /from "\.\/app-model\.js"/);
assert.match(appModelTsSource, /interface DashboardData/);
assert.match(devicePanelSource, /iosMdmForm/);
assert.match(domSource, /document\.createElement/);
assert.match(distanceKeyUiSource, /from "\.\/distance-key-qr\.js"/);
assert.match(distanceKeyUiSource, /function normalizeDistanceKeyScan/);
assert.match(focusSoundSource, /function createNoiseSource/);
assert.match(formatSource, /export function formatDuration/);
assert.match(hardeningPanelSource, /function renderHardening/);
assert.match(qrSource, /createElementNS/);
assert.match(monitorSource, /from "\.\/monitor\/policy\.js"/);
assert.match(monitorPolicySource, /function policyForSample/);

assert.doesNotMatch(serverSource, /function blockedPage|function hardeningAudit|async function runLocalScript|function sendJson/);
assert.match(serverSource, /from "\.\/server\/pages\.js"/);
assert.match(serverSource, /from "\.\/server\/http\.js"/);
assert.match(serverSource, /from "\.\/server\/localScripts\.js"/);
assert.match(serverSource, /from "\.\/server\/apiRoutes\.js"/);
assert.match(serverSource, /from "\.\/server\/extensionApi\.js"/);
assert.match(serverSource, /from "\.\/server\/policyRoutes\.js"/);
assert.match(serverSource, /from "\.\/server\/sessionRoutes\.js"/);
assert.match(serverSource, /from "\.\/server\/settingsRoutes\.js"/);
assert.match(serverSource, /from "\.\/server\/statePayload\.js"/);
assert.doesNotMatch(serverSource, /function handleExtensionCheck|function handleExtensionRulesSync/);
assert.match(extensionApiSource, /function handleExtensionCheck/);
assert.match(policyRoutesSource, /function handlePolicyApiRoute/);
assert.match(sessionRoutesSource, /function handleSessionApiRoute/);
assert.match(settingsRoutesSource, /SETTING_MUTATIONS/);
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
