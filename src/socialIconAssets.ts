import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FocusedSocialPlatformId } from "./types.js";

const RUNTIME_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ICON_FILES: Record<FocusedSocialPlatformId, string> = {
  instagram: "instagram.png",
  youtube: "youtube.png",
  snapchat: "snapchat.png"
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ICON_BYTES = 512 * 1024;
const encodedIcons = new Map<string, string>();

export function socialIconPngBase64(id: FocusedSocialPlatformId, runtimeRoot = RUNTIME_ROOT): string {
  const filename = ICON_FILES[id];
  if (!filename) throw new Error(`Unknown social icon: ${String(id)}`);
  const path = join(runtimeRoot, "public", "art", "social", filename);
  const cached = encodedIcons.get(path);
  if (cached) return cached;

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`Could not load the ${id} social icon at ${path}.`, { cause: error });
  }
  if (bytes.length <= PNG_SIGNATURE.length || bytes.length > MAX_ICON_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`The ${id} social icon at ${path} is not a valid packaged PNG.`);
  }

  const encoded = bytes.toString("base64");
  encodedIcons.set(path, encoded);
  return encoded;
}
