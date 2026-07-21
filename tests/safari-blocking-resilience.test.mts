import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  canonicalFrontmostAppName,
  chromiumInterruptionScript,
  chromiumRedirectScript,
  isChromiumBrowser,
  isSafariBrowser,
  parseBrowserRedirectCount,
  safariInterruptionScript,
  safariRedirectScript
} from "../src/macos.js";
import { shouldAttemptBlockedBrowserRedirect } from "../src/monitor.js";

{
  assert.equal(canonicalFrontmostAppName("Safari Web Content"), "Safari");
  assert.equal(canonicalFrontmostAppName("Safari Graphics and Media"), "Safari");
  assert.equal(canonicalFrontmostAppName("Safari", "com.apple.Safari"), "Safari");
  assert.equal(canonicalFrontmostAppName("Safari Technology Preview", "com.apple.SafariTechnologyPreview"), "Safari Technology Preview");
  assert.equal(canonicalFrontmostAppName("Safari Technology Preview Web Content"), "Safari Technology Preview");
  assert.equal(canonicalFrontmostAppName("Safari Technology Preview Graphics and Media"), "Safari Technology Preview");
  assert.equal(canonicalFrontmostAppName("Google Chrome Helper"), "Google Chrome Helper");
}

{
  assert.equal(isSafariBrowser("Safari"), true);
  assert.equal(isSafariBrowser("Safari Technology Preview"), true);
  assert.equal(isSafariBrowser("Google Chrome"), false);

  const chromiumNames = [
    "Google Chrome",
    "Google Chrome Beta",
    "Google Chrome Dev",
    "Google Chrome Canary",
    "Microsoft Edge",
    "Microsoft Edge Beta",
    "Microsoft Edge Dev",
    "Microsoft Edge Canary",
    "Brave Browser",
    "Brave Browser Beta",
    "Brave Browser Nightly",
    "Arc",
    "Vivaldi",
    "Vivaldi Snapshot",
    "Opera",
    "Opera Beta",
    "Opera Developer",
    "Orion"
  ];
  for (const name of chromiumNames) assert.equal(isChromiumBrowser(name), true, `${name} must use Chromium URL controls`);
  assert.equal(isChromiumBrowser("Safari"), false);
}

{
  assert.equal(parseBrowserRedirectCount("1"), 1);
  assert.equal(parseBrowserRedirectCount("javascript-replace:standard:2"), 2);
  assert.equal(parseBrowserRedirectCount("pending:unknown:0"), 0);
  assert.equal(parseBrowserRedirectCount("pending:unknown:not-a-count"), null);
}

