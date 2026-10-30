import { readFile, writeFile } from "node:fs/promises";

export function validatePushEnvironment(value) {
  if (!["off", "development", "production"].includes(value)) throw new Error("Push signing must be off, development, or production");
  return value;
}

// Requested capabilities must be granted by BOTH Apple's provisioning profile
// and the actual signed app. A source plist/build flag alone proves nothing.
export function verifyPushSigning({ requested, signed, provisioned, bundleIdentifier, applicationIdentifier }) {
  validatePushEnvironment(requested);
  if (requested === "off") {
    if (signed) throw new Error("Unexpected push signing in a free build");
    return "";
  }
  if (signed !== requested || provisioned !== requested
      || typeof applicationIdentifier !== "string" || !/^[A-Z0-9]{10}\./.test(applicationIdentifier)
      || applicationIdentifier.slice(11) !== bundleIdentifier) {
    throw new Error("Apple has not granted the requested push environment for this exact app");
  }
  return requested;
}

export async function writePushEntitlements({ destination, base, environment }) {
  validatePushEnvironment(environment);
  if (environment === "off") throw new Error("Free builds must retain their original entitlements");
  const source = await readFile(base, "utf8");
  if ((!source.includes("</dict>") && !source.includes("<dict/>")) || source.includes("aps-environment")) throw new Error("Unexpected base entitlements");
  await writeFile(destination, source.replace("</dict>", `<key>aps-environment</key><string>${environment}</string></dict>`)
    .replace("<dict/>", `<dict><key>aps-environment</key><string>${environment}</string></dict>`), { mode: 0o600 });
}
