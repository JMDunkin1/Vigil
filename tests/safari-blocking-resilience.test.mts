import assert from "node:assert/strict";
import { canonicalFrontmostAppName, safariInterruptionScript, safariRedirectScript } from "../src/macos.js";
import { shouldAttemptBlockedBrowserRedirect } from "../src/monitor.js";

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
  assert.match(script, /^\(\(\) => \{/);
  assert.match(script, /webkitExitFullscreen/);
  assert.match(script, /exitPictureInPicture/);
  assert.match(script, /window\.stop\(\)/);
  assert.match(script, /media-fullscreen/);
  assert.match(script, /picture-in-picture/);
  assert.match(script, /active-media/);
  assert.match(script, /item\.pause\(\)/);
  assert.match(script, /item\.srcObject = null/);
  assert.match(script, /window\.location\.replace/);
  assert.match(script, /return status\.length/);
}

{
  const script = safariRedirectScript("http://127.0.0.1:8787/blocked", { currentUrl: "https://youtube.com/watch?v=blocked" });
  const fullscreenGate = script.indexOf("if mediaMode contains \"media-fullscreen\" or mediaMode contains \"picture-in-picture\" then");
  const firstEscapeKey = script.indexOf("key code 53");
  assert.ok(fullscreenGate > 0, "Safari fullscreen escape should be conditional");
  assert.ok(firstEscapeKey > fullscreenGate, "Safari fullscreen escape should not run before media fullscreen is detected");
  assert.doesNotMatch(script, /Exit Full Screen/);
  assert.match(script, /set previousUrl to "https:\/\/youtube\.com\/watch\?v=blocked"/);
  assert.match(script, /repeat with safariTab in tabs of safariWindow/);
  assert.match(script, /if URL of safariTab is previousUrl then/);
}
