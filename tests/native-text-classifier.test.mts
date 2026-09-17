import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));

// This exercises the actual native classifier, including Foundation's Unicode
// normalization, rather than a JavaScript port of its matching decisions.
if (process.platform === "darwin") {
  const execFileAsync = promisify(execFile);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vigil-text-classifier-"));
  try {
    const executable = join(temporaryDirectory, "regression");
    await execFileAsync("xcrun", [
      "swiftc", "-O", "-o", executable,
      join(projectRoot, "ios/VigilSocial/VigilSocial/ContentSafetyClassifier.swift"),
      join(projectRoot, "tests/fixtures/native-text-classifier.swift")
    ], { timeout: 60_000 });
    await execFileAsync(executable, [join(projectRoot, "ios/VigilSocial/VigilSocial/ExplicitContentPolicy.json")], { timeout: 30_000 });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
