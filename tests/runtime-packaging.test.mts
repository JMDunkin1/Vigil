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
import { LOCAL_MAC_BUILD_VERSION, resolveMacBuildVersion } from "../scripts/mac-build-version.mjs";
import { recordValue, stringArrayValue } from "./test-helpers.mjs";

const execFileAsync = promisify(execFile);

assert.equal(packageableRuntimePath("src/server.js"), true);
assert.equal(packageableRuntimePath("tests/policy.test.mjs"), false);
assert.equal(packageableRuntimePath("scripts/run-tests.mjs"), false);
assert.equal(packageableRuntimePath("scripts/copy-assets.mts"), false);
assert.equal(packageableRuntimePath("scripts/dev-server.mjs"), false);
assert.equal(packageableRuntimePath("scripts/ios-phone-suite.mjs"), false);
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
assert.equal(build.buildVersion, undefined, "the package manifest must not pin every release to one bundle build number");
assert.equal(LOCAL_MAC_BUILD_VERSION, "1");
assert.equal(resolveMacBuildVersion({}), "1", "credential-free local packages need a valid default");
for (const valid of ["1", "42", "9999", "1.0", "2026.7.21", "9999.99.99"]) {
  assert.equal(resolveMacBuildVersion({ VIGIL_MAC_BUILD_VERSION: valid }), valid);
}
for (const invalid of ["0", "01", "10000", "1.00", "1.100", "1.2.100", "1.2.3.4", "1a", "1-2"]) {
  assert.throws(
    () => resolveMacBuildVersion({ VIGIL_MAC_BUILD_VERSION: invalid }),
    /VIGIL_MAC_BUILD_VERSION must be/u
  );
}
assert.throws(
  () => resolveMacBuildVersion({}, { requireExplicit: true }),
  /required for a production release/u
);
assert.match(String(scripts["package:mac"]), /package-mac\.mjs dir/);
assert.match(String(scripts["package:mac:dmg"]), /package-mac\.mjs dmg/);
for (const command of ["package:mac", "package:mac:dmg", "build:mac:signed", "dist:mac:signed"]) {
  assert.match(String(scripts[command]), /prepare-mac-output\.mjs/, `${command} must package outside the synced workspace`);
  assert.match(String(scripts[command]), /hide-mac-build\.mjs/, `${command} must unregister its development app bundle`);
}
assert.doesNotMatch(String(scripts["build:mac:signed"]), /identity=null/);
assert.doesNotMatch(String(scripts["dist:mac:signed"]), /identity=null/);
for (const command of ["build:mac:signed", "dist:mac:signed"]) {
  assert.match(String(scripts[command]), /--universal/, `${command} must support both Intel and Apple silicon`);
  assert.match(String(scripts[command]), /package-mac-signed\.mjs/u, `${command} must inject a validated macOS build number`);
}
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
  "ios-phone-suite.mjs",
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
assert.equal(build.afterPack, "scripts/after-pack.mjs");
assert.equal(build.artifactName, "${productName}-${version}-${arch}.${ext}");
assert.deepEqual(build.extraResources, [
  { from: "build/PrivacyInfo.xcprivacy", to: "PrivacyInfo.xcprivacy" },
  { from: "build/browser-store.json", to: "browser-store.json" }
]);
if (process.platform === "darwin") {
  const packagedHelperPath = join(process.cwd(), "bin", "vigil-human-idle");
  const helperPath = existsSync(packagedHelperPath)
    ? packagedHelperPath
    : join(process.cwd(), "dist", "runtime", "bin", "vigil-human-idle");
  const otoolPath = [
    "/Library/Developer/CommandLineTools/usr/bin/otool",
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/otool",
    "/usr/bin/otool"
  ].find((candidate) => existsSync(candidate));
  assert.ok(otoolPath, "a macOS object-file inspector must be installed");
  const { stdout: helperLoadCommands } = await execFileAsync(otoolPath, ["-l", helperPath]);
  assert.match(helperLoadCommands, /^\s+minos\s+12\.0$/mu, "the packaged idle helper must support macOS 12.0");
  const { stdout: helperArchitectures } = await execFileAsync("/usr/bin/lipo", ["-archs", helperPath]);
  assert.deepEqual(new Set(helperArchitectures.trim().split(/\s+/u)), new Set(["x86_64", "arm64"]));
}

const manifest = recordValue(JSON.parse(await readFile("extension/manifest.json", "utf8")), "extension manifest");
assert.equal(manifest.version, REQUIRED_EXTENSION_VERSION);
const extensionIcons = recordValue(manifest.icons, "extension icons");
for (const [size, path] of Object.entries({
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
})) {
  assert.equal(extensionIcons[size], path);
  assert.ok((await stat(join(process.cwd(), "extension", path))).size > 0, `browser-store icon ${size} must be packaged`);
}
const extensionKeyHash = createHash("sha256").update(Buffer.from(String(manifest.key || ""), "base64")).digest().subarray(0, 16).toString("hex");
assert.equal(extensionKeyHash.replace(/[0-9a-f]/g, (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16))), BUILT_IN_CHROME_EXTENSION_ID);
const browserStoreRoot = existsSync(join(process.cwd(), "build", "browser-store.json")) ? process.cwd() : resolve(process.cwd(), "..", "..");
const browserStore = JSON.parse(await readFile(join(browserStoreRoot, "build", "browser-store.json"), "utf8")) as Record<string, unknown>;
assert.equal(browserStore.extensionId, BUILT_IN_CHROME_EXTENSION_ID, "the browser-store item must match Vigil's trusted extension origin");
assert.equal(typeof browserStore.published, "boolean", "browser-store publication must be an explicit release gate");
assert.equal(
  typeof browserStore.publishedVersion === "string" || browserStore.publishedVersion === null,
  true,
  "the browser-store gate must identify the exact reviewed version, or null while unpublished"
);
if (browserStore.published === true) {
  assert.equal(browserStore.publishedVersion, manifest.version, "the release gate must apply to the current extension version");
}
assert.match(String(scripts["package:extension:release"]), /package-browser-extension\.mjs --release/u, "consumer extension packaging must require the published-store gate");
assert.equal(stringArrayValue(manifest.permissions, "extension permissions").includes("declarativeNetRequest"), true);

const extensionPackager = await readFile(join(browserStoreRoot, "scripts", "package-browser-extension.mjs"), "utf8");
for (const requiredStoreAsset of ["blocked.html", "rules.json", "icons/icon-128.png"]) {
  assert.match(extensionPackager, new RegExp(`"${requiredStoreAsset.replace(".", "\\.")}"`, "u"));
}
assert.match(extensionPackager, /publishedVersion !== manifest\.version/u, "release packaging must reject a stale published-version gate");

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
