import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArguments } from "../scripts/build-ios-social-app.mjs";
import { SIMCTL_LIST_TIMEOUT_MS, selectIosSimulator } from "../scripts/test-ios-social.mjs";
import { FOCUSED_SOCIAL_PLATFORMS } from "../src/socialFeatureFilters.js";
import { socialIconPngBase64 } from "../src/socialIconAssets.js";

const instagram = buildArguments(["instagram", "--unsigned", "--destination", "generic/platform=iOS Simulator"]);
assert.ok(instagram.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.sentinel.instagram"));
assert.ok(instagram.includes("SENTINEL_SERVICE=instagram"));
assert.ok(instagram.includes("SOCIAL_APP_NAME=Instagram"));
assert.ok(instagram.includes("SOCIAL_ICON_NAME=instagram.png"));
assert.ok(instagram.includes("SOCIAL_URL_SCHEME=sentinel-instagram"));
assert.ok(instagram.includes("CODE_SIGNING_ALLOWED=NO"));

const snapchat = buildArguments(["--service", "snapchat"]);
assert.ok(snapchat.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.sentinel.snapchat"));
assert.ok(snapchat.includes("SENTINEL_SERVICE=snapchat"));
assert.throws(() => buildArguments(["tiktok"]), /Unknown social service/);
assert.throws(() => buildArguments(["youtube", "--config", "Debug"]), /Unknown option: --config/);
assert.throws(() => buildArguments(["--service"]), /Missing value for --service/);
assert.throws(() => buildArguments(["youtube", "--destination", "--unsigned"]), /Missing value for --destination/);

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
for (const platform of FOCUSED_SOCIAL_PLATFORMS) {
  const filename = `${platform.id}.png`;
  const canonical = await readFile(join(projectRoot, "ios", "SentinelSocial", "SentinelSocial", "Icons", filename));
  const packaged = await readFile(join(runtimeRoot, "public", "art", "social", filename));
  assert.equal(packaged.equals(canonical), true, `${platform.id} runtime icon should match its canonical Xcode asset`);
  assert.equal(Buffer.from(platform.webClip.iconPngBase64, "base64").equals(canonical), true, `${platform.id} profile icon should match its canonical Xcode asset`);
}

const invalidIconRoot = await mkdtemp(join(tmpdir(), "sentinel-social-icon-"));
try {
  const invalidIconDir = join(invalidIconRoot, "public", "art", "social");
  await mkdir(invalidIconDir, { recursive: true });
  await writeFile(join(invalidIconDir, "instagram.png"), "not a png");
  assert.throws(() => socialIconPngBase64("instagram", invalidIconRoot), /not a valid packaged PNG/);
  assert.throws(() => socialIconPngBase64("youtube", invalidIconRoot), /Could not load the youtube social icon/);
  assert.throws(() => socialIconPngBase64("unknown" as never, invalidIconRoot), /Unknown social icon/);
} finally {
  await rm(invalidIconRoot, { recursive: true, force: true });
}

assert.deepEqual(selectIosSimulator({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-25-4": [
      { name: "iPhone 16", udid: "older", isAvailable: true }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { name: "iPad Air", udid: "ipad", isAvailable: true },
      { name: "iPhone 17 Pro", udid: "newer", isAvailable: true }
    ]
  }
}), { name: "iPhone 17 Pro", udid: "newer" });
assert.equal(selectIosSimulator({ devices: {} }), null);
assert.equal(SIMCTL_LIST_TIMEOUT_MS, 120_000);
