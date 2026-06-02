import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { distanceKeyQrMatrix } from "../../public/distance-key-qr.js";

const root = process.cwd();
const appSource = await readFile(join(root, "public", "app.js"), "utf8");
const domSource = await readFile(join(root, "public", "dom.js"), "utf8");
const qrSource = await readFile(join(root, "public", "distance-key-qr.js"), "utf8");
const serverSource = await readFile(join(root, "src", "server.js"), "utf8");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

assert.match(appSource, /from "\.\/dom\.js"/);
assert.match(appSource, /from "\.\/distance-key-qr\.js"/);
assert.doesNotMatch(appSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
assert.doesNotMatch(appSource, /function distanceKeyQrSvg|function distanceKeyQrMatrix|function qrReedSolomon/);
assert.match(domSource, /document\.createElement/);
assert.match(qrSource, /createElementNS/);

assert.doesNotMatch(serverSource, /function blockedPage|function hardeningAudit|async function runLocalScript|function sendJson/);
assert.match(serverSource, /from "\.\/server\/pages\.js"/);
assert.match(serverSource, /from "\.\/server\/http\.js"/);
assert.match(serverSource, /from "\.\/server\/localScripts\.js"/);
assert.match(serverSource, /from "\.\/server\/hardeningSummary\.js"/);

assert.equal(packageJson.build.asar, true);
assert.ok(packageJson.build.asarUnpack.includes("scripts/**/*"));
assert.ok(packageJson.build.asarUnpack.includes("extension/**/*"));

const matrix = distanceKeyQrMatrix("ABCD-EFGH-1234");
assert.equal(matrix.length, 21);
assert.equal(matrix.every((row) => row.length === 21), true);
assert.equal(matrix.flat().every((value) => typeof value === "boolean"), true);
assert.throws(() => distanceKeyQrMatrix("emoji-😀"), /cannot be encoded/);
