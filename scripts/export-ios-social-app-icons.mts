import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { focusedSocialLauncherWebClips } from "../src/socialFeatureFilters.js";

const root = resolve(process.env.VIGIL_REPO_ROOT || process.cwd());
const outputDir = join(root, "ios", "VigilSocial", "VigilSocial", "Icons");

await mkdir(outputDir, { recursive: true });
for (const clip of focusedSocialLauncherWebClips()) {
  const path = join(outputDir, `${clip.id}.png`);
  await writeFile(path, Buffer.from(clip.iconPngBase64, "base64"));
  console.log(`Wrote ${clip.displayName} iOS app icon: ${path}`);
}
