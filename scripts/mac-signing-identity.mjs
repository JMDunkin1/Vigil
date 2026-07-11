import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveMacSigningIdentity(env = process.env) {
  const configured = env.SENTINEL_MAC_SIGNING_IDENTITY?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return "-";

  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    const identities = [...stdout.matchAll(/^\s*\d+\)\s+[A-F0-9]+\s+"(Apple Development:[^"]+)"/gmu)];
    return identities[0]?.[1] || "-";
  } catch {
    return "-";
  }
}

export function isLocallyRebuildableSignature(detail) {
  return /\bSignature=adhoc\b/u.test(detail) || /^Authority=Apple Development:/mu.test(detail);
}
