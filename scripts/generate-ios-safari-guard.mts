import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(dirname(dirname(runtimeRoot)), "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/search-guard.js");
export const redditReviewAssets = ["blocked-navigation.js", "reddit-review-background.js", "reddit-review-guard.js", "reddit-review-blocked.html", "reddit-navigation-rules.json"];
export const searchBreakAssets = ["search-break.html", "search-break-page.js"];

export async function generatedIosSafariGuard(): Promise<string> {
  const source = await readFile(join(runtimeRoot, "extension/google-safe-search.js"), "utf8");
  // The browser-independent page helper already preserves the blank-page
  // fallback. Safari must execute the same guard, with no browser-specific rewrites.
  if (!source.includes("function browserProtectionPageURL(") || /\b(?:import|export)\s|chrome\.runtime/u.test(source)) {
    throw new Error("The desktop search guard cannot be safely bundled for Safari.");
  }
  return `/* eslint-disable no-unused-vars -- Shared desktop matcher includes helpers unused by this entry point. */\n// Generated from the shared browser search guard during npm run build.\n(() => {\n${source}\n})();\n`;
}

export async function writeGeneratedIosSafariGuard(): Promise<void> {
  await writeFile(output, await generatedIosSafariGuard());
  for (const name of [...redditReviewAssets, ...searchBreakAssets]) {
    await writeFile(join(dirname(output), name), await readFile(join(runtimeRoot, "extension", name)));
  }
}

export async function assertGeneratedIosSafariGuardCurrent(): Promise<void> {
  if (await readFile(output, "utf8").catch(() => "") !== await generatedIosSafariGuard()) {
    throw new Error("The Safari search guard is stale. Run node dist/runtime/scripts/generate-ios-safari-guard.mjs --write after npm run build.");
  }
  for (const name of [...redditReviewAssets, ...searchBreakAssets]) {
    if (await readFile(join(dirname(output), name), "utf8").catch(() => "") !== await readFile(join(runtimeRoot, "extension", name), "utf8")) {
      throw new Error(`The Safari Reddit review asset ${name} is stale. Run the Safari guard generator with --write.`);
    }
  }
}

if (isDirectRun(import.meta.url)) {
  if (process.argv.includes("--write")) {
    await writeGeneratedIosSafariGuard();
  }
  else await assertGeneratedIosSafariGuardCurrent();
}
