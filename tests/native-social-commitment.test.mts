import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Run the production Swift commitment engine with fake storage and a controlled
// continuous clock. This does not require a simulator or touch the real Keychain.
if (process.platform === "darwin") {
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));
  const source = await readFile(join(root, "ios/VigilSocial/VigilSocial/SocialPreferences.swift"), "utf8");
  const restrictionStart = source.indexOf("struct SocialRestriction:");
  const restrictionEnd = source.indexOf("// Times are local wall-clock", restrictionStart);
  const engineStart = source.indexOf("protocol SocialCommitmentStorage");
  assert.ok(restrictionStart >= 0 && restrictionEnd > restrictionStart && engineStart > restrictionEnd);
  const directory = await mkdtemp(join(tmpdir(), "vigil-native-social-lock-"));
  const run = promisify(execFile);
  try {
    const engine = join(directory, "Commitment.swift");
    const executable = join(directory, "regression");
    await writeFile(engine, "import Foundation\nimport Security\nimport Darwin\n"
      + source.slice(restrictionStart, restrictionEnd) + source.slice(engineStart));
    await run("xcrun", ["swiftc", "-O", "-o", executable, engine,
      join(root, "tests/fixtures/native-social-commitment.swift")], { timeout: 60_000 });
    const result = await run(executable, [], { timeout: 30_000 });
    assert.match(result.stdout, /Native commitment regressions passed/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
