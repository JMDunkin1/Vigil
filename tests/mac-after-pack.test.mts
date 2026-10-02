import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

interface PackContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string }; projectDir: string };
}

const sourceRoot = existsSync(join(process.cwd(), "scripts", "after-pack.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const { default: afterPack } = await import(pathToFileURL(join(sourceRoot, "scripts", "after-pack.mjs")).href) as {
  default(context: PackContext): Promise<void>;
};
const execFileAsync = promisify(execFile);
const permissionKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSMicrophoneUsageDescription"
];
const fixtureRoot = await mkdtemp(join(tmpdir(), "vigil-after-pack-"));
const preservedInfo = {
  CFBundleIdentifier: "tech.caseline.vigil.fixture",
  CFBundleIconFile: "icon.icns",
  NSCameraUsageDescription: "Scan a distance-key QR code.",
  NSAppleEventsUsageDescription: "Enable chosen protections.",
  FixtureMetadata: { NSMicrophoneUsageDescription: "Keep this unrelated nested value.", values: [1, "two", false] },
  NSAppTransportSecurity: {
    NSAllowsArbitraryLoads: true,
    NSExceptionDomains: { "fixture.example": { NSIncludesSubdomains: true } }
  }
};
const expectedInfo = {
  ...preservedInfo,
  NSAppTransportSecurity: { ...preservedInfo.NSAppTransportSecurity, NSAllowsArbitraryLoads: false }
};

try {
  await afterPack({
    electronPlatformName: "linux",
    appOutDir: join(fixtureRoot, "non-mac-no-op"),
    packager: { appInfo: { productFilename: "Fixture" }, projectDir: sourceRoot }
  });

  for (const [name, keys] of [
    ["absent", []],
    ["present", permissionKeys],
    ["mixed", permissionKeys.slice(1, 3)]
  ] as const) {
    const fixture = await createFixture(name);
    await writeJsonPlist(fixture.infoPath, {
      ...preservedInfo,
      ...Object.fromEntries(keys.map((key) => [key, "Unused permission."]))
    });
    await afterPack(fixture.context);
    assert.deepEqual(await readJsonPlist(fixture.infoPath), expectedInfo, `${name}: harden only intended metadata`);
    const marker = JSON.parse(await readFile(fixture.markerPath, "utf8")) as { schema: number; fingerprint: string };
    assert.equal(marker.schema, 1, "successful packaging must retain the local shell marker");
    assert.match(marker.fingerprint, /^[a-f0-9]{64}$/u);
    await afterPack(fixture.context);
    assert.deepEqual(await readJsonPlist(fixture.infoPath), expectedInfo, `${name}: cleanup must be repeatable`);
    assert.deepEqual(JSON.parse(await readFile(fixture.markerPath, "utf8")), marker);
  }

  for (const [name, content] of [
    ["malformed", "<plist><dict><key>broken</key><string>unclosed</dict></plist>"],
    ["array-root", "<plist version=\"1.0\"><array><string>invalid schema</string></array></plist>"],
    ["string-root", "<plist version=\"1.0\"><string>invalid schema</string></plist>"]
  ]) {
    const fixture = await createFixture(name);
    await writeFile(fixture.infoPath, content);
    await assert.rejects(afterPack(fixture.context), `${name}: invalid plist must fail packaging`);
    assert.equal(await readFile(fixture.infoPath, "utf8"), content, "invalid input must remain unchanged");
    assert.equal(existsSync(fixture.markerPath), false, "failed packaging must not receive a shell marker");
  }

  const missing = await createFixture("missing");
  await assert.rejects(afterPack(missing.context), "missing Info.plist must fail packaging");
  assert.equal(existsSync(missing.markerPath), false);

  const readOnly = await createFixture("read-only");
  await writeJsonPlist(readOnly.infoPath, { ...preservedInfo, NSMicrophoneUsageDescription: "Unused permission." });
  const original = await readFile(readOnly.infoPath);
  await chmod(readOnly.infoPath, 0o444);
  await chmod(join(readOnly.appPath, "Contents"), 0o555);
  try {
    await assert.rejects(
      afterPack(readOnly.context),
      (error: unknown) => error instanceof Error && "cmd" in error
        && String(error.cmd).includes("-remove NSMicrophoneUsageDescription"),
      "an actual permission-removal write failure must propagate immediately"
    );
    assert.deepEqual(await readFile(readOnly.infoPath), original);
    assert.equal(existsSync(readOnly.markerPath), false);
  } finally {
    await chmod(join(readOnly.appPath, "Contents"), 0o755);
    await chmod(readOnly.infoPath, 0o644);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function createFixture(name: string): Promise<{
  context: PackContext; appPath: string; infoPath: string; markerPath: string;
}> {
  const appOutDir = join(fixtureRoot, name);
  const appPath = join(appOutDir, "Fixture.app");
  await mkdir(join(appPath, "Contents", "Resources"), { recursive: true });
  return {
    context: {
      electronPlatformName: "darwin",
      appOutDir,
      packager: { appInfo: { productFilename: "Fixture" }, projectDir: sourceRoot }
    },
    appPath,
    infoPath: join(appPath, "Contents", "Info.plist"),
    markerPath: join(appPath, "Contents", "Resources", "vigil-local-shell.json")
  };
}

async function writeJsonPlist(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
  await execFileAsync("/usr/bin/plutil", ["-convert", "xml1", path]);
}

async function readJsonPlist(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  return JSON.parse(stdout) as unknown;
}
