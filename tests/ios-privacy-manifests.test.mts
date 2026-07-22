import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = existsSync(join(process.cwd(), "ios")) ? process.cwd() : resolve(process.cwd(), "..", "..");

async function readPlist(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  return JSON.parse(stdout);
}

const socialManifestPath = join(projectRoot, "ios", "VigilSocial", "VigilSocial", "PrivacyInfo.xcprivacy");
assert.deepEqual(await readPlist(socialManifestPath), {
  NSPrivacyAccessedAPITypes: [{
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
    NSPrivacyAccessedAPITypeReasons: ["CA92.1"]
  }],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: []
});

const browserManifestPath = join(projectRoot, "ios", "VigilBrowser", "VigilBrowser", "PrivacyInfo.xcprivacy");
assert.deepEqual(await readPlist(browserManifestPath), {
  NSPrivacyAccessedAPITypes: [{
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
    NSPrivacyAccessedAPITypeReasons: ["1C8F.1"]
  }],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: []
});

const socialProject = await readFile(join(projectRoot, "ios", "VigilSocial", "VigilSocial.xcodeproj", "project.pbxproj"), "utf8");
assert.match(socialProject, /A20000000000000000000016 \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/u);
assert.match(socialProject, /A1000000000000000000000C \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = A20000000000000000000016/u);
assert.match(socialProject, /A40000000000000000000003 \/\* Resources \*\/[^\n]+A1000000000000000000000C/u);

const browserProject = await readFile(join(projectRoot, "ios", "VigilBrowser", "VigilBrowser.xcodeproj", "project.pbxproj"), "utf8");
assert.match(browserProject, /200000000000000000000013 = \{isa = PBXFileReference; lastKnownFileType = text\.plist\.xml; path = PrivacyInfo\.xcprivacy;/u);
assert.match(browserProject, /100000000000000000000011 = \{isa = PBXBuildFile; fileRef = 200000000000000000000013;/u);
assert.match(browserProject, /100000000000000000000012 = \{isa = PBXBuildFile; fileRef = 200000000000000000000013;/u);
assert.match(browserProject, /400000000000000000000003 = \{isa = PBXResourcesBuildPhase;[^\n]+100000000000000000000011/u);
assert.match(browserProject, /400000000000000000000008 = \{isa = PBXResourcesBuildPhase;[^\n]+100000000000000000000012/u);
