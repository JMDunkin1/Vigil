import { createHash } from "node:crypto";

import { APP_NAME } from "./defaults.js";
import { plistData, toPlist } from "./plist.js";
import { socialIconPngBase64 } from "./socialIconAssets.js";

export const IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER =
  "tech.caseline.vigil.youtube-webclip-experiment";
export const IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PAYLOAD_IDENTIFIER =
  `${IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER}.webclip`;
export const IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_URL =
  "https://m.youtube.com/feed/subscriptions";

/**
 * Build the user-facing full-screen YouTube Web Clip. The separate native
 * helper remains installed only because iOS requires a containing app to
 * deliver Vigil's Safari content-blocker extension.
 */
export function buildIosYouTubeWebClipExperimentProfile(): string {
  const webClip = {
    URL: IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_URL,
    Label: "YouTube",
    FullScreen: true,
    IgnoreManifestScope: true,
    IsRemovable: true,
    Precomposed: true,
    Icon: plistData(socialIconPngBase64("youtube")),
    PayloadDescription: "Full-screen YouTube Web Clip protected by Vigil's Safari content blocker.",
    PayloadDisplayName: "YouTube",
    PayloadIdentifier: IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PAYLOAD_IDENTIFIER,
    PayloadType: "com.apple.webClip.managed",
    PayloadUUID: stableUuid(IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PAYLOAD_IDENTIFIER),
    PayloadVersion: 1
  };

  return toPlist({
    PayloadContent: [webClip],
    PayloadDescription: "Adds the full-screen YouTube Web Clip used with Vigil's Shorts filter.",
    PayloadDisplayName: "Vigil YouTube Web Clip",
    PayloadIdentifier: IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: false,
    PayloadType: "Configuration",
    PayloadUUID: stableUuid(IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER),
    PayloadVersion: 1
  });
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] || "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("").toUpperCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
