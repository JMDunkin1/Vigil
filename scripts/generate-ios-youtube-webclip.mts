import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER,
  buildIosYouTubeWebClipExperimentProfile
} from "../src/iosYoutubeWebClip.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const defaultOutputPath = join(
  projectRoot,
  "data",
  "ios-experiments",
  "vigil-youtube-webclip-test.mobileconfig"
);

const outputPath = resolve(outputArgument(process.argv.slice(2)) || defaultOutputPath);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildIosYouTubeWebClipExperimentProfile(), {
  encoding: "utf8",
  mode: 0o600
});

console.log([
  `Wrote removable YouTube Web Clip test profile: ${outputPath}`,
  `Identifier: ${IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER}`,
  "This additive profile does not replace or weaken Vigil's iPhone enforcement profile."
].join("\n"));

function outputArgument(values: string[]): string {
  let output = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || "";
    if (value === "--out") {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error("Missing value for --out.");
      output = next;
      index += 1;
    } else if (value.startsWith("--out=")) {
      output = value.slice("--out=".length);
      if (!output) throw new Error("Missing value for --out.");
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return output;
}
