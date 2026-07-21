import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHROME_SAFE_SEARCH_PROFILE_PATH, writeChromeSafeSearchProfile } from "../src/chromeSafeSearch.js";

const execFileAsync = promisify(execFile);

const written = await writeChromeSafeSearchProfile();
await execFileAsync("/usr/bin/plutil", ["-lint", written.path], {
  timeout: 5000,
  maxBuffer: 1024 * 64
});

console.log([
  `Chrome SafeSearch Filter profile exported: ${CHROME_SAFE_SEARCH_PROFILE_PATH}`,
  "Deploy this profile through device management.",
  "Manual installation is not accepted because a local administrator could remove it."
].join("\n"));
