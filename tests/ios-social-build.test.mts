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
const socialWebViewStoreSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "SocialWebViewStore.swift"),
  "utf8"
);
const socialRootViewSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "RootView.swift"),
  "utf8"
);
const socialProjectSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial.xcodeproj", "project.pbxproj"),
  "utf8"
);
const socialInfoPlistSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Info.plist"),
  "utf8"
);

assert.doesNotMatch(
  socialWebViewStoreSource,
  /UIApplication\.shared\.open/u,
  "fixed social companions must cancel navigation outside their allowlisted service instead of handing an unrestricted URL to Safari"
);
assert.match(
  socialRootViewSource,
  /\.preferredColorScheme\(reportedIsDark\.map \{ \$0 \? \.dark : \.light \}\)/u,
  "reported page appearance must drive host/status-bar contrast"
);
assert.match(
  socialRootViewSource,
  /webView\.overrideUserInterfaceStyle = isDark \? \.dark : \.light/u,
  "reported page appearance must drive the embedded web view interface style"
);

const instagram = buildArguments(["instagram", "--unsigned", "--destination", "generic/platform=iOS Simulator"]);
assert.ok(instagram.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram"));
assert.ok(instagram.includes("VIGIL_SERVICE=instagram"));
assert.ok(instagram.includes("SOCIAL_APP_NAME=Instagram"));
assert.ok(instagram.includes("SOCIAL_APP_ICON_SET=InstagramAppIcon"));
assert.ok(instagram.includes("SOCIAL_URL_SCHEME=vigil-instagram"));
assert.ok(instagram.includes("VIGIL_UNCLASSIFIED_MEDIA_POLICY=conceal"));
assert.ok(instagram.includes(`MARKETING_VERSION=${phoneRelease.version}`));
assert.ok(instagram.includes(`CURRENT_PROJECT_VERSION=${phoneRelease.build}`));
assert.ok(instagram.includes("CODE_SIGNING_ALLOWED=NO"));

const explicitVersion = buildArguments(["youtube", "--version", "2.4.1", "--build", "37"]);
assert.ok(explicitVersion.includes("PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.youtube"));
assert.ok(explicitVersion.includes("VIGIL_SERVICE=youtube"));
assert.ok(explicitVersion.includes("SOCIAL_APP_NAME=YouTube"));
assert.ok(explicitVersion.includes("SOCIAL_APP_ICON_SET=YouTubeAppIcon"));
assert.ok(explicitVersion.includes("SOCIAL_URL_SCHEME=vigil-youtube"));
assert.ok(explicitVersion.includes("MARKETING_VERSION=2.4.1"));
assert.ok(explicitVersion.includes("CURRENT_PROJECT_VERSION=37"));

const personalTeamFallback = buildArguments(["youtube", "--unclassified-media-policy", "reveal-unclassified"]);
assert.ok(personalTeamFallback.includes("VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified"));

assert.throws(() => buildArguments(["combined"]), /Unknown social service/);
assert.throws(() => buildArguments(["snapchat"]), /Unknown social service/);
assert.throws(() => buildArguments(["tiktok"]), /Unknown social service/);
assert.throws(() => buildArguments(["youtube", "--config", "Debug"]), /Unknown option: --config/);
assert.throws(() => buildArguments(["--service"]), /Missing value for --service/);
assert.throws(() => buildArguments(["youtube", "--destination", "--unsigned"]), /Missing value for --destination/);
assert.throws(
  () => buildArguments(["youtube", "--unclassified-media-policy", "allow"]),
  /Unknown unclassified media policy/
);

assert.match(
  socialProjectSource,
  /ASSETCATALOG_COMPILER_APPICON_NAME = "\$\(SOCIAL_APP_ICON_SET\)";/u,
  "the Xcode target must compile the service-selected app icon set"
);
assert.match(
  socialProjectSource,
  /Assets\.xcassets in Resources/u,
  "the social app asset catalog must be included in the resources build phase"
);
assert.doesNotMatch(
  socialInfoPlistSource,
  /CFBundleIcon(?:Files|Name)|SOCIAL_ICON_NAME/u,
  "the legacy plist PNG declaration must not override the compiled app icon catalog"
);

for (const [service, iconSet] of [
  ["instagram", "InstagramAppIcon"],
  ["youtube", "YouTubeAppIcon"]
] as const) {
  const contents = JSON.parse(await readFile(
    join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Assets.xcassets", `${iconSet}.appiconset`, "Contents.json"),
    "utf8"
  )) as {
    images: Array<{
      appearances?: Array<{ appearance: string; value: string }>;
      filename: string;
      idiom: string;
      platform: string;
      size: string;
    }>;
  };
  assert.deepEqual(
    contents.images.map((image) => ({
      appearance: image.appearances?.[0]?.value || "light",
      filename: image.filename,
      idiom: image.idiom,
      platform: image.platform,
      size: image.size
    })),
    [
      { appearance: "light", filename: `${service}-light.png`, idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearance: "dark", filename: `${service}-dark.png`, idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearance: "tinted", filename: `${service}-tinted.png`, idiom: "universal", platform: "ios", size: "1024x1024" }
    ],
    `${service} must provide light, dark, and tinted iOS app icons`
  );
}

for (const platform of FOCUSED_SOCIAL_PLATFORMS) {
  if (platform.id !== "instagram" && platform.id !== "youtube") continue;
  const filename = `${platform.id}.png`;
  const canonical = await readFile(join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Icons", filename));
  const packaged = await readFile(join(runtimeRoot, "public", "art", "social", filename));
  assert.equal(packaged.equals(canonical), true, `${platform.id} runtime icon should match its canonical Xcode asset`);
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
