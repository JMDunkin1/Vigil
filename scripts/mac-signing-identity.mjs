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
  // This self-issued identity is only used for stable local macOS permissions.
  // Asking Apple's timestamp service to timestamp it can reject otherwise
  // valid builds when bundled resource mtimes are a few minutes ahead.
  return identity === LOCAL_SIGNING_IDENTITY ? "none" : undefined;
}
