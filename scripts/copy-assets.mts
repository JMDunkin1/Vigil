import { cp, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const ignoredSourceExtensions = new Set([".ts", ".mts"]);

await copyProjectFile("package.json");
await copyAssetDir("public");
await copyAssetDir("extension");

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
