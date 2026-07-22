import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = existsSync(join(process.cwd(), "build", "PrivacyInfo.xcprivacy"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");

const manifestPath = join(projectRoot, "build", "PrivacyInfo.xcprivacy");
const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", manifestPath], {
  encoding: "utf8"
});

assert.deepEqual(JSON.parse(stdout), {
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
      NSPrivacyAccessedAPITypeReasons: ["C617.1"]
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
      NSPrivacyAccessedAPITypeReasons: ["35F9.1"]
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
      NSPrivacyAccessedAPITypeReasons: ["E174.1"]
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
      NSPrivacyAccessedAPITypeReasons: ["CA92.1"]
    }
  ],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: []
});