{
  const target = "http://127.0.0.1:8787/blocked";
  const observed = "https://example.com/blocked";
  const inPage = chromiumInterruptionScript(target, { currentUrl: observed });
  assert.match(inPage, /const expectedUrl = "https:\/\/example\.com\/blocked"/);
  assert.match(inPage, /if \(!expectedUrl \|\| window\.location\.href !== expectedUrl\) return 'url-mismatch'/);
  assert.match(inPage, /window\.location\.replace\(targetUrl\)[\s\S]*return 'redirected'/);
  assert.ok(inPage.indexOf("url-mismatch") < inPage.indexOf("window.stop()"),
    "Chromium must compare-and-replace inside the observed document before interrupting it");
  const chromiumReplacements: string[] = [];
  const chromiumResult = runInNewContext(inPage, {
    window: {
      location: {
        href: observed,
        replace: (next: string) => chromiumReplacements.push(next)
      },
      stop: () => undefined
    }
  });
  assert.equal(chromiumResult, "redirected");
  assert.deepEqual(chromiumReplacements, [target]);
  const staleChromiumReplacements: string[] = [];
  const staleChromiumResult = runInNewContext(inPage, {
    window: {
      location: {
        href: "https://example.com/allowed",
        replace: (next: string) => staleChromiumReplacements.push(next)
      },
      stop: () => undefined
    }
  });
  assert.equal(staleChromiumResult, "url-mismatch");
  assert.deepEqual(staleChromiumReplacements, [], "a stale Chromium document must not be replaced");
  const caseChangedChromiumResult = runInNewContext(inPage, {
    window: {
      location: {
        href: "https://example.com/Blocked",
        replace: () => assert.fail("a case-changed Chromium URL must not be replaced")
      },
      stop: () => assert.fail("a case-changed Chromium URL must not be interrupted")
    }
  });
  assert.equal(caseChangedChromiumResult, "url-mismatch", "Chromium's in-page comparison must be case-sensitive");

  const guarded = chromiumRedirectScript("Google Chrome Canary", target, { currentUrl: observed });
  assert.match(guarded, /tell application "Google Chrome Canary"/);
  assert.match(guarded, /set previousUrl to "https:\/\/example\.com\/blocked"/);
  assert.match(guarded, /if previousUrl is not "" and previousUrl is not targetUrl then/);
  assert.match(guarded, /set observedWindow to front window/);
  assert.match(guarded, /set observedActiveTab to active tab of observedWindow/);
  assert.match(guarded, /set observedWindowId to id of observedWindow/);
  assert.match(guarded, /set observedTabId to id of observedActiveTab/);
  assert.match(guarded, /set observedTabIndex to active tab index of observedWindow/);
  assert.match(guarded, /if \(URL of observedActiveTab\) is previousUrl then/);
  assert.match(guarded, /set javascriptResult to execute observedActiveTab javascript/);
  assert.match(guarded, /on error\n\s*set javascriptResult to "javascript-error"/,
    "disabled JavaScript and internal-page errors must enter the native fallback path");
  assert.match(guarded, /else if javascriptResult is "url-mismatch" then\n\s*set redirectMethod to "url-mismatch"\n\s*else\n\s*set redirectMethod to "javascript-unconfirmed"\n\s*set nativeFallbackAllowed to true/,
    "a JavaScript URL mismatch must be the sole error result that cannot authorize native fallback");
  const nativeGate = guarded.indexOf("if targetStillCurrent and nativeFallbackAllowed and hasObservedTab then");
  const frontmostCheck = guarded.lastIndexOf("set targetStillCurrent to frontmost of process \"Google Chrome Canary\"", nativeGate);
  const currentWindowCheck = guarded.indexOf("set targetStillCurrent to ((id of currentWindow) as text) is (observedWindowId as text)", nativeGate);
  const currentTabCheck = guarded.indexOf("set targetStillCurrent to ((id of currentTab) as text) is (observedTabId as text)", currentWindowCheck);
  const currentIndexCheck = guarded.indexOf("set targetStillCurrent to ((active tab index of currentWindow) as integer) is observedTabIndex", currentTabCheck);
  const exactUrlCheck = guarded.indexOf("set targetStillCurrent to ((URL of currentTab) is previousUrl)", currentIndexCheck);
  const nativeSet = guarded.indexOf("set URL of observedActiveTab to targetUrl", exactUrlCheck);
  assert.ok(frontmostCheck >= 0 && nativeGate > frontmostCheck,
    "native Chromium fallback must refuse to mutate after the browser loses focus");
  assert.ok(currentWindowCheck > nativeGate && currentTabCheck > currentWindowCheck && currentIndexCheck > currentTabCheck,
    "native Chromium fallback must retain the captured front-window, tab, and index identity");
  assert.ok(exactUrlCheck > currentIndexCheck && nativeSet > exactUrlCheck,
    "native Chromium fallback must recheck the exact observed URL immediately before setting only the captured tab URL");
  const confirmedTarget = guarded.indexOf("set targetStillCurrent to ((URL of currentTab) is targetUrl)", nativeSet);
  const confirmedCount = guarded.indexOf("set redirectedTabCount to 1", confirmedTarget);
  assert.ok(confirmedTarget > nativeSet && confirmedCount > confirmedTarget,
    "Chromium must count a redirect only after confirming the captured current tab reached the exact target URL");
  assert.doesNotMatch(guarded, /repeat with browserTab|repeat with browserWindow|make new tab|close |\bopen\b|activate/,
    "Chromium fallback must never sweep, create, close, open, or focus browser tabs or windows");
  const chromiumCaseStart = guarded.indexOf("considering case");
  const chromiumCaseEnd = guarded.lastIndexOf("end considering");
  assert.ok(chromiumCaseStart >= 0 && chromiumCaseEnd > chromiumCaseStart,
    "Chromium URL guards must run inside a case-sensitive comparison block");
  const precondition = guarded.indexOf("if previousUrl is not \"\" and previousUrl is not targetUrl then");
  assert.ok(precondition > chromiumCaseStart && precondition < chromiumCaseEnd,
    "Chromium's AppleScript admission guard must be case-sensitive");

  const internalPage = chromiumRedirectScript("Google Chrome", target, { currentUrl: "chrome://settings/privacy" });
  assert.match(internalPage, /set previousUrl to "chrome:\/\/settings\/privacy"/);
  assert.match(internalPage, /set javascriptResult to "javascript-error"[\s\S]*set nativeFallbackAllowed to true[\s\S]*set URL of observedActiveTab to targetUrl/,
    "Chromium internal pages must remain enforceable through the target-checked native fallback");

  const compatible = chromiumRedirectScript("Google Chrome", target);
  assert.match(compatible, /set redirectMethod to "missing-precondition"/);
  assert.match(compatible, /set hasObservedTab to false/);
  assert.match(compatible, /if previousUrl is not "" and previousUrl is not targetUrl then/);
  assert.match(compatible, /if targetStillCurrent and nativeFallbackAllowed and hasObservedTab then/,
    "callers without an observed URL must remain unable to admit native mutation");
}

