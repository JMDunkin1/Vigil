import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { PROTECTION_PAGE_CSS } from "../src/protectionAppearance.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const ignoredSourceExtensions = new Set([".ts", ".mts"]);
const socialIcons = [
  { name: "instagram.png", source: ["Icons", "instagram.png"] },
  {
    name: "youtube.png",
    source: ["Icons", "youtube-webclip.png"]
  },
  { name: "linkedin.png", source: ["Icons", "linkedin.png"] },
  { name: "snapchat.png", source: ["Icons", "snapchat.png"] },
  ...["facebook", "x", "tiktok", "reddit"].map((id) => ({ name: `${id}.png`, source: ["Icons", `${id}.png`] }))
];

await copyProjectFile("package.json");
await copyProjectFile("app/preload.cjs");
await copyProjectFile("scripts/mac-build-version.mjs");
await copyProjectFile("scripts/mac-signing-identity.mjs");
await copyProjectFile("scripts/release-entitlements.mjs");
await copyProjectFile("scripts/ios-phone-suite.mjs");
// Generate the same stylesheet for both browser installations before packaging.
await writeFile(join(projectRoot, "extension/blocked.css"), PROTECTION_PAGE_CSS.trimStart());
await writeFile(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/blocked.css"), PROTECTION_PAGE_CSS.trimStart());
for (const size of [16, 32, 48, 128]) {
  await cp(join(projectRoot, `extension/icons/icon-${size}.png`), join(projectRoot, `ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/icons/icon-${size}.png`));
}
const legacyBrowserPath = join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js");
const brandIcon = (await readFile(join(projectRoot, "extension/icons/icon-128.png"))).toString("base64");
const diagnosticHelpers = (await readFile(join(runtimeRoot, "src/blockPageDiagnostics.js"), "utf8")).replace(/^export /gmu, "");
const legacyProtectionCss = `${PROTECTION_PAGE_CSS}\n.brand-mark { background-image: url("data:image/png;base64,${brandIcon}"); }`;
const sharedMediaContext = (await readFile(join(runtimeRoot, "src/explicitMediaContext.js"), "utf8")).replace(/^export /gmu, "")
  + "\n" + (await readFile(join(runtimeRoot, "src/searchQueryContext.js"), "utf8")).replace(/^export /gmu, "")
  + "\n" + (await readFile(join(runtimeRoot, "src/contextualExplicitSearch.js"), "utf8"))
    .replace(/^import .*\sfrom\s["'][^"']+["'];?\s*$/gmu, "").replace(/^export /gmu, "");
await writeFile(legacyBrowserPath, (await readFile(legacyBrowserPath, "utf8")).replace(
  /\/\/ BEGIN GENERATED EXPLICIT MEDIA CONTEXT[\s\S]*?\/\/ END GENERATED EXPLICIT MEDIA CONTEXT/u,
  `// BEGIN GENERATED EXPLICIT MEDIA CONTEXT\n/* eslint-disable no-unused-vars -- Shared matchers include helpers unused by this entry point. */\n${sharedMediaContext}/* eslint-enable no-unused-vars */\n// END GENERATED EXPLICIT MEDIA CONTEXT`
).replace(
  /\/\/ BEGIN GENERATED BLOCK DIAGNOSTICS[\s\S]*?\/\/ END GENERATED BLOCK DIAGNOSTICS/u,
  `// BEGIN GENERATED BLOCK DIAGNOSTICS\n${diagnosticHelpers}// END GENERATED BLOCK DIAGNOSTICS`
).replace(
  /\/\* BEGIN GENERATED PROTECTION APPEARANCE \*\/[\s\S]*?\/\* END GENERATED PROTECTION APPEARANCE \*\//u,
  `/* BEGIN GENERATED PROTECTION APPEARANCE */\n${legacyProtectionCss}\n/* END GENERATED PROTECTION APPEARANCE */`
));
await copyAssetDir("public");
await copyAssetDir("extension");
await makeExtensionScriptsClassic();
await cp(join(runtimeRoot, "extension/blocked-navigation.js"), join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/blocked-navigation.js"));
const searchBreakBackground = await readFile(join(runtimeRoot, "extension/search-break-background.js"), "utf8");
const searchBreakSafariPath = join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-background.js");
const searchBreakSafariSource = await readFile(searchBreakSafariPath, "utf8");
const searchBreakSection = `// BEGIN GENERATED SEARCH BREAK\n${searchBreakBackground}// END GENERATED SEARCH BREAK`;
await writeFile(searchBreakSafariPath, searchBreakSafariSource.includes("// BEGIN GENERATED SEARCH BREAK")
  ? searchBreakSafariSource.replace(/\/\/ BEGIN GENERATED SEARCH BREAK[\s\S]*?\/\/ END GENERATED SEARCH BREAK/u, searchBreakSection)
  : searchBreakSafariSource + "\n" + searchBreakSection + "\n");
// The same guard runs before the existing protections in native WebKit and
// Safari. The Mac Safari resource is a symlink to this iOS parity script.
const avatarGuard = (await readFile(join(runtimeRoot, "src/youtubeCommentAvatars.js"), "utf8")).replace(/^export /gmu, "");
for (const resource of [
  "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-parity.js",
  "ios/VigilBrowser/VigilSafariExtension/Resources/ContentSafety.js"
]) {
  const path = join(projectRoot, resource);
  const source = await readFile(path, "utf8");
  const marker = /\/\/ BEGIN GENERATED YOUTUBE COMMENT AVATARS[\s\S]*?\/\/ END GENERATED YOUTUBE COMMENT AVATARS/u;
  if (!marker.test(source)) throw new Error(`Missing shared comment-avatar guard marker in ${resource}.`);
  await writeFile(path, source.replace(marker,
    `// BEGIN GENERATED YOUTUBE COMMENT AVATARS\n(() => {\n${avatarGuard}\ninstallYouTubeCommentAvatarMask();\n})();\n// END GENERATED YOUTUBE COMMENT AVATARS`));
}
const embedPolicy = (await readFile(join(runtimeRoot, "src/youtubeEmbeds.js"), "utf8")).replace(/^export /gmu, "");
const safariBackgroundPath = join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-background.js");
await writeFile(safariBackgroundPath, (await readFile(safariBackgroundPath, "utf8")).replace(
  /\/\/ BEGIN GENERATED YOUTUBE EMBED POLICY[\s\S]*?\/\/ END GENERATED YOUTUBE EMBED POLICY/u,
  `// BEGIN GENERATED YOUTUBE EMBED POLICY\n${embedPolicy}// END GENERATED YOUTUBE EMBED POLICY`
));
await copySocialIcons();
await cp(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-limits.js"), join(runtimeRoot, "extension/youtube-limits.js"));
await cp(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-bridge.js"), join(runtimeRoot, "extension/youtube-bridge.js"));

async function copyProjectFile(path: string): Promise<void> {
  const from = join(projectRoot, path);
  const to = join(runtimeRoot, path);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

async function copyAssetDir(path: string): Promise<void> {
  await cp(join(projectRoot, path), join(runtimeRoot, path), {
    recursive: true,
    filter: (source) => !ignoredSourceExtensions.has(extname(source))
  });
}

async function copySocialIcons(): Promise<void> {
  const sourceDir = join(projectRoot, "ios", "VigilSocial", "VigilSocial");
  const destinationDir = join(runtimeRoot, "public", "art", "social");
  await mkdir(destinationDir, { recursive: true });
  await Promise.all(socialIcons.map(({ name, source }) => (
    cp(join(sourceDir, ...source), join(destinationDir, name))
  )));
}

async function makeExtensionScriptsClassic(): Promise<void> {
  // Chrome content scripts and ordinary option-page scripts are classic
  // scripts. TypeScript treats files under this ESM package as modules and
  // emits a trailing `export {};`, which Chrome rejects before Vigil can run.
  for (const name of ["background.js", "blocked.js", "blocked-navigation.js", "content.js", "google-safe-search.js", "options.js", "reddit-review-background.js", "reddit-review-guard.js", "search-break.js", "search-break-background.js", "search-break-page.js"]) {
    const path = join(runtimeRoot, "extension", name);
    let source = await readFile(path, "utf8");
    if (name === "search-break.js" || name === "search-break-background.js") {
      const engine = await readFile(join(runtimeRoot, "src/searchBreak.js"), "utf8");
      const searchBreak = engine.slice(engine.indexOf("export function limitedSearchWarning"), engine.indexOf("export function activeSearchBreakUntil")).replace(/^export /gmu, "");
      source = source.replace(/^import .*searchBreak\.js["'];?\s*$/mu, searchBreak);
      source += "\nexport {};\n";
    }
    if (source.includes('from "../src/blockPageDiagnostics.js"')) {
      const diagnostics = (await readFile(join(runtimeRoot, "src/blockPageDiagnostics.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*blockPageDiagnostics\.js["'];?\s*$/mu, diagnostics);
    }
    if (source.includes('from "../src/blockedPageBack.js"')) {
      const back = (await readFile(join(runtimeRoot, "src/blockedPageBack.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*blockedPageBack\.js["'];?\s*$/mu, back);
      if (!name.startsWith("reddit-review-")) source = source.trimEnd() + "\nexport {};\n";
    }
    if (name === "content.js") {
      const appearance = (await readFile(join(runtimeRoot, "src/protectionAppearance.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*protectionAppearance\.js["'];?\s*$/mu, appearance);
      source += "\nexport {};\n";
    }
    if (name === "background.js") {
      const embedPolicy = (await readFile(join(runtimeRoot, "src/youtubeEmbeds.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*youtubeEmbeds\.js["'];?\s*$/mu, embedPolicy);
      source += "\nexport {};\n";
    }
    if (name === "content.js") {
      const avatarGuard = (await readFile(join(runtimeRoot, "src/youtubeCommentAvatars.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*youtubeCommentAvatars\.js["'];?\s*$/mu, avatarGuard);
      source += "\nexport {};\n";
    }
    if (name.startsWith("reddit-review-")) {
      const matcher = (await readFile(join(runtimeRoot, "src/redditReview.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*redditReview\.js["'];?\s*$/mu, matcher);
      source += "\nexport {};\n";
    }
    if (name === "google-safe-search.js") {
      // Inline the same pure matcher used by the server into the classic
      // document-start script; no runtime import or server round-trip needed.
      const mediaContext = (await readFile(join(runtimeRoot, "src/explicitMediaContext.js"), "utf8")).replace(/^export /gmu, "");
      const searchQueryContext = (await readFile(join(runtimeRoot, "src/searchQueryContext.js"), "utf8")).replace(/^export /gmu, "");
      const matcher = (await readFile(join(runtimeRoot, "src/contextualExplicitSearch.js"), "utf8"))
        .replace(/^import .*explicitMediaContext\.js["'];?\s*$/mu, mediaContext)
        .replace(/^import .*searchQueryContext\.js["'];?\s*$/mu, searchQueryContext)
        .replace(/^export /gmu, "");
      source = source.replace(/^import .*contextualExplicitSearch\.js["'];?\s*$/mu, matcher);
      source = source.replace(/^import .*searchQueryContext\.js["'];?\s*$/mu, "");
      source = source.replace(/^import .*explicitMediaContext\.js["'];?\s*$/mu, "");
      const safeSearchContext = (await readFile(join(runtimeRoot, "src/safeSearchContext.js"), "utf8"))
        .replace(/^import .*explicitMediaContext\.js["'];?\s*$/mu, "")
        .replace(/^import .*searchQueryContext\.js["'];?\s*$/mu, "")
        .replace(/^export /gmu, "");
      source = source.replace(/^import .*safeSearchContext\.js["'];?\s*$/mu, safeSearchContext);
      source += "\nexport {};\n";
    }
    if (name === "search-break.js") source = source.replace(/^export const checkSearchBreakBeforeNavigation/mu, "const checkSearchBreakBeforeNavigation");
    if (name === "google-safe-search.js") source = source.replace(/^import .*search-break\.js["'];?\s*$/mu, "");
    const classic = source.replace(/^export \{\};?[ \t]*\r?$/gmu, "");
    if (classic === source) throw new Error(`Vigil extension build did not contain the expected module marker in ${name}.`);
    const script = classic.trimEnd() + "\n";
    new Script(script, { filename: name });
    await writeFile(path, name.startsWith("reddit-review-") || (name.startsWith("search-break") && name !== "search-break.js") ? `(() => {\n${script}\n})();\n` : script, "utf8");
  }
  const backgroundPath = join(runtimeRoot, "extension/background.js");
  await writeFile(backgroundPath, await readFile(join(runtimeRoot, "extension/reddit-review-background.js"), "utf8")
    + await readFile(join(runtimeRoot, "extension/search-break-background.js"), "utf8")
    + await readFile(backgroundPath, "utf8"));
  const searchGuardPath = join(runtimeRoot, "extension/google-safe-search.js");
  await writeFile(searchGuardPath, await readFile(join(runtimeRoot, "extension/search-break.js"), "utf8")
    + await readFile(searchGuardPath, "utf8"));
}

await cp(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/reddit-child-lock.js"), join(runtimeRoot, "extension/reddit-child-lock.js"));

const mediaGuardPath = join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js");
const mediaContext = (await readFile(join(runtimeRoot, "src/explicitMediaContext.js"), "utf8")).replace(/^export /gmu, "");
await writeFile(mediaGuardPath, (await readFile(mediaGuardPath, "utf8")).replace(
  /\/\/ BEGIN GENERATED EXPLICIT MEDIA CONTEXT[\s\S]*?\/\/ END GENERATED EXPLICIT MEDIA CONTEXT/u,
  `// BEGIN GENERATED EXPLICIT MEDIA CONTEXT\n/* eslint-disable no-unused-vars -- Shared matchers include helpers unused by this entry point. */\n${mediaContext}/* eslint-enable no-unused-vars */\n// END GENERATED EXPLICIT MEDIA CONTEXT`
));
await cp(mediaGuardPath, join(runtimeRoot, "extension/media-child-lock.js"));
