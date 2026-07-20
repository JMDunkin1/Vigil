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

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const phoneRelease = JSON.parse(await readFile(join(projectRoot, "ios", "phone-release.json"), "utf8")) as {
  build: number;
  version: string;
};

const instagram = buildArguments(["instagram", "--unsigned", "--destination", "generic/platform=iOS Simulator"]);
assert.ok(instagram.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram"));
assert.ok(instagram.includes("VIGIL_SERVICE=instagram"));
assert.ok(instagram.includes("SOCIAL_APP_NAME=Instagram"));
assert.ok(instagram.includes("SOCIAL_ICON_NAME=instagram.png"));
assert.ok(instagram.includes("SOCIAL_URL_SCHEME=vigil-instagram"));
assert.ok(instagram.includes(`MARKETING_VERSION=${phoneRelease.version}`));
assert.ok(instagram.includes(`CURRENT_PROJECT_VERSION=${phoneRelease.build}`));
assert.ok(instagram.includes("CODE_SIGNING_ALLOWED=NO"));

const combined = buildArguments(["combined"]);
assert.ok(combined.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.social"));
assert.ok(combined.includes("VIGIL_SERVICE=combined"));
assert.ok(combined.includes("SOCIAL_APP_NAME=Vigil Social"));
assert.ok(combined.includes("SOCIAL_URL_SCHEME=vigilsocial"));

const explicitVersion = buildArguments(["youtube", "--version", "2.4.1", "--build", "37"]);
assert.ok(explicitVersion.includes("MARKETING_VERSION=2.4.1"));
assert.ok(explicitVersion.includes("CURRENT_PROJECT_VERSION=37"));

const snapchat = buildArguments(["--service", "snapchat"]);
assert.ok(snapchat.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.snapchat"));
assert.ok(snapchat.includes("VIGIL_SERVICE=snapchat"));
assert.throws(() => buildArguments(["tiktok"]), /Unknown social service/);
assert.throws(() => buildArguments(["youtube", "--config", "Debug"]), /Unknown option: --config/);
assert.throws(() => buildArguments(["--service"]), /Missing value for --service/);
assert.throws(() => buildArguments(["youtube", "--destination", "--unsigned"]), /Missing value for --destination/);

for (const platform of FOCUSED_SOCIAL_PLATFORMS) {
  const filename = `${platform.id}.png`;
  const canonical = await readFile(join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Icons", filename));
  const packaged = await readFile(join(runtimeRoot, "public", "art", "social", filename));
  assert.equal(packaged.equals(canonical), true, `${platform.id} runtime icon should match its canonical Xcode asset`);
  assert.equal(Buffer.from(platform.webClip.iconPngBase64, "base64").equals(canonical), true, `${platform.id} profile icon should match its canonical Xcode asset`);
}

const invalidIconRoot = await mkdtemp(join(tmpdir(), "vigil-social-icon-"));
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
