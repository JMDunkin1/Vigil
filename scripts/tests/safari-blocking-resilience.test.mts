import assert from "node:assert/strict";
import { canonicalFrontmostAppName, safariInterruptionScript } from "../../src/macos.js";
import { shouldAttemptBlockedBrowserRedirect } from "../../src/monitor.js";

{
  assert.equal(canonicalFrontmostAppName("Safari Web Content"), "Safari");
  assert.equal(canonicalFrontmostAppName("Safari Graphics and Media"), "Safari");
  assert.equal(canonicalFrontmostAppName("Safari", "com.apple.Safari"), "Safari");
  assert.equal(canonicalFrontmostAppName("Google Chrome Helper"), "Google Chrome Helper");
}

{
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: false, app: "Discord", url: "" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Safari", url: "https://youtube.com/watch?v=blocked" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Google Chrome", url: "https://reddit.com/" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Discord", url: "" }), false);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Safari", url: "" }), false);
}

{
  const script = safariInterruptionScript("http://127.0.0.1:8787/blocked");
  assert.match(script, /webkitExitFullscreen/);
  assert.match(script, /exitPictureInPicture/);
  assert.match(script, /window\.stop\(\)/);
  assert.match(script, /media\.pause\(\)/);
  assert.match(script, /media\.srcObject = null/);
  assert.match(script, /window\.location\.replace/);
}
