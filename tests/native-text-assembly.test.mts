import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));
const store = await readFile(join(projectRoot, "ios/VigilBrowser/VigilBrowser/BrowserStore.swift"), "utf8");
const start = store.indexOf("struct BrowserTextInspectionBuffer {");
const end = store.indexOf("private final class BrowserScriptMessageBridge", start);
assert.ok(start >= 0 && end > start);
assert.match(store, /didStartProvisionalNavigation navigation: WKNavigation\?\) \{[\s\S]*?textInspections\.reset\(\)/u);
assert.doesNotMatch(store, /didCommit navigation: WKNavigation\?\) \{[\s\S]*?textInspections\.reset\(\)/u);
assert.match(store, /textInspections\.receive\(/u);
if (process.platform === "darwin") {
  const execFileAsync = promisify(execFile);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vigil-text-assembly-"));
  try {
    const executable = join(temporaryDirectory, "regression");
    const helper = join(temporaryDirectory, "BrowserTextInspectionBuffer.swift");
    await writeFile(helper, `import Foundation\n${store.slice(start, end)}`);
    await execFileAsync("xcrun", ["swiftc", "-O", "-o", executable, helper,
      join(projectRoot, "tests/fixtures/native-text-assembly.swift")], { timeout: 60_000 });
    await execFileAsync(executable, [], { timeout: 30_000 });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
