import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = existsSync(join(process.cwd(), "build", "icon.icns")) ? process.cwd() : resolve(process.cwd(), "..", "..");
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
  build?: { afterPack?: unknown; mac?: { icon?: unknown } };
};
const afterPackPath = String(packageJson.build?.afterPack || "");
const afterPackSource = afterPackPath
  ? await readFile(join(repositoryRoot, afterPackPath), "utf8")
  : "";

assert.equal(packageJson.build?.mac?.icon, "build/icon.icns", "the detailed ICNS must be the packaged Mac icon");
assert.equal(afterPackPath, "scripts/after-pack.mjs", "the release metadata hardening hook must run after packaging");
assert.doesNotMatch(afterPackSource, /icon\.icns|CFBundleIcon/u, "post-pack metadata hardening must not replace the detailed icon");
assert.equal(existsSync(join(repositoryRoot, "build", "icon.icns")), true, "the authoritative detailed ICNS must exist");
assert.equal(existsSync(join(repositoryRoot, "build", "Vigil.icon", "icon.json")), false, "an adaptive alternate must not be available for packaging");
assert.equal(existsSync(join(repositoryRoot, "scripts", "compile-liquid-glass-icon.mjs")), false, "the removed adaptive compiler must not return");
