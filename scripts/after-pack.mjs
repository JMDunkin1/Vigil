import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { localMacShellDescriptor, writeLocalMacShellMarker } from "./local-mac-shell.mjs";

const execFileAsync = promisify(execFile);
const UNUSED_PERMISSION_KEYS = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSMicrophoneUsageDescription"
];

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const infoPath = join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath]);
  const info = JSON.parse(stdout);
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new Error(`Packaged Info.plist must contain a dictionary: ${infoPath}`);
  }
  for (const key of UNUSED_PERMISSION_KEYS) {
    if (Object.hasOwn(info, key)) await execFileAsync("/usr/bin/plutil", ["-remove", key, infoPath]);
  }
  await execFileAsync("/usr/bin/plutil", [
    "-replace", "NSAppTransportSecurity.NSAllowsArbitraryLoads", "-bool", "NO", infoPath
  ]);
  await execFileAsync("/usr/bin/plutil", ["-lint", infoPath]);
  await writeLocalMacShellMarker(appPath, await localMacShellDescriptor(context.packager.projectDir));
}
