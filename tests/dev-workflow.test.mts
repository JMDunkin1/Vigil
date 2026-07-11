import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = await sourceRoot();
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const devCommand = packageJson.scripts?.dev || "";
const devSource = await readFile(join(projectRoot, "scripts", "dev.mjs"), "utf8");

assert.match(devCommand, /node --watch/);
assert.match(devCommand, /scripts\/dev\.mjs/);
assert.match(devSource, /\["run", "build"\]/, "each watched restart must rebuild source and copy assets");
assert.match(devSource, /dist\/runtime\/scripts\/dev-server\.mjs/);
assert.doesNotMatch(devCommand, /dist\/runtime\/scripts\/dev-server\.mjs$/, "watch mode must not restart stale compiled output directly");

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try {
      await access(join(candidate, "tsconfig.json"));
      return candidate;
    } catch {
      // Try the next known build layout.
    }
  }
  throw new Error("Could not locate the Vigil source root.");
}
