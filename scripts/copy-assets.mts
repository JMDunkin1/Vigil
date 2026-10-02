import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
await copyAssetDir("public");
await copyAssetDir("extension");
await makeExtensionScriptsClassic();
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
  for (const name of ["background.js", "blocked.js", "blocked-navigation.js", "content.js", "google-safe-search.js", "options.js", "reddit-review-background.js", "reddit-review-guard.js"]) {
    const path = join(runtimeRoot, "extension", name);
    let source = await readFile(path, "utf8");
    if (source.includes('from "../src/blockedPageBack.js"')) {
      const back = (await readFile(join(runtimeRoot, "src/blockedPageBack.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*blockedPageBack\.js["'];?\s*$/mu, back);
      if (!name.startsWith("reddit-review-")) source = source.trimEnd() + "\nexport {};\n";
    }
    if (name === "background.js") {
      const embedPolicy = (await readFile(join(runtimeRoot, "src/youtubeEmbeds.js"), "utf8")).replace(/^export /gmu, "");
      source = source.replace(/^import .*youtubeEmbeds\.js["'];?\s*$/mu, embedPolicy);
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
      const matcher = (await readFile(join(runtimeRoot, "src/contextualExplicitSearch.js"), "utf8"))
        .replace(/^import .*explicitMediaContext\.js["'];?\s*$/mu, mediaContext)
        .replace(/^export /gmu, "");
      source = source.replace(/^import .*contextualExplicitSearch\.js["'];?\s*$/mu, matcher);
      source += "\nexport {};\n";
    }
    const classic = source.replace(/\nexport \{\};?\s*$/u, "\n");
    if (classic === source) throw new Error(`Vigil extension build did not contain the expected module marker in ${name}.`);
    await writeFile(path, name.startsWith("reddit-review-") ? `(() => {\n${classic}\n})();\n` : classic, "utf8");
  }
  const backgroundPath = join(runtimeRoot, "extension/background.js");
  await writeFile(backgroundPath, await readFile(join(runtimeRoot, "extension/reddit-review-background.js"), "utf8")
    + await readFile(backgroundPath, "utf8"));
}

await cp(join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/reddit-child-lock.js"), join(runtimeRoot, "extension/reddit-child-lock.js"));

const mediaGuardPath = join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js");
const mediaContext = (await readFile(join(runtimeRoot, "src/explicitMediaContext.js"), "utf8")).replace(/^export /gmu, "");
await writeFile(mediaGuardPath, (await readFile(mediaGuardPath, "utf8")).replace(
  /\/\/ BEGIN GENERATED EXPLICIT MEDIA CONTEXT[\s\S]*?\/\/ END GENERATED EXPLICIT MEDIA CONTEXT/u,
  `// BEGIN GENERATED EXPLICIT MEDIA CONTEXT\n${mediaContext}// END GENERATED EXPLICIT MEDIA CONTEXT`
));
await cp(mediaGuardPath, join(runtimeRoot, "extension/media-child-lock.js"));
