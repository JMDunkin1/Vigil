import { readFileSync } from "node:fs";
import { blockPageDiagnostic } from "../blockPageDiagnostics.js";
import { PROTECTION_PAGE_CSS } from "../protectionAppearance.js";
import { BLOCKED_PAGE_ESCAPE_FALLBACK, safeExternalPageUrl } from "../blockedPageUrl.js";
import { blockedPageBack } from "../blockedPageBack.js";
import { activePolicy } from "../policy.js";
import { policyForSample } from "../monitor/policy.js";
import { safariFilterDenyMatch } from "../safariFilter.js";
import type { ActivePolicy, UsageState, VigilState } from "../types.js";

interface PageInput {
  url: URL;
  state: VigilState;
  usage?: UsageState;
  port?: number;
}

export type BlockedPageResponse =
  | { status: 200; body: string }
  | { status: 302; location: string };

const BLOCK_EXPLANATIONS: Record<string, string> = {
  "adult-blocklist": "Vigil's adult-content blocklist blocks this page",
  allowlist: "The active allowlist does not include this page",
  "app-lock": "An active app lock blocks this page",
  baseline: "A baseline Vigil protection blocks this page",
  "browser-control": "Vigil's browser controls block this page",
  "content-filter": "A Vigil content filter blocks this page",
  limit: "An active usage limit blocks this page",
  "url-pattern": "A saved URL rule blocks this page"
};

// The companion HTTP surface intentionally does not expose app assets.
// Embed the small packaged icon so protection pages need no extra public route.
const protectionBrandIcon = `data:image/png;base64,${readFileSync(new URL("../../extension/icons/icon-128.png", import.meta.url)).toString("base64")}`;

// One visual system for server pages and the packaged browser companions.
const protectionPageCss = `${PROTECTION_PAGE_CSS}
/* Decoration stays outside the media DOM so content filters cannot hide the panel. */
.brand-mark { background-image: url("${protectionBrandIcon}"); }
`;

export function companionPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Vigil</title>
  <style>${protectionPageCss}
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; --paper: #f5f6f8; --paper-2: #edf0f5; --surface: #ffffff; --surface-strong: #ffffff; --ink: #1a1f2a; --muted: #596575; --line: #dde2ea; --line-strong: #bdc6d4; --primary: #315ae8; --primary-strong: #244bc9; --blue: #315ae8; --focus: #e9efff; }
}
</style>
</head>
<body>
  <main>
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true"></span>
      <p class="eyebrow">Vigil</p>
    </div>
    <h1>Open Vigil from the menu bar.</h1>
    <p class="message">Choose the Vigil icon in your Mac menu bar, then choose <strong>Open Vigil</strong>.</p>
  </main>
