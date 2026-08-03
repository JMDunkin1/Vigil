import assert from "node:assert/strict";

import {
  IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PAYLOAD_IDENTIFIER,
  IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER,
  IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_URL,
  buildIosYouTubeWebClipExperimentProfile
} from "../src/iosYoutubeWebClip.js";
import { isPlistData, parsePlist } from "../src/plist.js";

const parsed = recordValue(parsePlist(buildIosYouTubeWebClipExperimentProfile()), "profile");
assert.equal(parsed.PayloadIdentifier, IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PROFILE_IDENTIFIER);
assert.equal(parsed.PayloadRemovalDisallowed, false);

const payloads = arrayValue(parsed.PayloadContent, "PayloadContent");
assert.equal(payloads.length, 1, "the experiment must remain additive and contain only its Web Clip");
const webClip = recordValue(payloads[0], "Web Clip");
assert.equal(webClip.PayloadType, "com.apple.webClip.managed");
assert.equal(webClip.PayloadIdentifier, IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_PAYLOAD_IDENTIFIER);
assert.equal(webClip.URL, IOS_YOUTUBE_WEB_CLIP_EXPERIMENT_URL);
assert.equal(webClip.Label, "YouTube Clean Test");
assert.equal(webClip.FullScreen, true);
assert.equal(webClip.IgnoreManifestScope, true, "Google sign-in must not escape into visible Safari chrome solely because it changes origin");
assert.equal(webClip.IsRemovable, true, "the unproven experiment must be easy to remove");
assert.equal(webClip.Precomposed, true);
assert.equal("TargetApplicationBundleIdentifier" in webClip, false, "the Web Clip must not reopen the existing companion's Safari view");
assert.equal(isPlistData(webClip.Icon), true);

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}
