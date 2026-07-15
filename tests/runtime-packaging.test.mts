import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { distanceKeyQrMatrix } from "../public/distance-key-qr.js";
import { launchAgentDataDirFromPlist, launchAgentDataRootsConflict } from "../src/dataPaths.js";
import { BUILT_IN_CHROME_EXTENSION_ID, REQUIRED_EXTENSION_VERSION } from "../src/defaults.js";
import { isDirectRun } from "../src/directRun.js";
import { packageableRuntimePath } from "../src/runtimePackaging.js";
import { plistStringForKey } from "../src/plist.js";
import { recordValue, stringArrayValue } from "./test-helpers.mjs";

const execFileAsync = promisify(execFile);

assert.equal(packageableRuntimePath("src/server.js"), true);
assert.equal(packageableRuntimePath("tests/policy.test.mjs"), false);
assert.equal(packageableRuntimePath("scripts/run-tests.mjs"), false);
assert.equal(packageableRuntimePath("scripts/copy-assets.mts"), false);
assert.equal(packageableRuntimePath("scripts/dev-server.mjs"), false);
assert.equal(packageableRuntimePath("scripts/write-build-info.mjs"), false);
assert.equal(packageableRuntimePath("src/server 2.js"), false);

const legacyLaunchAgentPlist = `
<dict>
  <key>WorkingDirectory</key>
  <string>/Users/test/Legacy &amp; Vigil</string>
</dict>`;
assert.deepEqual(launchAgentDataDirFromPlist(legacyLaunchAgentPlist), {
  dataDir: "/Users/test/Legacy & Vigil/data",
  source: "working-directory",
  workingDirectory: "/Users/test/Legacy & Vigil"
});
const explicitLaunchAgentPlist = `
<dict>
  <key>EnvironmentVariables</key>
  <dict><key>VIGIL_DATA_DIR</key><string>/Volumes/Vigil/state</string></dict>
  <key>WorkingDirectory</key><string>/Users/test/Legacy</string>
</dict>`;
assert.deepEqual(launchAgentDataDirFromPlist(explicitLaunchAgentPlist), {
  dataDir: "/Volumes/Vigil/state",
  source: "environment",
  workingDirectory: "/Users/test/Legacy"
});
assert.equal(plistStringForKey(explicitLaunchAgentPlist, "VIGIL_DATA_DIR"), "/Volumes/Vigil/state");
assert.equal(plistStringForKey("<dict><key>label</key><string>A &amp; B</string></dict>", "label"), "A & B");
assert.equal(plistStringForKey(explicitLaunchAgentPlist, "missing"), "");
assert.equal(launchAgentDataRootsConflict("/legacy/data", "/current/data", true, true), true);
assert.equal(launchAgentDataRootsConflict("/legacy/data", "/current/data", true, false), false);
assert.equal(launchAgentDataRootsConflict("/same/data", "/same/data", true, true), false);

const launchAgentSource = await readFile(new URL("../scripts/install-launch-agent.mjs", import.meta.url), "utf8");
assert.doesNotMatch(launchAgentSource, /VIGIL_LIVE_SOURCE/u);
assert.doesNotMatch(launchAgentSource, /VIGIL_SOURCE_ROOT/u);
assert.match(launchAgentSource, /basename\(runtimeRoot\) === "runtime"/u);
assert.match(launchAgentSource, /installRuntime\(runtimeRoot, installedRuntimeRoot\)/u);
assert.match(launchAgentSource, /reinstallingFromInstalledRuntime = source === destination/u);
assert.ok(
  launchAgentSource.indexOf("await cp(reinstallingFromInstalledRuntime")
    < launchAgentSource.indexOf("await rename(destination, previousPath)"),
  "the installer must finish staging before moving a runtime that may be its own source"
);
assert.match(launchAgentSource, /runnerPath = join\(installedRuntimeRoot, "scripts", "agent-runner\.mjs"\)/u);
assert.match(launchAgentSource, /<key>VigilSourceRoot<\/key>/u);
assert.match(launchAgentSource, /legacyWorkingDirectory/u);
assert.match(launchAgentSource, /pkg\.name === "vigil"/u);
assert.match(launchAgentSource, /restoreLaunchAgentPlist\(previousPlist\)/u);
assert.match(launchAgentSource, /<key>WorkingDirectory<\/key>\s*\n\s*<string>\$\{escapeXml\(installedRuntimeRoot\)\}<\/string>/u);
assert.ok(
  launchAgentSource.indexOf('runLaunchctl(["enable"') < launchAgentSource.indexOf('runLaunchctl(["bootstrap"'),
  "the agent must be enabled before bootstrap so a previously disabled service can load"
);

const directRunDir = await mkdtemp(join(tmpdir(), "vigil-direct-run-"));
try {
  const realPath = join(directRunDir, "server.js");
  const linkedPath = join(directRunDir, "server-link.js");
  await writeFile(realPath, "");
  await symlink(realPath, linkedPath);
  assert.equal(isDirectRun(pathToFileURL(realPath).href, linkedPath), true);
} finally {
  await rm(directRunDir, { recursive: true, force: true });
}

