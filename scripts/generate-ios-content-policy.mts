import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPLICIT_BLOCKED_SITES,
  DEFAULT_EXPLICIT_COMIC_SITE_TERMS,
  DEFAULT_EXPLICIT_CONTEXTUAL_RULES,
  DEFAULT_EXPLICIT_SEARCH_TERMS
} from "../src/defaults.js";
import { isDirectRun } from "../src/directRun.js";
import { buildExplicitContentTextPolicy } from "../src/explicitContentPolicy.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const outputPath = join(projectRoot, "ios", "VigilSocial", "VigilSocial", "ExplicitContentPolicy.json");

export function generatedIosContentPolicy(): string {
  const policy = buildExplicitContentTextPolicy({
    blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
    comicSiteTerms: DEFAULT_EXPLICIT_COMIC_SITE_TERMS,
    contextualRules: DEFAULT_EXPLICIT_CONTEXTUAL_RULES,
    searchTerms: DEFAULT_EXPLICIT_SEARCH_TERMS
  });
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export async function assertGeneratedIosContentPolicyCurrent(): Promise<void> {
  const committed = await readFile(outputPath, "utf8").catch(() => "");
  if (committed !== generatedIosContentPolicy()) {
    throw new Error("The bundled iOS explicit-content policy is stale. Run npm run ios:content-policy:generate.");
  }
}

async function main(): Promise<void> {
  const generated = generatedIosContentPolicy();
  if (process.argv.includes("--write")) {
    await writeFile(outputPath, generated, "utf8");
    console.log(`Updated ${outputPath}`);
    return;
  }

  await assertGeneratedIosContentPolicyCurrent();
  console.log("The bundled iOS explicit-content policy matches Vigil's current rules.");
}

if (isDirectRun(import.meta.url)) await main();
