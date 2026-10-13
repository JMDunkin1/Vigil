import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { matchSemanticExplicitUrl } from "../src/explicitUrlContext.js";
import { semanticExplicitUrlBlocked, semanticExplicitUrlAllowed } from "./semantic-explicit-url.test.mjs";

const cases: ReadonlyArray<readonly [string, boolean]> = [
  ...semanticExplicitUrlBlocked.map(url => [url, true] as const),
  ...semanticExplicitUrlAllowed.map(url => [url, false] as const),
  ["https://ordinary.example/porn/videos", true],
  ["https://ordinary.example/naked-girls-photos", true],
  ["https://ordinary.example/onlyfans-leaks", true],
  ["https://ordinary.example/products/sex-dolls", true],
  ["https://ordinary.example/category/色情视频", true],
  ["https://ordinary.example/PОRN/videos", true],
  ["https://ordinary.example/NАKED-GIRLS-PHOTOS", true],
  ["https://ordinary.example/ОNLYFANS/leaks", true],
  ["https://ordinary.example/порно/videos", true],
  ["https://ordinary.example/category/порнография", true],
  ["https://ordinary.example/PОRNVIDEOS", true],
  ["https://ordinary.example/порнозавр", false],
  ["https://ordinary.example/catalog/18comics", false],
  ["https://ordinary.example/catalog/18pluscomics", true],
  ["https://ordinary.example/a/b/c/d/porn/videos", false],
  ["https://ordinary.example/?token=porn-videos", false],
  ["https://ordinary.example/#porn-videos", false],
  ["https://ordinary.example/xxx-report", false],
  ["https://ordinary.example/r34/images", false],
  ["https://ordinary.example/pornography-blocker", false],
  ["https://ordinary.example/nude-watercolor-palette", false],
  ["https://ordinary.example/pornography/law/history", false],
  ["https://ordinary.example/nsfw/api/reference", false],
  ["https://ordinary.example/nude/art/sculpture/photos", false],
  ["https://ordinary.example/pornography/law/naked/photos", true],
  ["https://ordinary.example/nsfw/api/reference/hentai", true],
  ["https://ordinary.example/pornography/law/18%2B/videos", true],
  ["https://ordinary.example/pornography/law/18%2B5/videos", false],
  ["https://ordinary.example/nude/art/drawing/images", false],
  ["https://ordinary.example/nude/art/drawing/porn", true],
  ["https://ordinary.example/nudity/anatomy/images", false],
  ["https://ordinary.example/nudity/anatomy/nude/photos", true]
];
for (const [url, blocked] of cases) {
  assert.equal(Boolean(matchSemanticExplicitUrl(url)), blocked, `shared semantic expectation: ${url}`);
}

if (process.platform === "darwin") {
  const execute = promisify(execFile);
  const projectRoot = process.env.VIGIL_TEST_SOURCE_ROOT || process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "vigil-native-semantic-url-"));
  try {
    const filterPath = join(directory, "FilterRules.swift");
    const filterSource = await readFile(join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), "utf8");
    await writeFile(filterPath, `${filterSource}\nfunc nativeSemanticURLForTesting(_ url: URL) -> Bool { BroadenedExplicitMedia.containsSemanticURL(url) }\n`);
    const mainPath = join(directory, "main.swift");
    const checks = cases.map(([url, blocked]) => {
      const encoded = Buffer.from(url).toString("base64");
      return `check(String(data: Data(base64Encoded: "${encoded}")!, encoding: .utf8)!, ${blocked})`;
    }).join("\n");
    await writeFile(mainPath, `import Foundation
func check(_ raw: String, _ expected: Bool) {
    guard let url = URL(string: raw) else { preconditionFailure("Invalid regression URL: \\(raw)") }
    precondition(nativeSemanticURLForTesting(url) == expected, "Native semantic URL mismatch: \\(raw)")
}
${checks}
print("Native semantic URL precision passed.")
`);
    const executable = join(directory, "semantic-url");
    await execute("/usr/bin/xcrun", ["swiftc", "-O", filterPath, join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), mainPath, "-o", executable], { timeout: 60_000 });
    await execute(executable, [], { timeout: 30_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(`${cases.length} shared/native semantic URL controls passed.`);
