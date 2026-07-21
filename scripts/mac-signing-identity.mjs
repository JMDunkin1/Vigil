import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCAL_SIGNING_IDENTITY = "Vigil Local Code Signing";

export async function resolveMacSigningIdentity(env = process.env) {
  const configured = env.VIGIL_MAC_SIGNING_IDENTITY?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return "-";

  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    const identities = [...stdout.matchAll(/^\s*\d+\)\s+[A-F0-9]+\s+"([^"]+)"/gmu)].map((match) => match[1]);
    return identities.find((identity) => identity.startsWith("Apple Development:"))
      || identities.find((identity) => identity === LOCAL_SIGNING_IDENTITY)
      || "-";
  } catch {
    return "-";
  }
}

export function isLocallyRebuildableSignature(detail) {
  return /\bSignature=adhoc\b/u.test(detail)
    || /^Authority=Apple Development:/mu.test(detail)
    || new RegExp(`^Authority=${LOCAL_SIGNING_IDENTITY}$`, "mu").test(detail);
}

export function macSigningTimestamp(identity) {
  // Vigil's locally rebuilt apps are installed directly rather than distributed
  // after Developer ID notarization. Network timestamping every nested Electron
  // component adds most of the update time and is not needed for these local
  // Apple Development or self-issued signatures.
  return identity === LOCAL_SIGNING_IDENTITY || identity.startsWith("Apple Development:") ? "none" : undefined;
}
