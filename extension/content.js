let lastPulseAt = Date.now();

setInterval(() => sendPulse("heartbeat"), 5000);
window.addEventListener("focus", () => resetAndPulse("activated"));
window.addEventListener("pageshow", () => resetAndPulse("activated"));
window.addEventListener("popstate", () => resetAndPulse("history"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resetAndPulse("activated");
});

patchHistory("pushState");
patchHistory("replaceState");

function resetAndPulse(reason) {
  lastPulseAt = Date.now();
  sendPulse(reason);
}

function sendPulse(reason) {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  const now = Date.now();
  const seconds = Math.max(1, Math.min(15, (now - lastPulseAt) / 1000));
  lastPulseAt = now;
  try {
    chrome.runtime.sendMessage({
      type: "SENTINEL_PULSE",
      url: location.href,
      title: document.title,
      reason,
      seconds
    }, (result) => {
      void chrome.runtime.lastError;
      if (result?.browserNoiseBlockingEnabled) cleanupBrowserNoise();
    });
  } catch {
  }
}

function patchHistory(method) {
  const original = history[method];
  history[method] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    setTimeout(() => resetAndPulse("history"), 0);
    return result;
  };
}

function cleanupBrowserNoise() {
  injectCleanupStyle();
  removeCookiePrompts();
}

function injectCleanupStyle() {
  if (document.getElementById("sentinel-cleanup-style")) return;
  const style = document.createElement("style");
  style.id = "sentinel-cleanup-style";
  style.textContent = `
    [id*="cookie-banner" i],
    [class*="cookie-banner" i],
    [id*="cookie-consent" i],
    [class*="cookie-consent" i],
    [id*="consent-banner" i],
    [class*="consent-banner" i],
    [id*="onetrust" i],
    [class*="onetrust" i],
    [id*="trustarc" i],
    [class*="trustarc" i],
    [id*="ad-container" i],
    [class*="ad-container" i],
    [id*="ad-slot" i],
    [class*="ad-slot" i],
    [class*="sponsored" i],
    [class*="social-share" i],
    [id*="social-share" i],
    [class*="share-buttons" i],
    [id*="share-buttons" i],
    iframe[src*="doubleclick.net"],
    iframe[src*="googlesyndication.com"],
    iframe[src*="facebook.com/plugins"],
    iframe[src*="platform.twitter.com"],
    iframe[src*="widgets.pinterest.com"] {
      display: none !important;
      visibility: hidden !important;
    }
  `;
  document.documentElement.append(style);
}

function removeCookiePrompts() {
  const candidates = [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], body > div, body > section")].slice(0, 120);
  for (const element of candidates) {
    const text = (element.innerText || "").toLowerCase();
    const fixed = ["fixed", "sticky"].includes(getComputedStyle(element).position);
    const mentionsCookies = text.includes("cookie") || text.includes("consent") || text.includes("privacy choices");
    if (fixed && mentionsCookies && element.offsetHeight < window.innerHeight * 0.75) {
      element.remove();
    }
  }
}
