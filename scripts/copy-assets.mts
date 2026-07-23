import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const ignoredSourceExtensions = new Set([".ts", ".mts"]);
const socialIconNames = ["instagram.png", "youtube.png", "snapchat.png"];

await copyProjectFile("package.json");
await copyProjectFile("app/preload.cjs");
await copyProjectFile("scripts/mac-build-version.mjs");
await copyProjectFile("scripts/mac-signing-identity.mjs");
await copyProjectFile("scripts/release-entitlements.mjs");
await copyProjectFile("scripts/ios-phone-suite.mjs");
await copyAssetDir("public");
await copyAssetDir("extension");
await makeExtensionScriptsClassic();
await copySocialIcons();

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
  const sourceDir = join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Icons");
  const destinationDir = join(runtimeRoot, "public", "art", "social");
  await mkdir(destinationDir, { recursive: true });
  await Promise.all(socialIconNames.map((name) => cp(join(sourceDir, name), join(destinationDir, name))));
}

async function makeExtensionScriptsClassic(): Promise<void> {
  // Chrome content scripts and ordinary option-page scripts are classic
  // scripts. TypeScript treats files under this ESM package as modules and
  // emits a trailing `export {};`, which Chrome rejects before Vigil can run.
  for (const name of ["background.js", "blocked.js", "content.js", "google-safe-search.js", "options.js"]) {
    const path = join(runtimeRoot, "extension", name);
    const source = await readFile(path, "utf8");
    const classic = source.replace(/\nexport \{\};?\s*$/u, "\n");
    if (classic === source) throw new Error(`Vigil extension build did not contain the expected module marker in ${name}.`);
    await writeFile(path, classic, "utf8");
  }
}
