import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use the source updater so its source/generated-resource roots match a real
// update, even when this suite is executing from dist/runtime/tests.
const root = existsSync(join(process.cwd(), "scripts/ios-phone-suite.mjs")) && existsSync(join(process.cwd(), "ios"))
  ? process.cwd() : resolve(process.cwd(), "../..");
const { validYouTubeInteractionManifest, verifyBundledYouTubeInteractionExtension } = await import(pathToFileURL(join(root, "scripts/ios-phone-suite.mjs")).href);
const resources = join(root, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources");
const manifest = JSON.parse(await readFile(join(resources, "manifest.json"), "utf8"));
assert.equal(validYouTubeInteractionManifest(manifest), true);
assert.equal(validYouTubeInteractionManifest(null), false);
const mutations: Array<[string, (value: typeof manifest) => void]> = [
  ["missing review guard", value => { value.content_scripts.pop(); }],
  ["review guard misses frames", value => { value.content_scripts[4].all_frames = false; }],
  ["review guard starts too late", value => { value.content_scripts[4].run_at = "document_idle"; }],
  ["review guard runs in page world", value => { value.content_scripts[4].world = "MAIN"; }],
  ["review guard misses external search", value => { value.content_scripts[4].matches = ["https://reddit.com/*"]; }],
  ["review guard substituted", value => { value.content_scripts[4].js = ["youtube-parity.js"]; }],
  ["review background missing", value => { value.background.scripts.shift(); }],
  ["background substituted", value => { value.background = { service_worker: "youtube-background.js" }; }],
  ["blocked page unavailable", value => { value.web_accessible_resources[0].resources.pop(); }],
  ["extra permission", value => { value.permissions.push("tabs"); }],
  ["missing permission", value => { value.permissions.pop(); }],
  ["missing host permission", value => { value.host_permissions.pop(); }],
  ["manifest downgraded", value => { value.manifest_version = 2; }],
  ["original child lock removed", value => { value.content_scripts[0].js.shift(); }],
  ["original child lock delayed", value => { value.content_scripts[0].run_at = "document_end"; }],
  ["malformed script", value => { value.content_scripts[1] = null; }]
];
for (const [label, mutate] of mutations) {
  const changed = structuredClone(manifest);
  mutate(changed);
  assert.equal(validYouTubeInteractionManifest(changed), false, label);
}

if (process.platform === "darwin") {
  const fixture = await mkdtemp(join(tmpdir(), "vigil-phone-extension-validation-"));
  try {
    const app = join(fixture, "VigilSocial.app");
    const extension = join(app, "PlugIns/VigilYouTubeInteractionExtension.appex");
    await mkdir(extension, { recursive: true });
    await cp(resources, extension, { recursive: true });
    await writeFile(join(extension, "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tech.caseline.vigil.instagram.youtube-controls</string></dict></plist>');
    const { youtubeLocalEngine } = await import(pathToFileURL(join(root, "dist/runtime/scripts/youtube-build-connection.mjs")).href);
    await writeFile(join(extension, "youtube-connection.json"), JSON.stringify({ mode: "local", engine: await youtubeLocalEngine() }));
    const receipt = await verifyBundledYouTubeInteractionExtension(app, "tech.caseline.vigil.instagram");
    const reviewAssets = ["reddit-review-background.js", "reddit-review-guard.js", "reddit-review-blocked.html"];
    for (const name of reviewAssets) {
      const bytes = await readFile(join(extension, name));
      assert.deepEqual(receipt.redditReviewResources[name], {
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength
      }, `receipt fingerprints ${name}`);
    }
    for (const name of [...reviewAssets, "manifest.json", "youtube-parity.js", "youtube-background.js"]) {
      const file = join(extension, name);
      const original = await readFile(file);
      await writeFile(file, Buffer.concat([original, Buffer.from("\n/* stale resource */\n")]));
      await assert.rejects(() => verifyBundledYouTubeInteractionExtension(app, "tech.caseline.vigil.instagram"), /[Ss]tale|substituted/u, `reject changed ${name}`);
      await writeFile(file, original);
    }
    await rm(join(extension, "reddit-review-guard.js"));
    await assert.rejects(() => verifyBundledYouTubeInteractionExtension(app, "tech.caseline.vigil.instagram"), /ENOENT/u, "missing review guard is rejected");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
console.log("Phone extension manifest, Reddit review asset integrity, and receipt validation passed.");
