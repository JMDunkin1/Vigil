import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(dirname(dirname(runtimeRoot)), "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/search-guard.js");

export async function generatedIosSafariGuard(): Promise<string> {
  const source = await readFile(join(runtimeRoot, "extension/google-safe-search.js"), "utf8");
  // Use an extension-owned page rather than modifying the unsafe website.
  // Keep a blank-page fallback if the extension URL API is unavailable.
  const adapted = source.replaceAll('chrome.runtime.getURL("blocked.html")', 'vigilBlockedSearchURL()');
  if (adapted === source || /\b(?:import|export)\s|chrome\.runtime/u.test(adapted)) {
    throw new Error("The desktop search guard cannot be safely bundled for Safari.");
  }
  return `/* eslint-disable no-unused-vars -- Shared desktop matcher includes helpers unused by this entry point. */\n// Generated from the desktop search guard; run the generator after npm run build.\n(() => {\nfunction vigilBlockedSearchURL() {\n  try {\n    return (globalThis.browser || globalThis.chrome).runtime.getURL("blocked.html");\n  } catch { return "about:blank"; }\n}\n${adapted}\n})();\n`;
}

export async function assertGeneratedIosSafariGuardCurrent(): Promise<void> {
  if (await readFile(output, "utf8").catch(() => "") !== await generatedIosSafariGuard()) {
    throw new Error("The Safari search guard is stale. Run node dist/runtime/scripts/generate-ios-safari-guard.mjs --write after npm run build.");
  }
}

if (isDirectRun(import.meta.url)) {
  if (process.argv.includes("--write")) await writeFile(output, await generatedIosSafariGuard());
  else await assertGeneratedIosSafariGuardCurrent();
}