const buildMigrationDir = await mkdtemp(join(tmpdir(), "vigil-build-migration-"));
try {
  await mkdir(join(buildMigrationDir, "dist", "mac", "Vigil.app"), { recursive: true });
  await mkdir(join(buildMigrationDir, "dist.nosync", "runtime"), { recursive: true });
  await writeFile(join(buildMigrationDir, "dist", "mac", "Vigil.app", "executable"), "preserved");
  await writeFile(join(buildMigrationDir, "dist.nosync", "runtime", "existing"), "preserved");
  const sourceRoot = existsSync(join(process.cwd(), "scripts", "prepare-build-dir.mjs"))
    ? process.cwd()
    : resolve(process.cwd(), "..", "..");
  const prepareModuleUrl = `${pathToFileURL(join(sourceRoot, "scripts", "prepare-build-dir.mjs")).href}?test=${Date.now()}`;
  const prepareModule = await import(prepareModuleUrl) as { prepareBuildDirectory(root: string): Promise<void> };
  await prepareModule.prepareBuildDirectory(buildMigrationDir);
  assert.equal(await readlink(join(buildMigrationDir, "dist")), "dist.nosync");
  assert.equal(existsSync(join(buildMigrationDir, "dist.nosync", ".metadata_never_index")), true);
  assert.equal(await readFile(join(buildMigrationDir, "dist", "mac", "Vigil.app", "executable"), "utf8"), "preserved");
  assert.equal(await readFile(join(buildMigrationDir, "dist", "runtime", "existing"), "utf8"), "preserved");
} finally {
  await rm(buildMigrationDir, { recursive: true, force: true });
}

const packageJson = recordValue(JSON.parse(await readFile("package.json", "utf8")), "package.json");
assert.equal(recordValue(packageJson.engines, "package engines").node, ">=22.6");
const build = recordValue(packageJson.build, "package build");
const scripts = recordValue(packageJson.scripts, "package scripts");
const macBuild = recordValue(build.mac, "mac build");
const macInfo = recordValue(macBuild.extendInfo, "mac build info");
const buildDirectories = recordValue(build.directories, "package build directories");
assert.equal(buildDirectories.output, "dist/mac.noindex");
assert.match(String(scripts["package:mac"]), /package-mac\.mjs dir/);
assert.match(String(scripts["package:mac:dmg"]), /package-mac\.mjs dmg/);
for (const command of ["package:mac", "package:mac:dmg", "build:mac:signed", "dist:mac:signed"]) {
  assert.match(String(scripts[command]), /prepare-mac-output\.mjs/, `${command} must package outside the synced workspace`);
  assert.match(String(scripts[command]), /hide-mac-build\.mjs/, `${command} must unregister its development app bundle`);
}
assert.doesNotMatch(String(scripts["build:mac:signed"]), /identity=null/);
assert.doesNotMatch(String(scripts["dist:mac:signed"]), /identity=null/);
assert.equal(macBuild.sign, "scripts/sign-mac.mjs");
assert.equal(macInfo.LSUIElement, true);
assert.ok(Array.isArray(build.files), "package files should be an array");
const runtimeFileSet = recordValue(build.files[0], "runtime package file set");
assert.equal(runtimeFileSet.from, "dist.nosync/runtime");
assert.equal(runtimeFileSet.to, "dist/runtime");
const runtimeFilter = stringArrayValue(runtimeFileSet.filter, "runtime package filter");
assert.ok(runtimeFilter.includes("**/*"));
assert.ok(runtimeFilter.includes("!tests/**/*"));
for (const excludedScript of [
  "build-ios-social-app.mjs",
  "copy-assets.mjs",
  "dev-server.mjs",
  "run-tests.mjs",
  "test-ios-social.mjs",
  "write-build-info.mjs"
]) {
  assert.ok(runtimeFilter.includes(`!scripts/${excludedScript}`));
}
assert.ok(runtimeFilter.includes("!**/* [0-9]*"));
const asarUnpack = stringArrayValue(build.asarUnpack, "asar unpack patterns");
for (const expected of [
  "dist.nosync/runtime/build-info.json",
  "dist.nosync/runtime/package.json",
  "dist.nosync/runtime/public/**/*",
  "dist.nosync/runtime/src/**/*",
  "dist.nosync/runtime/scripts/**/*",
  "dist.nosync/runtime/extension/**/*"
]) {
  assert.ok(asarUnpack.includes(expected), `${expected} should remain available outside app.asar`);
}
if (process.platform === "darwin") {
  const packagedHelperPath = join(process.cwd(), "bin", "vigil-human-idle");
  const helperPath = existsSync(packagedHelperPath)
    ? packagedHelperPath
    : join(process.cwd(), "dist", "runtime", "bin", "vigil-human-idle");
  const { stdout: helperLoadCommands } = await execFileAsync("/usr/bin/otool", ["-l", helperPath]);
  assert.match(helperLoadCommands, /^\s+minos\s+12\.0$/mu, "the packaged idle helper must support macOS 12.0");
}

const manifest = recordValue(JSON.parse(await readFile("extension/manifest.json", "utf8")), "extension manifest");
assert.equal(manifest.version, REQUIRED_EXTENSION_VERSION);
const extensionKeyHash = createHash("sha256").update(Buffer.from(String(manifest.key || ""), "base64")).digest().subarray(0, 16).toString("hex");
assert.equal(extensionKeyHash.replace(/[0-9a-f]/g, (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16))), BUILT_IN_CHROME_EXTENSION_ID);
assert.equal(stringArrayValue(manifest.permissions, "extension permissions").includes("declarativeNetRequest"), true);

for (const path of [
  "public/audio/nature/rain.ogg",
  "public/audio/nature/ocean-waves.ogg",
  "public/audio/baroque/bach-goldberg-aria-harpsichord.ogg"
]) {
  assert.ok((await stat(join(process.cwd(), path))).size > 100_000, `${path} should be a real audio asset`);
}

const matrix = distanceKeyQrMatrix("ABCD-EFGH-1234");
assert.equal(matrix.length, 21);
assert.equal(matrix.every((row) => row.length === 21), true);
assert.equal(matrix.flat().every((value) => typeof value === "boolean"), true);
assert.throws(() => distanceKeyQrMatrix("emoji-😀"), /cannot be encoded/);
