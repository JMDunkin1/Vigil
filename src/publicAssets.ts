import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PublicAssets {
  directory: string;
  fallbackDirectory?: string;
  live: boolean;
  sourceRoot?: string;
}

export function resolvePublicAssets(
  runtimeRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): PublicAssets {
  const embedded = join(runtimeRoot, "public");
  if (environment.SENTINEL_LIVE_SOURCE !== "1") return { directory: embedded, live: false };

  const sourceRoot = resolve(environment.SENTINEL_SOURCE_ROOT || "");
  if (!isSentinelSourceRoot(sourceRoot)) return { directory: embedded, live: false };
  return {
    directory: join(sourceRoot, "public"),
    fallbackDirectory: embedded,
    live: true,
    sourceRoot
  };
}

function isSentinelSourceRoot(candidate: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === "sentinel"
      && existsSync(join(candidate, "app", "main.ts"))
      && existsSync(join(candidate, "public", "index.html"));
  } catch {
    return false;
  }
}
