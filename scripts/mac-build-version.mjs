export const LOCAL_MAC_BUILD_VERSION = "1";

const APPLE_BUILD_VERSION_PATTERN = /^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u;

export function resolveMacBuildVersion(env = process.env, options = {}) {
  const configured = env.VIGIL_MAC_BUILD_VERSION?.trim();
  if (!configured) {
    if (options.requireExplicit) {
      throw new Error(
        "VIGIL_MAC_BUILD_VERSION is required for a production release. Set it to a monotonically increasing Apple build version."
      );
    }
    return LOCAL_MAC_BUILD_VERSION;
  }
  if (!APPLE_BUILD_VERSION_PATTERN.test(configured)) {
    throw new Error(
      "VIGIL_MAC_BUILD_VERSION must be one to three dot-separated decimal integers: major 1-9999 and optional minor/patch 0-99 (for example 42 or 2026.7.21)."
    );
  }
  return configured;
}
