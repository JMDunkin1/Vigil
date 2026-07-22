import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyEntitlementObject } from "../scripts/release-entitlements.mjs";

const root = await sourceRoot();

const [workflow, script, mainEntitlements, childEntitlements, docs] = await Promise.all([
  readFile(join(root, ".github/workflows/release.yml"), "utf8"),
  readFile(join(root, "scripts/release-mac.mjs"), "utf8"),
  readFile(join(root, "build/mac-entitlements.plist"), "utf8"),
  readFile(join(root, "build/mac-entitlements-inherit.plist"), "utf8"),
  readFile(join(root, "RELEASING.md"), "utf8")
]);

for (const contract of [/APPLE_API_KEY_CONTENT:/u, /mktemp/u, /chmod 600/u, /trap cleanup EXIT/u, /APPLE_API_KEY="\$key_file"/u]) {
  assert.match(workflow, contract);
}
assert.match(workflow, /VIGIL_MAC_BUILD_VERSION:\s*\$\{\{ github\.run_number \}\}/u, "tag releases need a monotonic injected macOS build number");

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try { await access(join(candidate, "tsconfig.json")); return candidate; } catch { /* next layout */ }
  }
  throw new Error("Could not locate the Vigil source root.");
}
assert.match(script, /APPLE_API_KEY must point to a p8 file/u);
assert.match(script, /resolveMacBuildVersion\(process\.env, \{ requireExplicit: true \}\)/u, "production releases must reject an omitted build number");
assert.match(script, /-c\.buildVersion=\$\{buildVersion\}/u, "the validated build number must reach electron-builder");
assert.match(script, /version: process\.env\.npm_package_version,\s*buildVersion,/u, "release evidence must record the exact macOS build number");
assert.match(script, /Expected exactly one release app/u);
assert.match(script, /codesign[\s\S]*spctl[\s\S]*TeamIdentifier/u);
assert.match(script, /--universal/u, "production releases must support both Intel and Apple silicon");
assert.match(script, /verifyPublishedBrowserCompanion/u, "consumer Mac releases must require a verified published companion listing");
assert.match(script, /storeConfig\.extensionId !== extensionId[\s\S]*storeConfig\.extensionId !== builtInExtensionId[\s\S]*storeConfig\.published !== true[\s\S]*storeConfig\.publishedVersion !== manifest\.version/u, "the browser-store release gate must bind the exact published version to the manifest key and trusted runtime origin");
assert.match(script, /lipo[\s\S]*-verify_arch[\s\S]*x86_64[\s\S]*arm64/u, "every packaged Mach-O must retain both release architectures");
assert.match(script, /--entitlements[\s\S]*verifyEmittedEntitlements/u);
assert.match(script, /plutil[\s\S]*-convert[\s\S]*json/u, "release verification must parse entitlement plists");
assert.doesNotThrow(() => verifyEntitlementObject(
  { "com.apple.security.cs.allow-jit": true },
  "true fixture",
  { requireJit: true }
));
assert.throws(
  () => verifyEntitlementObject(
    { "com.apple.security.cs.allow-jit": false },
    "false fixture",
    { requireJit: true }
  ),
  /boolean true value/u,
  "an allow-jit key with a false value must not pass release verification"
);
assert.match(script, /await visit\(appRoot\)[\s\S]*entry\.isDirectory\(\)[\s\S]*isCodeBundle\(path\)[\s\S]*await visit\(path\)/u, "the entire app and every nested code bundle must be traversed");
assert.match(script, /entry\.isFile\(\) && await isMachO\(path\)/u, "release verification must inspect every Mach-O rather than relying on executable mode bits");
assert.match(script, /entry\.isSymbolicLink\(\)[\s\S]*verifySafeSymlink/u, "the traversal must inspect symlinks without following them");
assert.match(script, /Symlink escapes the app bundle[\s\S]*Unexpected executable-code symlink/u, "unsafe, escaping, and unexpected executable symlinks must be rejected");
assert.match(script, /\.app.*\.appex.*\.bundle.*\.framework.*\.plugin.*\.xpc/u, "code bundles in Resources, PlugIns, Library, and other locations must be recognized by type rather than parent path");
assert.match(workflow, /release-checksums\.json/u);
assert.match(docs, /checksum sidecar[\s\S]*not an automatic update feed/u);
for (const entitlements of [mainEntitlements, childEntitlements]) {
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/u);
  assert.doesNotMatch(entitlements, /allow-unsigned-executable-memory|disable-library-validation/u);
}