</body>
</html>`;
}

export function blockedPageResponse(input: PageInput, _referrer = ""): BlockedPageResponse {
  if (staleBlockedPageReceipt(input.url, input.state)) {
    const location = safeBlockedPageEscapeUrl(input, input.url.searchParams.get("back"));
    return location ? { status: 302, location } : { status: 200, body: blockedPage(input) };
  }
  return { status: 200, body: blockedPage(input) };
}

export function blockedPage(input: PageInput): string {
  const { url } = input;
  if (url.searchParams.get("kind") === "reddit-review") {
    return '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body data-vigil-block-page="1" data-vigil-quiet-return="1"><script>setTimeout(() => location.replace("about:blank"), 5000);</script></body></html>';
  }
  const site = url.searchParams.get("site") || "This target";
  const backUrl = safeBlockedPageEscapeUrl(input, url.searchParams.get("back"));
  const escapeUrl = backUrl || BLOCKED_PAGE_ESCAPE_FALLBACK;
  const requestedKind = String(url.searchParams.get("kind") || "").toLowerCase();
  const requestedUntil = String(url.searchParams.get("until") || "");
  const active = activePolicy(structuredClone(input.state));
  const requestedPolicyId = String(url.searchParams.get("policyId") || "");
  const activeMatchesRequest = Boolean(
    active
    && active.kind === requestedKind
    && (!requestedPolicyId || requestedPolicyId === active.session.id)
  );
  const integrityAlarm = activeMatchesRequest
    && active?.kind === "integrity"
    && active.alarm
    && typeof active.alarm === "object"
    && !Array.isArray(active.alarm)
    ? active.alarm as Record<string, unknown>
    : null;
  const integrityReason = integrityAlarm?.type === "state-seal"
    ? "Vigil found a saved-state integrity mismatch."
    : String(integrityAlarm?.detail || "Vigil found an integrity problem.");
  const browserProtectionInterrupted = requestedKind === "browser-protection";
  const blockExplanation = browserProtectionInterrupted
    ? "Vigil could not confirm that this page’s protection is responding. The extension may still be enabled. Check its access to this website and try opening the page again."
    : activeMatchesRequest && active?.kind === "integrity"
    ? `${integrityReason} This protection stays active ${active.endsAt || "until the integrity alarm is reviewed"}.`
    : activeMatchesRequest && active
      ? `${active.session.title || "A Vigil protection"} is active${active.endsAt ? ` until ${active.endsAt}` : ""}.`
      : BLOCK_EXPLANATIONS[requestedKind]
        ? `${BLOCK_EXPLANATIONS[requestedKind]}${requestedUntil ? ` until ${requestedUntil}` : ""}.`
        : "A saved Vigil rule applies to this page.";
  const diagnostic = blockPageDiagnostic({
    source: "MAC",
    kind: requestedKind,
    target: site,
    policyId: requestedPolicyId,
    until: requestedUntil,
    detail: blockExplanation
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked · Vigil</title>
  <style>${protectionPageCss}
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; --paper: #f5f6f8; --paper-2: #edf0f5; --surface: #ffffff; --surface-strong: #ffffff; --ink: #1a1f2a; --muted: #596575; --line: #dde2ea; --line-strong: #bdc6d4; --primary: #315ae8; --primary-strong: #244bc9; --blue: #315ae8; --focus: #e9efff; }
}
</style>
</head>
<body data-vigil-block-page="1">
  <main aria-label="Blocked by Vigil">
    <h1>Blocked</h1>
    <p class="reason" hidden>${escapeHtml(blockExplanation)}</p>
    <div class="escape-actions">
      <a id="leaveBlockedPage" href="${escapeHtml(escapeUrl)}">Back</a>
    </div>
  </main>
  <p id="vigilBlockDiagnostic" class="block-reference" title="${escapeHtml(blockExplanation)}">${diagnostic.reference}</p>
  <script id="vigilBlockDetails" type="application/json">${safeScriptJson(diagnostic)}</script>
  <script>
    ${blockedPageBack.toString()}
    const escapeTarget = ${safeScriptJson(escapeUrl)};
    const leaveBlockedPage = document.querySelector("#leaveBlockedPage");
    if (leaveBlockedPage) {
      leaveBlockedPage.addEventListener("click", (event) => {
        event.preventDefault();
        if (escapeTarget !== "about:blank") location.replace(escapeTarget);
        else blockedPageBack();
      });
    }
  </script>
</body>
</html>`;
}

function staleBlockedPageReceipt(url: URL, state: VigilState): boolean {
  const requestedMode = url.searchParams.get("mode");
  if (!["focus", "integrity"].includes(requestedMode || "")) return false;
  const policy = activePolicy(state);
  if (!policy || policy.session.mode !== requestedMode) return true;
  const policyId = url.searchParams.get("policyId");
  if (policyId && policyId !== policy.session.id) return true;
  const until = url.searchParams.get("until");
  return Boolean(until && policy.endsAt && until !== policy.endsAt);
}

export function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return String(value).replace(/[&<>"']/g, (char) => entities[char] || char);
}

export function safeScriptJson(value: unknown): string {
  const entities: Record<string, string> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026"
  };
  return JSON.stringify(value).replace(/[<>&]/g, (char) => entities[char] || char);
}

function safeBlockedPageEscapeUrl(input: PageInput, value: unknown): string {
  const candidate = safeExternalPageUrl(value);
  if (!candidate) return "";
  const parsed = new URL(candidate);
  const state = structuredClone(input.state);
  const usage = structuredClone(input.usage || {});
  const policy = policyForSample(state, usage, {
    app: "Safari",
    hostname: parsed.hostname,
    url: parsed.toString()
  }, new Date(), { observeBrowserProtection: false });
  if (policy || safariFilterDenyMatch(state, parsed)) return "";
  return parsed.toString();
}

export function commitmentLockError(policy: ActivePolicy | null | undefined): string {
  if (policy?.kind === "integrity") {
    return "Integrity lockdown cannot be ended with an emergency unlock. Open a protected maintenance window after checking the alarm.";
  }
  if (policy?.kind === "panic") {
    return "Panic lockout cannot be ended early.";
  }
  return "This commitment lock does not allow emergency unlocks. Open a protected maintenance window if this was a mistake.";
}