{
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: false, app: "Discord", url: "" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Safari", url: "https://youtube.com/watch?v=blocked" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Google Chrome", url: "https://reddit.com/" }), true);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Discord", url: "" }), false);
  assert.equal(shouldAttemptBlockedBrowserRedirect({ coolingDown: true, app: "Safari", url: "" }), false);
}

{
  const script = safariInterruptionScript("http://127.0.0.1:8787/blocked", {
    currentUrl: "https://youtube.com/watch?v=blocked"
  });
  assert.match(script, /^\(\(\) => \{/);
  assert.match(script, /const expectedUrl = "https:\/\/youtube\.com\/watch\?v=blocked"/);
  assert.match(script, /if \(!expectedUrl \|\| window\.location\.href !== expectedUrl\) return 'url-mismatch'/);
  assert.ok(script.indexOf("url-mismatch") < script.indexOf("window.stop()"),
    "the in-page Safari guard must reject a changed URL before interrupting content");
  assert.match(script, /webkitExitFullscreen/);
  assert.match(script, /exitPictureInPicture/);
  assert.match(script, /window\.stop\(\)/);
  assert.match(script, /media-fullscreen/);
  assert.match(script, /picture-in-picture/);
  assert.match(script, /active-media/);
  assert.match(script, /item\.pause\(\)/);
  assert.match(script, /item\.srcObject = null/);
  assert.match(script, /window\.location\.replace/);
  assert.match(script, /return `redirected:\$\{status\.length/);
  assert.match(script, /catch \(_\) \{\n\s*try \{\n\s*if \(!expectedUrl \|\| window\.location\.href !== expectedUrl\) return 'url-mismatch'/,
    "Safari's in-page fallback must recheck the same observed document before replacing it");
  assert.ok(script.indexOf("const expectedUrl") < script.indexOf("try {"),
    "Safari's fallback guard must retain access to the expected URL after an interruption error");

  const target = "http://127.0.0.1:8787/blocked";
  const observed = "https://youtube.com/watch?v=blocked";
  const fallbackReplacements: string[] = [];
  const fallbackResult = runInNewContext(script, {
    document: {
      querySelectorAll: () => { throw new Error("page became unscriptable"); }
    },
    window: {
      location: {
        href: observed,
        replace: (next: string) => fallbackReplacements.push(next)
      }
    }
  });
  assert.equal(fallbackResult, "redirected:fallback");
  assert.deepEqual(fallbackReplacements, [target],
    "the still-current Safari document may use the guarded in-page fallback");

  const staleFallbackReplacements: string[] = [];
  const staleFallbackResult = runInNewContext(script, {
    window: {
      location: {
        href: "https://youtube.com/watch?v=allowed",
        replace: (next: string) => staleFallbackReplacements.push(next)
      }
    }
  });
  assert.equal(staleFallbackResult, "url-mismatch");
  assert.deepEqual(staleFallbackReplacements, [], "a stale Safari document must not enter either replacement path");
  const caseChangedSafariResult = runInNewContext(script, {
    window: {
      location: {
        href: "https://youtube.com/watch?v=Blocked",
        replace: () => assert.fail("a case-changed Safari URL must not be replaced")
      }
    }
  });
  assert.equal(caseChangedSafariResult, "url-mismatch", "Safari's in-page comparison must be case-sensitive");

  const missingPreconditionReplacements: string[] = [];
  const missingPreconditionResult = runInNewContext(safariInterruptionScript(target), {
    window: {
      location: {
        href: observed,
        replace: (next: string) => missingPreconditionReplacements.push(next)
      }
    }
  });
  assert.equal(missingPreconditionResult, "url-mismatch");
  assert.deepEqual(missingPreconditionReplacements, [], "Safari must not mutate without an observed URL precondition");
}

{
  const script = safariRedirectScript("http://127.0.0.1:8787/blocked", { currentUrl: "https://youtube.com/watch?v=blocked" });
  const fullscreenGate = script.indexOf("if redirectedTabCount > 0 and hasBlockedTab");
  const firstEscapeKey = script.indexOf("key code 53");
  assert.ok(fullscreenGate > 0, "Safari fullscreen escape should be conditional");
  assert.ok(firstEscapeKey > fullscreenGate, "Safari fullscreen escape should not run before media fullscreen is detected");
  assert.doesNotMatch(script, /Exit Full Screen/);
  assert.doesNotMatch(script, /set frontmost of process/,
    "fullscreen cleanup must never activate Safari after the user switches applications");
  assert.match(script, /set previousUrl to "https:\/\/youtube\.com\/watch\?v=blocked"/);
  assert.match(script, /set candidateMatchesPreviousUrl to \(\(URL of candidateTab\) is previousUrl\)/);
  assert.match(script, /if candidateMatchesPreviousUrl then[\s\S]*do JavaScript [\s\S]* in blockedTab/);
  assert.match(script, /else if mediaMode starts with "redirected:" then\n\s*set redirectMethod to "javascript-replace-unconfirmed"/);
  assert.match(script, /if mediaMode is "url-mismatch" then\n\s*set redirectMethod to "url-mismatch"\n\s*else if mediaMode starts with "redirected:"/,
    "a Safari JavaScript URL mismatch must not enter native fallback");
  assert.match(script, /on error\n\s*set mediaMode to "javascript-error"\n\s*set redirectMethod to "javascript-error"\n\s*set nativeFallbackAllowed to true/,
    "disabled JavaScript and unscriptable Safari pages must authorize the guarded native path");
  const nativeGate = script.indexOf("if targetStillCurrent and nativeFallbackAllowed and hasBlockedTab then");
  const nativeFrontmostCheck = script.lastIndexOf("set targetStillCurrent to frontmost of process \"Safari\"", nativeGate);
  const nativeWindowCheck = script.indexOf("set targetStillCurrent to (visibleWindow is blockedWindow)", nativeGate);
  const nativeTabCheck = script.indexOf("set targetStillCurrent to (visibleTab is blockedTab)", nativeWindowCheck);
  const nativeWindowIdCheck = script.indexOf("set targetStillCurrent to (((id of visibleWindow) as text) is (blockedWindowId as text))", nativeTabCheck);
  const nativeTabIndexCheck = script.indexOf("set targetStillCurrent to ((index of visibleTab) as integer) is blockedTabIndex", nativeWindowIdCheck);
  const nativeUrlCheck = script.indexOf("set targetStillCurrent to ((URL of visibleTab) is previousUrl)", nativeTabIndexCheck);
  const nativeSet = script.indexOf("set URL of blockedTab to targetUrl", nativeUrlCheck);
  assert.ok(nativeFrontmostCheck >= 0 && nativeGate > nativeFrontmostCheck,
    "native Safari fallback must refuse to mutate after Safari loses focus");
  assert.ok(nativeWindowCheck > nativeGate && nativeTabCheck > nativeWindowCheck && nativeWindowIdCheck > nativeTabCheck,
    "native Safari fallback must retain the captured window and tab identities");
  assert.ok(nativeTabIndexCheck > nativeWindowIdCheck && nativeUrlCheck > nativeTabIndexCheck && nativeSet > nativeUrlCheck,
    "native Safari fallback must revalidate the captured current tab and exact URL immediately before mutation");
  const confirmedTarget = script.indexOf("set targetStillCurrent to ((URL of visibleTab) is targetUrl)", nativeSet);
  const confirmedCount = script.indexOf("set redirectedTabCount to 1", confirmedTarget);
  assert.ok(confirmedTarget > nativeSet && confirmedCount > confirmedTarget,
    "Safari must count a redirect only after confirming the same current tab reached the exact target URL");
  assert.doesNotMatch(script, /make new tab|close blockedTab|close replacementTab|repeat with safariTab|\bopen\b|activate/,
    "Safari fallback must never sweep, create, close, open, or activate browser tabs or windows");
  const safariCaseStart = script.indexOf("considering case");
  const safariCaseEnd = script.lastIndexOf("end considering");
  assert.ok(safariCaseStart >= 0 && safariCaseEnd > safariCaseStart,
    "Safari URL guards must run inside a case-sensitive comparison block");
  const exactGuard = script.indexOf("set candidateMatchesPreviousUrl to ((URL of candidateTab) is previousUrl)");
  assert.ok(exactGuard > safariCaseStart && exactGuard < safariCaseEnd,
    "Safari's AppleScript admission check must be case-sensitive");

  const fullscreenLoop = script.indexOf("repeat 4 times", fullscreenGate);
  const firstFrontmostCheck = script.indexOf("set targetStillCurrent to frontmost of process \"Safari\"", fullscreenLoop);
  const capturedWindowCheck = script.indexOf("set targetStillCurrent to (visibleWindow is blockedWindow)", firstFrontmostCheck);
  const capturedTabCheck = script.indexOf("set targetStillCurrent to (visibleTab is blockedTab)", capturedWindowCheck);
  const targetUrlCheck = script.indexOf("set targetStillCurrent to (visibleSafariUrl is previousUrl or visibleSafariUrl is targetUrl)", capturedTabCheck);
  const immediateFrontmostCheck = script.indexOf("if frontmost of process \"Safari\" then", targetUrlCheck);
  assert.ok(fullscreenLoop > fullscreenGate && firstFrontmostCheck > fullscreenLoop,
    "Safari focus must be checked inside the per-Escape cleanup loop");
  assert.ok(capturedWindowCheck > firstFrontmostCheck && capturedTabCheck > capturedWindowCheck && targetUrlCheck > capturedTabCheck,
    "the captured Safari window, tab, and navigation must still be current before cleanup");
  assert.ok(firstEscapeKey > immediateFrontmostCheck,
    "Safari must be rechecked as frontmost immediately before each Escape key event");

  const previewScript = safariRedirectScript(
    "http://127.0.0.1:8787/blocked",
    { currentUrl: "https://example.com/blocked" },
    "Safari Technology Preview"
  );
  assert.match(previewScript, /tell application "Safari Technology Preview"/);
  assert.match(previewScript, /frontmost of process "Safari Technology Preview"/);
  assert.doesNotMatch(previewScript, /set frontmost of process/);

  const internalPage = safariRedirectScript(
    "http://127.0.0.1:8787/blocked",
    { currentUrl: "safari-extension://blocked/internal" }
  );
  assert.match(internalPage, /set previousUrl to "safari-extension:\/\/blocked\/internal"/);
  assert.match(internalPage, /set mediaMode to "javascript-error"[\s\S]*set nativeFallbackAllowed to true[\s\S]*set URL of blockedTab to targetUrl/,
    "Safari internal pages must remain enforceable through the target-checked native fallback");

  const compatible = safariRedirectScript("http://127.0.0.1:8787/blocked");
  assert.match(compatible, /set redirectMethod to "missing-precondition"/);
  assert.match(compatible, /set candidateMatchesPreviousUrl to false/);
  assert.match(compatible, /if previousUrl is not "" and previousUrl is not targetUrl then/);
  assert.match(compatible, /if targetStillCurrent and nativeFallbackAllowed and hasBlockedTab then/,
    "callers without an observed URL must remain unable to admit native Safari mutation");
}
