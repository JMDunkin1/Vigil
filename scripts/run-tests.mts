import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDir = join(root, "scripts", "tests");
const suites = [join(root, "scripts", "self-test.mjs")];

try {
  const entries = await readdir(testsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      suites.push(join(testsDir, entry.name));
    }
  }
} catch (error) {
  if (!isNodeErrorCode(error, "ENOENT")) throw error;
}

let failed = false;
for (const suite of suites.sort()) {
  console.log(`\n> ${relative(root, suite)}`);
  const code = await runNode(suite);
  if (code !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`\n${suites.length} test suite(s) passed.`);

function runNode(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      stdio: "inherit"
    });
    child.once("exit", (code, signal) => {
      resolve(signal ? 1 : code || 0);
    });
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
