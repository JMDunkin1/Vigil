import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCAL_SIGNING_IDENTITY = "Vigil Local Code Signing";

export async function resolveMacSigningIdentity(env = process.env, preferredIdentity = "") {
  const configured = env.VIGIL_MAC_SIGNING_IDENTITY?.trim();
  const preferred = String(preferredIdentity || "").trim();
  if (configured && preferred && configured !== preferred) {
    throw new Error(
      `Vigil refused to replace the installed signing identity ${preferred} with configured identity ${configured}.`
    );
  }
  if (process.platform !== "darwin") return "-";

  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    const identities = [...stdout.matchAll(/^\s*\d+\)\s+[A-F0-9]+\s+"([^"]+)"/gmu)].map((match) => match[1]);
    if (preferred) return selectMacSigningIdentity(identities, preferred);
    if (configured) return configured;
    return selectMacSigningIdentity(identities);
  } catch (error) {
    if (preferred) throw error;
    if (configured) return configured;
    return "-";
  }
}

export function selectMacSigningIdentity(identities, preferredIdentity = "") {
  const available = identities.map((identity) => String(identity || "").trim()).filter(Boolean);
  const preferred = String(preferredIdentity || "").trim();
  if (preferred) {
    if (preferred === "-" || available.includes(preferred)) return preferred;
    throw new Error(
      `The installed Vigil app uses ${preferred}, but that signing identity is not available in the login keychain.`
    );
  }
  return available.find((identity) => identity.startsWith("Apple Development:"))
    || available.find((identity) => identity === LOCAL_SIGNING_IDENTITY)
    || "-";
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
