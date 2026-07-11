import { basename } from "node:path";

const EXCLUDED_RUNTIME_FILES = new Set([
  "scripts/build-ios-social-app.mjs",
  "scripts/build-ios-social-app.mts",
  "scripts/copy-assets.mjs",
  "scripts/copy-assets.mts",
  "scripts/dev-server.mjs",
  "scripts/dev-server.mts",
  "scripts/run-tests.mjs",
  "scripts/run-tests.mts",
  "scripts/test-ios-social.mjs",
  "scripts/test-ios-social.mts",
  "scripts/write-build-info.mjs",
  "scripts/write-build-info.mts"
]);

export function packageableRuntimePath(path: string): boolean {
  const normalized = path.split("\\").join("/").replace(/^\.\//u, "");
  if (!normalized) return true;
  if (normalized === "tests" || normalized.startsWith("tests/")) return false;
  if (EXCLUDED_RUNTIME_FILES.has(normalized)) return false;
  return !/ \d+(?=\.[^.]+$)/u.test(basename(normalized));
}
