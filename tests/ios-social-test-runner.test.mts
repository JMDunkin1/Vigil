import assert from "node:assert/strict";
import {
  developerDirectoryCandidates,
  parseIosSimulatorSdkVersion,
  selectCompatibleIosToolchain,
  selectIosSimulatorDestination
} from "../scripts/test-ios-social.mjs";

const destination = selectIosSimulatorDestination({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { name: "iPhone 17 Pro", udid: "older-pro", isAvailable: true }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { name: "iPhone Air", udid: "new-air", isAvailable: true },
      { name: "iPhone 17 Pro", udid: "unavailable", isAvailable: false },
      { name: "iPhone 17", udid: "new-standard", isAvailable: true },
      { name: "iPad Pro", udid: "ipad", isAvailable: true }
    ]
  }
});
assert.deepEqual(destination, {
  name: "iPhone 17",
  udid: "new-standard",
  runtimeVersion: "27.0"
});
assert.equal(selectIosSimulatorDestination({ devices: {} }), null);
assert.equal(selectIosSimulatorDestination({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [
      { name: "iPhone Impostor", udid: "not-ios", isAvailable: true }
    ]
  }
}), null);

assert.equal(parseIosSimulatorSdkVersion(`
  Simulator - iOS 26.5 -sdk iphonesimulator26.5
  Simulator - iOS 27.0 -sdk iphonesimulator27.0
  macOS 27.0 -sdk macosx27.0
`), "27.0");
assert.equal(parseIosSimulatorSdkVersion("macOS 27.0 -sdk macosx27.0"), "");

assert.deepEqual(developerDirectoryCandidates({
  explicitDeveloperDir: "/opt/Xcode Explicit.app/Contents/Developer/",
  selectedDeveloperDir: "/Applications/Xcode.app/Contents/Developer",
  installedDeveloperDirectories: ["/Applications/Xcode-Beta.app/Contents/Developer"]
}), ["/opt/Xcode Explicit.app/Contents/Developer"]);

assert.deepEqual(developerDirectoryCandidates({
  selectedDeveloperDir: "/Applications/Xcode.app/Contents/Developer",
  installedDeveloperDirectories: [
    "/Applications/Xcode.app/Contents/Developer/",
    "/Applications/Xcode-27.app/Contents/Developer"
  ]
}), [
  "/Applications/Xcode.app/Contents/Developer",
  "/Applications/Xcode-27.app/Contents/Developer"
]);

const toolchains = [
  {
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    iosSimulatorSdkVersion: "26.5"
  },
  {
    developerDir: "/Applications/Xcode-27-beta.app/Contents/Developer",
    iosSimulatorSdkVersion: "27.0"
  }
];

assert.deepEqual(
  selectCompatibleIosToolchain(toolchains, "27.0"),
  toolchains[1],
  "automatic selection should choose the installed Xcode compatible with the newest simulator"
);
assert.deepEqual(
  selectCompatibleIosToolchain(
    toolchains,
    "26.5",
    "/Applications/Xcode.app/Contents/Developer/"
  ),
  toolchains[0],
  "an explicit compatible DEVELOPER_DIR must take precedence over a newer installed Xcode"
);
assert.equal(
  selectCompatibleIosToolchain(
    toolchains,
    "27.0",
    "/Applications/Xcode.app/Contents/Developer"
  ),
  null,
  "an explicit incompatible DEVELOPER_DIR must fail instead of silently selecting another Xcode"
);
assert.equal(selectCompatibleIosToolchain(toolchains, "28.0"), null);
