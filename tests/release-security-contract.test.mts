import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try { await access(join(candidate, "tsconfig.json")); return candidate; } catch { /* next layout */ }
  }
  throw new Error("Could not locate the Vigil source root.");
}
assert.match(script, /APPLE_API_KEY must point to a p8 file/u);
assert.match(script, /Expected exactly one release app/u);
assert.match(script, /codesign[\s\S]*spctl[\s\S]*TeamIdentifier/u);
assert.match(script, /--entitlements[\s\S]*verifyEmittedEntitlements/u);
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
