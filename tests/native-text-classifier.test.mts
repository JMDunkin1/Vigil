import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot
  : existsSync(join(process.cwd(), "ios")) ? process.cwd() : dirname(dirname(runtimeRoot));

// This exercises the actual native classifier, including Foundation's Unicode
// normalization, rather than a JavaScript port of its matching decisions.
if (process.platform === "darwin") {
  const execFileAsync = promisify(execFile);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vigil-text-classifier-"));
  try {
    const executable = join(temporaryDirectory, "regression");
    // Exercise actual Foundation text-policy code without requiring the image
    // analyzer framework or its production-only entitlement on the test host.
    const source = await readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/ContentSafetyClassifier.swift"), "utf8");
    const verdictStart = source.indexOf("enum ContentSafetyVerdict:");
    const verdictEnd = source.indexOf("\nenum UnclassifiedMediaPolicy:", verdictStart);
    const classifierStart = source.indexOf("struct ExplicitContentTextPolicy:");
    if (verdictStart < 0 || verdictEnd < 0 || classifierStart < 0) throw new Error("Native classifier extraction failed.");
    const foundationSource = join(temporaryDirectory, "ContentSafetyClassifier.swift");
    await writeFile(foundationSource, `import Foundation\n${source.slice(verdictStart, verdictEnd)}\nprotocol PageTextSafetyClassifying: Sendable { func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict }\n${source.slice(classifierStart)}\nfunc nativeAutomaticSearchForTesting(_ value: String) -> Bool { BroadenedExplicitMedia.containsSearch(value) }\n`);
    await execFileAsync("xcrun", [
      "swiftc", "-O", "-o", executable,
      foundationSource,
      join(projectRoot, "tests/fixtures/native-text-classifier.swift")
    ], { timeout: 60_000 });
    await execFileAsync(executable, [join(projectRoot, "ios/VigilSocial/VigilSocial/ExplicitContentPolicy.json")], { timeout: 30_000 });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
