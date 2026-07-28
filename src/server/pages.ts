import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../apiSecurity.js";
import { BLOCKED_PAGE_ESCAPE_FALLBACK, safeExternalPageUrl } from "../blockedPageUrl.js";
import { PORT } from "../defaults.js";
import { emergencyUnlockAllowedForPolicy, activePolicy } from "../policy.js";
import { intentReasonPolicy } from "../intentReason.js";
import { interventionSummary } from "../intervention.js";
import { pausePageData } from "../intentionalUse.js";
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

interface PauseBudget {
  budgetSeconds?: number;
  seconds?: number;
}

interface PauseContext {
  message?: string;
}

interface PausePageData {
  pause: {
    id: string;
    targetLabel: string;
    ruleName: string;
    sessionMinutes: number;
    returnUrl: string;
  };
  goal?: {
    statement?: string;
  };
  budget?: PauseBudget;
  context?: PauseContext;
  replacements?: string[];
  waitSeconds?: number;
}

export function companionPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Vigil</title>
  <style>
    :root { color-scheme: dark; --ink: #f1eee4; --muted: #aeb3af; --gold: #d1a94d; --line: #5f4b2d; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; color: var(--ink); background: radial-gradient(circle at 50% 18%, #18345b 0, #0a111d 44%, #05080e 100%); font-family: Georgia, "Times New Roman", serif; }
    main { width: min(560px, 100%); padding: 34px; border: 1px solid var(--line); border-radius: 6px; background: linear-gradient(145deg, #142238f7, #0b121df7); box-shadow: 0 24px 80px #000b, inset 0 0 0 3px #080d15, inset 0 0 0 4px #6f5529; }
    .eyebrow { margin: 0 0 8px; color: var(--gold); font: 900 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .14em; }
    h1 { margin: 0 0 14px; font-size: clamp(2.25rem, 7vw, 3.75rem); line-height: .98; letter-spacing: -.035em; }
    p { margin: 0; color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Vigil</p>
    <h1>Open Vigil from the menu bar.</h1>
    <p>Choose the Vigil icon in your Mac menu bar, then choose <strong>Open Vigil</strong>.</p>
  </main>
</body>
</html>`;
}

export function blockedPageResponse(input: PageInput, _referrer = ""): BlockedPageResponse {
  if (staleFocusBlock(input.url, input.state)) {
    const location = safeBlockedPageEscapeUrl(input, input.url.searchParams.get("back"));
    return location ? { status: 302, location } : { status: 200, body: blockedPage(input) };
  }
  return { status: 200, body: blockedPage(input) };
}

export function blockedPage(input: PageInput): string {
  const { url } = input;
  const site = escapeHtml(url.searchParams.get("site") || "This target");
  const backUrl = safeBlockedPageEscapeUrl(input, url.searchParams.get("back"));
  const escapeUrl = backUrl || BLOCKED_PAGE_ESCAPE_FALLBACK;
  const requestedKind = String(url.searchParams.get("kind") || "").toLowerCase();
  const requestedUntil = String(url.searchParams.get("until") || "");
  const active = activePolicy(structuredClone(input.state));
  const activeMatchesRequest = Boolean(active && active.kind === requestedKind);
  const integrityAlarm = active?.kind === "integrity"
    && active.alarm
    && typeof active.alarm === "object"
    && !Array.isArray(active.alarm)
    ? active.alarm as Record<string, unknown>
    : null;
  const integrityReason = integrityAlarm?.type === "state-seal"
    ? "Vigil found a saved-state integrity mismatch."
    : String(integrityAlarm?.detail || "Vigil found an integrity problem.");
  const blockExplanation = active?.kind === "integrity"
    ? `${integrityReason} This protection stays active ${active.endsAt || "until the integrity alarm is reviewed"}.`
    : activeMatchesRequest && active
      ? `${active.session.title || "A Vigil protection"} is active${active.endsAt ? ` until ${active.endsAt}` : ""}.`
      : BLOCK_EXPLANATIONS[requestedKind]
        ? `${BLOCK_EXPLANATIONS[requestedKind]}${requestedUntil ? ` until ${requestedUntil}` : ""}.`
        : "A saved Vigil rule applies to this page.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked · Vigil</title>
  <style>
    :root { color-scheme: dark; --paper: #101111; --paper-2: #161717; --ink: #f0ece5; --primary: #b77952; --primary-strong: #d5a16b; --focus: rgba(213, 161, 107, .24); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; color: var(--ink); background: radial-gradient(circle at 78% -8%, rgba(183, 121, 82, .08), transparent 34rem), radial-gradient(circle at 28% 106%, rgba(157, 124, 88, .04), transparent 30rem), linear-gradient(180deg, var(--paper), var(--paper-2)); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, 100%); }
    .eyebrow { margin: 0 0 12px; color: var(--primary-strong); font-size: .78rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { max-width: 12ch; margin: 0; font: 700 clamp(2.75rem, 8vw, 5rem)/.98 Georgia, "Times New Roman", serif; letter-spacing: -.04em; text-wrap: balance; }
    .reason { max-width: 48ch; margin: 22px 0 0; padding-left: 14px; border-left: 2px solid rgba(213, 161, 107, .52); color: #aaa398; font-size: .96rem; line-height: 1.6; }
    .escape-actions { margin-top: 32px; }
    .escape-actions a { min-height: 48px; display: inline-grid; place-items: center; padding: 0 22px; border-radius: 7px; color: #16120f; background: var(--primary); text-decoration: none; font-weight: 700; transition: background .15s ease, transform .15s ease; }
    .escape-actions a:hover { background: var(--primary-strong); }
    .escape-actions a:active { transform: translateY(1px); }
    .escape-actions a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    @media (max-width: 520px) { body { place-items: start; padding: 64px 24px; } }
  </style>
</head>
<body data-vigil-block-page="1">
  <main>
    <p class="eyebrow">Vigil</p>
    <h1>${site} is blocked.</h1>
    <p class="reason">${escapeHtml(blockExplanation)}</p>
    <div class="escape-actions">
      <a id="leaveBlockedPage" href="${escapeHtml(escapeUrl)}">Go back</a>
    </div>
  </main>
  <script>
    const escapeTarget = ${safeScriptJson(escapeUrl)};
    const leaveBlockedPage = document.querySelector("#leaveBlockedPage");
    if (leaveBlockedPage) {
      leaveBlockedPage.addEventListener("click", (event) => {
        event.preventDefault();
        location.replace(escapeTarget);
      });
    }
  </script>
</body>
</html>`;
}

function staleFocusBlock(url: URL, state: VigilState): boolean {
  if (url.searchParams.get("mode") !== "focus") return false;
  const policy = activePolicy(state);
  if (!policy || policy.session.mode !== "focus") return true;
  const policyId = url.searchParams.get("policyId");
  if (policyId && policyId !== policy.session.id) return true;
  const until = url.searchParams.get("until");
  return Boolean(until && policy.endsAt && until !== policy.endsAt);
}

function legacyBlockedPage({ url, state, port = PORT }: PageInput): string {
  const policy = activePolicy(state);
  const site = escapeHtml(url.searchParams.get("site") || "This target");
  const mode = escapeHtml(url.searchParams.get("mode") || "focus");
  const until = escapeHtml(url.searchParams.get("until") || "");
  const emergencyAllowed = emergencyUnlockAllowedForPolicy(policy);
  const reasonPolicy = intentReasonPolicy(state);
  const breakStatus = emergencyAllowed ? "" : commitmentLockError(policy);
  const reasonStatus = reasonPolicy.enabled ? `Enter a reason of at least ${reasonPolicy.minLength} characters.` : "";
  const initialStatus = breakStatus || reasonStatus;
  const breakDisabled = emergencyAllowed && !reasonPolicy.enabled ? "" : " disabled";
  const intervention = interventionSummary(state);
  const backUrl = safePageNavigationUrl(url.searchParams.get("back"));
  const interventionClass = escapeHtml(intervention.level);
  const interventionCopy = escapeHtml(intervention.message);
  const interventionTargets = escapeHtml(intervention.topTargets.map((target) => `${target.label} x${target.count}`).join(" | ") || "No recent targets");
  const pageData = {
    site: url.searchParams.get("site") || "",
    kind: url.searchParams.get("kind") || "manual",
    lockId: url.searchParams.get("lockId") || "",
    returnUrl: url.searchParams.get("return") || "",
    backUrl,
    emergencyAllowed,
    reasonGate: reasonPolicy
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked</title>
  <style>
    :root { color-scheme: dark; --ink: #eef0e8; --muted: #a8adad; --panel: rgba(12, 18, 28, .94); --line: #5e4a28; --gold: #d1a94d; --gold-soft: #f2d98c; --blue: #142b4a; --red: #8f352f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Georgia, "Times New Roman", serif; color: var(--ink); background: radial-gradient(circle at 50% 22%, #142747 0, #090e17 42%, #05070c 100%); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .22; background-image: radial-gradient(circle, #d1a94d 0 1px, transparent 1.5px); background-size: 37px 37px; mask-image: linear-gradient(to bottom, #000, transparent 72%); }
    main { position: relative; width: min(620px, calc(100vw - 32px)); margin: 32px 0; padding: 34px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(145deg, rgba(19, 29, 44, .96), var(--panel)); box-shadow: 0 24px 80px #000b, inset 0 0 0 3px #0a0f18, inset 0 0 0 4px #6e5427; }
    main::before { content: "✠"; display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 18px; border: 1px solid #85672f; background: #0d1625; color: var(--gold); font-size: 1.55rem; box-shadow: 4px 4px 0 #05080e; }
    h1 { font-size: clamp(2.25rem, 7vw, 4.15rem); line-height: .95; margin: 0 0 18px; letter-spacing: -.045em; color: #faf5e6; }
    h2 { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .12em; }
    p { font-size: 1.03rem; line-height: 1.58; color: var(--muted); margin: 0 0 14px; }
    a { color: var(--gold-soft); font-weight: 700; }
    blockquote { margin: 22px 0 0; padding: 15px 17px; border-left: 3px solid var(--gold); background: #080d15a8; color: #d8d5c8; font-style: italic; line-height: 1.5; }
    blockquote cite { display: block; margin-top: 7px; color: #9fa59f; font-size: .82rem; font-style: normal; }
    .meta { margin-top: 24px; padding-top: 18px; border-top: 1px solid #3b352a; color: #858d8a; }
    .break-panel { margin-top: 28px; padding-top: 22px; border-top: 1px solid #3b352a; display: grid; gap: 12px; }
    .break-panel h2 { margin: 0; font-size: .86rem; }
    .break-panel input { width: 100%; min-height: 44px; border: 1px solid #554a38; border-radius: 3px; padding: 0 12px; background: #080d15; color: var(--ink); font: 500 .94rem ui-sans-serif, system-ui, sans-serif; }
    .break-panel input:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
    .challenge { border: 1px dashed #9d7a37; border-radius: 3px; background: #211a0e; color: var(--gold-soft); padding: 10px 12px; font: 800 .9rem ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .challenge[hidden] { display: none; }
    .scanner-video { width: 100%; border-radius: 8px; }
    .break-actions, .distance-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .distance-row input { flex: 1 1 220px; }
    button { min-height: 44px; border: 1px solid transparent; border-radius: 3px; padding: 0 16px; font: 800 .82rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .05em; cursor: pointer; box-shadow: 3px 3px 0 #04060a; }
    button:disabled { cursor: not-allowed; opacity: .52; }
    .primary { color: #100d08; background: var(--gold); border-color: #f0d580; }
    .secondary { color: #e7e5dd; background: #1b2737; border-color: #43536a; }
    .escape-actions { display: none; margin-top: 22px; }
    .escape-actions.is-visible { display: flex; }
    .escape-actions a { min-height: 44px; border: 1px solid #43536a; border-radius: 3px; padding: 0 16px; display: inline-grid; place-items: center; color: #e7e5dd; background: #1b2737; text-decoration: none; font: 800 .82rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    .status { min-height: 22px; color: #969e9b; font: .88rem ui-sans-serif, system-ui, sans-serif; }
    .intervention { margin-top: 18px; border: 1px solid #3e4653; border-radius: 4px; background: #0a101a; padding: 12px; }
    .intervention strong { display: block; margin-bottom: 5px; }
    .intervention span { display: block; color: #929b98; font: .88rem ui-sans-serif, system-ui, sans-serif; overflow-wrap: anywhere; }
    .intervention.elevated { border-color: #9d7a37; background: #211a0e; }
    .intervention.high { border-color: #9c4439; background: #24100f; }
    @media (max-width: 620px) { main { padding: 24px 20px; } }
    @media (prefers-reduced-motion: no-preference) { main::before { animation: vigil-cross 3s steps(2, end) infinite; } @keyframes vigil-cross { 50% { color: #fff1b2; transform: translateY(-2px); } } }
  </style>
</head>
<body>
  <main>
    <h1>${site} is blocked.</h1>
    <p>The ${mode} lock is active. The useful move is to close this tab and go back to the thing you chose before impulse got loud.</p>
    <div id="escapeActions" class="escape-actions">
      <a id="leaveBlockedPage" href="${escapeHtml(backUrl || BLOCKED_PAGE_ESCAPE_FALLBACK)}">Go back</a>
    </div>
    <div class="intervention ${interventionClass}">
      <strong>Adaptive friction</strong>
      <span>${interventionCopy}</span>
      <span>${interventionTargets}</span>
    </div>
    <blockquote>“You have made us for Yourself, O Lord, and our heart is restless until it rests in You.”<cite>Saint Augustine, Confessions I.1</cite></blockquote>
    <section class="break-panel">
      <h2>Intentional break</h2>
      <input id="breakReason" type="text" autocomplete="off" placeholder="${reasonPolicy.enabled ? `Reason (${reasonPolicy.minLength}+ chars)` : "Reason"}">
      <input id="breakPasscode" type="password" autocomplete="current-password" placeholder="Keyholder passcode">
      <div class="distance-row">
        <input id="breakDistanceKey" type="password" autocomplete="off" placeholder="Distance key">
        <button id="scanBreakDistanceKey" class="secondary" type="button">Scan</button>
      </div>
      <code id="breakChallenge" class="challenge" hidden></code>
      <input id="breakChallengeInput" class="is-hidden" type="text" autocomplete="off" placeholder="Typing challenge" hidden>
      <div class="break-actions">
        <button id="requestBreak" class="primary" type="button"${breakDisabled}>Request Break</button>
        <button id="confirmBreak" class="secondary" type="button" disabled>Confirm</button>
      </div>
      <div id="breakStatus" class="status">${escapeHtml(initialStatus)}</div>
    </section>
    <p class="meta">Locked until ${until || "the session ends"}. Vigil: <a href="http://127.0.0.1:${port}">open app</a></p>
  </main>
  <script>
    const pageData = ${safeScriptJson(pageData)};
    let pending = null;
    let timer = null;
    const reason = document.querySelector("#breakReason");
    const passcode = document.querySelector("#breakPasscode");
    const distanceKey = document.querySelector("#breakDistanceKey");
    const challenge = document.querySelector("#breakChallenge");
    const challengeInput = document.querySelector("#breakChallengeInput");
    const requestButton = document.querySelector("#requestBreak");
    const confirmButton = document.querySelector("#confirmBreak");
    const scanButton = document.querySelector("#scanBreakDistanceKey");
    const status = document.querySelector("#breakStatus");
    const escapeActions = document.querySelector("#escapeActions");
    const leaveBlockedPage = document.querySelector("#leaveBlockedPage");
    let scanStream = null;

    const escapeTarget = blockedEscapeTarget();
    if (escapeActions && leaveBlockedPage) {
      escapeActions.classList.add("is-visible");
      leaveBlockedPage.href = escapeTarget;
      leaveBlockedPage.addEventListener("click", (event) => {
        event.preventDefault();
        location.replace(escapeTarget);
      });
    }

    reason.addEventListener("input", syncRequestButton);
    syncRequestButton();

    requestButton.addEventListener("click", async () => {
      if (!reasonReady()) {
        status.textContent = "Enter a reason of at least " + pageData.reasonGate.minLength + " characters.";
        syncRequestButton();
        return;
      }
      requestButton.disabled = true;
      try {
        const isAppLock = pageData.kind === "app-lock" && pageData.lockId;
        const body = isAppLock
          ? { lockId: pageData.lockId, reason: reason.value.trim() }
          : { reason: reason.value.trim() };
        const result = await postJson(isAppLock ? "/api/app-lock/unlock/request" : "/api/emergency/request", body);
        pending = result.request || result.pending;
        tick();
        timer = setInterval(tick, 500);
      } catch (error) {
        status.textContent = error.message;
        requestButton.disabled = false;
      }
    });

    confirmButton.addEventListener("click", async () => {
      if (!pending) return;
      confirmButton.disabled = true;
      try {
        const isAppLock = pageData.kind === "app-lock" && pageData.lockId;
        await postJson(isAppLock ? "/api/app-lock/unlock/confirm" : "/api/emergency/confirm", {
          requestId: pending.id,
          passcode: passcode.value,
          distanceKey: distanceKey.value,
          challengeText: challengeInput.value
        });
        status.textContent = "Break opened.";
        if (pageData.returnUrl) setTimeout(() => { location.href = pageData.returnUrl; }, 650);
      } catch (error) {
        status.textContent = error.message;
        tick();
      }
    });

    scanButton.addEventListener("click", async () => {
      if (!("BarcodeDetector" in window)) {
        status.textContent = "QR scanning is not available in this browser.";
        return;
      }
      scanButton.disabled = true;
      status.textContent = "Camera starting.";
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        const video = document.createElement("video");
        video.playsInline = true;
        video.muted = true;
        video.srcObject = scanStream;
        video.className = "scanner-video";
        document.querySelector(".break-panel").append(video);
        await video.play();
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const started = Date.now();
        const loop = async () => {
          const codes = await detector.detect(video).catch(() => []);
          const match = String(codes[0]?.rawValue || "").match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
          if (match) {
            distanceKey.value = match[0].toUpperCase();
            stopScanner(video);
            status.textContent = "Distance key scanned.";
            return;
          }
          if (Date.now() - started > 30000) {
            stopScanner(video);
            status.textContent = "No QR code found. Type the key instead.";
            return;
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      } catch (error) {
        status.textContent = error.message || "Camera unavailable.";
        scanButton.disabled = false;
      }
    });

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "${CONTROL_INTENT_HEADER}": "${CONTROL_INTENT_VALUE}"
        },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Request failed.");
      return result;
    }

    function stopScanner(video) {
      if (scanStream) {
        for (const track of scanStream.getTracks()) track.stop();
      }
      scanStream = null;
      scanButton.disabled = false;
      if (video) video.remove();
    }

    function tick() {
      if (!pending) return;
      renderChallenge();
      const seconds = Math.ceil((new Date(pending.eligibleAt).getTime() - Date.now()) / 1000);
      if (seconds > 0) {
        status.textContent = "Confirm in " + seconds + "s.";
        confirmButton.disabled = true;
      } else {
        status.textContent = "Ready to confirm.";
        confirmButton.disabled = false;
        clearInterval(timer);
      }
    }

    function reasonReady() {
      if (!pageData.reasonGate || !pageData.reasonGate.enabled) return true;
      return reason.value.replace(/\\s+/g, " ").trim().length >= pageData.reasonGate.minLength;
    }

    function syncRequestButton() {
      if (!requestButton || pending) return;
      requestButton.disabled = !pageData.emergencyAllowed || !reasonReady();
    }

    function blockedEscapeTarget() {
      return safeNavigationTarget(pageData.backUrl) || ${safeScriptJson(BLOCKED_PAGE_ESCAPE_FALLBACK)};
    }

    function safeNavigationTarget(value) {
      try {
        const url = new URL(String(value || ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        const host = url.hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
        if (["127.0.0.1", "localhost", "::1"].includes(host)) return "";
        if (sameNavigationUrl(url.href, pageData.returnUrl) || sameNavigationUrl(url.href, location.href)) return "";
        return url.href;
      } catch {
        return "";
      }
    }

    function sameNavigationUrl(left, right) {
      try {
        return new URL(String(left || "")).href === new URL(String(right || "")).href;
      } catch {
        return false;
      }
    }

    function renderChallenge() {
      if (pending && pending.challenge && pending.challenge.text) {
        challenge.hidden = false;
        challengeInput.hidden = false;
        challenge.textContent = "Type: " + pending.challenge.text;
      } else {
        challenge.hidden = true;
        challengeInput.hidden = true;
        challenge.textContent = "";
      }
    }
  </script>
</body>
</html>`;
}

void legacyBlockedPage;

export function pausePage({ url, state, port = PORT }: PageInput): string {
  const requestId = url.searchParams.get("requestId") || "";
  const data = pausePageData(state, requestId) as PausePageData | null;
  if (!data) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pause expired · Vigil</title>
  <style>${pausePageCss()}</style>
</head>
<body data-vigil-intentional-use="1">
  <main class="expired-shell">
    <div class="brand"><span class="brand-mark" aria-hidden="true">V</span><span>Vigil</span></div>
    <p class="eyebrow">Pre-open pause</p>
    <h1>That pause has expired.</h1>
    <p class="lead">Try the site again if you still mean to open it, or review your Intentional Use rules in Vigil.</p>
    <a class="button primary" href="http://127.0.0.1:${port}">Open Vigil</a>
  </main>
</body>
</html>`;
  }

  const pause = data.pause;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intentional Use · Vigil</title>
  <style>${activePausePageCss()}</style>
</head>
<body data-vigil-intentional-use="1">
  <div id="breathLine" class="breath-line" aria-hidden="true"></div>
  <main class="pause-shell">
    <section class="pause-content" aria-label="Intentional pause">
      <p class="prompt">Are you sure you want to open ${escapeHtml(pause.targetLabel)}?</p>
      <button id="continue" class="countdown-control" type="button" aria-label="Seconds remaining" disabled>
        <span id="countdown" aria-live="polite">${Math.max(0, data.waitSeconds || 0)}</span>
        <span id="continueLabel" hidden>Continue</span>
      </button>
      <p id="status" class="status" role="status" hidden></p>
    </section>
  </main>
  <script>
    const pageData = ${safeScriptJson({ requestId: pause.id, returnUrl: pause.returnUrl, waitSeconds: Math.max(0, data.waitSeconds || 0) })};
    const countdown = document.querySelector("#countdown");
    const continueLabel = document.querySelector("#continueLabel");
    const continueButton = document.querySelector("#continue");
    const breathLine = document.querySelector("#breathLine");
    const status = document.querySelector("#status");
    let remaining = pageData.waitSeconds || 0;

    const countdownInterval = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      countdown.textContent = String(remaining);
      if (remaining <= 0) {
        finishTimer();
      }
    }, 1000);
    if (remaining <= 0) {
      finishTimer();
    }

    continueButton.addEventListener("click", async () => {
      continueButton.disabled = true;
      try {
        const result = await postJson("/api/intentional-use/pause/continue", {
          requestId: pageData.requestId,
          intention: "",
          mood: ""
        });
        if (result.returnUrl) {
          location.href = result.returnUrl;
        } else if (result.launch?.ok) {
          location.href = "http://127.0.0.1:${port}";
        } else {
          location.href = "http://127.0.0.1:${port}";
        }
      } catch (error) {
        status.textContent = error.message;
        status.hidden = false;
        continueButton.disabled = false;
      }
    });

    function finishTimer() {
      clearInterval(countdownInterval);
      breathLine.classList.add("complete");
      countdown.hidden = true;
      continueLabel.hidden = false;
      continueButton.classList.add("ready");
      continueButton.setAttribute("aria-label", "Continue");
      continueButton.disabled = false;
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "${CONTROL_INTENT_HEADER}": "${CONTROL_INTENT_VALUE}" },
        body: JSON.stringify(body)
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Request failed");
      return json;
    }
  </script>
</body>
</html>`;
}

function activePausePageCss() {
  return `
    :root {
      color-scheme: dark;
      --paper: #101111;
      --paper-2: #161717;
      --ink: #f0ece5;
      --muted: #aaa398;
      --primary: #b77952;
      --primary-strong: #d5a16b;
      --focus: rgba(213, 161, 107, .28);
      --edge: clamp(22px, 4vh, 42px);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { min-width: 0; min-height: 100%; background: var(--paper); }
    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      color: var(--ink);
      background:
        radial-gradient(circle at 78% -8%, rgba(183, 121, 82, .08), transparent 34rem),
        radial-gradient(circle at 28% 106%, rgba(157, 124, 88, .04), transparent 30rem),
        linear-gradient(180deg, var(--paper), var(--paper-2));
      font-family: Inter, "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button { font: inherit; }
    .pause-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
    }
    .pause-content {
      position: relative;
      z-index: 1;
      width: min(620px, 100%);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 30px;
    }
    .prompt {
      max-width: 13ch;
      margin: 0;
      color: var(--ink);
      font: 700 clamp(2.75rem, 7vw, 5rem)/.98 Georgia, "Times New Roman", serif;
      letter-spacing: -.04em;
      text-wrap: balance;
    }
    .breath-line {
      position: fixed;
      z-index: 0;
      right: clamp(14px, 1.6vw, 26px);
      bottom: var(--edge);
      left: clamp(14px, 1.6vw, 26px);
      height: 4px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(213, 161, 107, .48), var(--primary-strong) 8%, var(--primary-strong) 92%, rgba(213, 161, 107, .48));
      box-shadow:
        0 0 0 1px rgba(213, 161, 107, .08),
        0 0 30px rgba(183, 121, 82, .18);
      animation: breath-line 6s cubic-bezier(.65, 0, .35, 1) infinite;
      will-change: transform;
    }
    .breath-line.complete {
      opacity: 0;
      animation-play-state: paused;
      transition: opacity .35s ease;
    }
    .countdown-control {
      width: 76px;
      min-width: 76px;
      height: 76px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(213, 161, 107, .52);
      border-radius: 999px;
      padding: 0;
      color: var(--ink);
      background: radial-gradient(circle, rgba(183, 121, 82, .17), rgba(31, 31, 29, .94) 72%);
      box-shadow: 0 0 38px rgba(183, 121, 82, .09);
      font-weight: 720;
      cursor: wait;
      opacity: 1;
      transition: width .28s ease, min-width .28s ease, height .28s ease, border-radius .28s ease, color .2s ease, background .2s ease, transform .16s ease;
    }
    .countdown-control #countdown {
      font-size: 1.75rem;
      line-height: 1;
      letter-spacing: -.05em;
    }
    .countdown-control.ready {
      width: 156px;
      min-width: 156px;
      height: 48px;
      border-color: var(--primary);
      border-radius: 7px;
      color: #16120f;
      background: var(--primary);
      cursor: pointer;
    }
    .countdown-control.ready:hover {
      background: var(--primary-strong);
      transform: translateY(-1px);
    }
    .countdown-control:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
    }
    .status {
      max-width: 34ch;
      margin: -12px 0 0;
      color: var(--muted);
      font-size: .78rem;
      line-height: 1.5;
    }
    @keyframes breath-line {
      0%, 100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(calc(-100vh + var(--edge) + var(--edge) + 4px));
      }
    }
    @media (max-width: 520px) {
      .pause-shell { place-items: start; padding: 64px 24px; }
      .pause-content { gap: 24px; }
      .prompt { font-size: clamp(2.5rem, 12vw, 3.6rem); }
    }
    @media (prefers-reduced-motion: reduce) {
      .countdown-control, .breath-line { transition: none; }
      .breath-line { animation: none; }
    }
  `;
}

function pausePageCss() {
  return `
    :root {
      color-scheme: dark;
      --paper: #101111;
      --surface-strong: #222321;
      --ink: #f0ece5;
      --muted: #aaa398;
      --line: #353532;
      --line-strong: #575248;
      --primary: #b77952;
      --primary-strong: #d5a16b;
      --accent-soft: rgba(183, 121, 82, .12);
      --focus: rgba(213, 161, 107, .24);
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--paper); }
    body {
      margin: 0;
      min-height: 100vh;
      padding: clamp(20px, 4vw, 52px);
      color: var(--ink);
      background:
        radial-gradient(circle at 72% 0%, rgba(183, 121, 82, .055), transparent 28rem),
        linear-gradient(180deg, var(--paper), #131414);
      font-family: Inter, "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select { font: inherit; }
    button, .button {
      min-height: 44px;
      display: inline-grid;
      place-items: center;
      border: 1px solid transparent;
      border-radius: 9px;
      padding: 0 16px;
      font-weight: 760;
      cursor: pointer;
      text-decoration: none;
      transition: transform .16s ease, border-color .16s ease, background .16s ease, color .16s ease;
    }
    button:hover:not(:disabled), .button:hover { transform: translateY(-1px); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button:focus-visible, .button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .breath-guide {
      position: fixed;
      z-index: 0;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .breath-wave {
      position: absolute;
      top: 100%;
      right: 0;
      left: 0;
      height: 100%;
      border-top: 1px solid rgba(213, 161, 107, .46);
      background: linear-gradient(180deg, rgba(183, 121, 82, .08), rgba(183, 121, 82, .015) 42%, transparent);
      box-shadow: 0 -14px 62px rgba(183, 121, 82, .12);
      animation: breath-rise 6s cubic-bezier(.45, 0, .55, 1) infinite;
      transition: opacity .6s ease;
      will-change: transform;
    }
    .breath-guide.complete .breath-wave {
      opacity: 0;
      animation-play-state: paused;
    }
    .pause-shell, .expired-shell { position: relative; z-index: 1; }
    .pause-shell { width: min(620px, 100%); margin: 0 auto; }
    .expired-shell {
      width: min(560px, 100%);
      min-height: calc(100vh - clamp(40px, 8vw, 104px));
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      margin: 0 auto;
    }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: clamp(44px, 8vw, 72px);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: .92rem;
      font-weight: 780;
      letter-spacing: -.02em;
    }
    .brand-mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(213, 161, 107, .46);
      border-radius: 9px;
      color: var(--primary-strong);
      background: var(--accent-soft);
      font-size: .76rem;
      font-weight: 850;
    }
    .feature-pill {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 12px;
      color: var(--muted);
      background: rgba(34, 35, 33, .72);
      font-size: .74rem;
      font-weight: 700;
    }
    .eyebrow {
      margin: 0 0 10px;
      color: var(--primary-strong);
      font: 800 .7rem "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    h1 {
      margin: 0;
      font-size: clamp(2.35rem, 7vw, 3.6rem);
      font-weight: 680;
      line-height: .98;
      letter-spacing: -.055em;
      text-wrap: balance;
    }
    h1 span { color: var(--primary-strong); }
    .lead {
      max-width: 620px;
      margin: 12px 0 0;
      color: var(--muted);
      font-size: .94rem;
      line-height: 1.55;
    }
    .timer {
      width: 62px;
      height: 62px;
      flex: 0 0 62px;
      display: grid;
      align-content: center;
      justify-items: center;
      border: 1px solid rgba(213, 161, 107, .42);
      border-radius: 50%;
      background: radial-gradient(circle, rgba(183, 121, 82, .12), rgba(34, 35, 33, .72) 68%);
    }
    .timer strong {
      color: var(--ink);
      font-size: 1.45rem;
      font-weight: 680;
      line-height: 1;
      letter-spacing: -.06em;
    }
    .timer span {
      margin-top: 3px;
      color: var(--muted);
      font-size: .57rem;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .intent-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 176px;
      gap: 7px 12px;
      margin-top: 34px;
    }
    label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0;
      color: var(--ink);
      font-size: .76rem;
      font-weight: 700;
    }
    .optional { color: var(--muted); font-size: .68rem; font-weight: 600; }
    .intent-fields label[for="intention"] { grid-column: 1; grid-row: 1; }
    .intent-fields #intention { grid-column: 1; grid-row: 2; }
    .intent-fields label[for="mood"] { grid-column: 2; grid-row: 1; }
    .intent-fields #mood { grid-column: 2; grid-row: 2; }
    input, select {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 9px 11px;
      outline: none;
      color: var(--ink);
      background: var(--surface-strong);
    }
    input::placeholder { color: #77736c; }
    input:focus-visible, select:focus-visible { border-color: var(--primary); }
    .alternatives {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
    }
    .alternatives > p {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: .73rem;
      font-weight: 650;
    }
    .choices {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .choice {
      width: auto;
      min-height: 34px;
      justify-content: start;
      border-color: var(--line);
      border-radius: 999px;
      padding: 0 10px;
      color: var(--ink);
      background: rgba(34, 35, 33, .68);
      font-size: .7rem;
      font-weight: 660;
      text-align: left;
    }
    .choice:hover:not(:disabled) {
      border-color: var(--line-strong);
      background: var(--surface-strong);
    }
    .choice.selected {
      border-color: var(--primary);
      color: #f7e8d8;
      background: var(--accent-soft);
    }
    .meta-line {
      margin: 22px 0 0;
      color: var(--muted);
      font-size: .69rem;
      line-height: 1.5;
    }
    .meta-line span { margin: 0 5px; color: var(--line-strong); }
    .actions {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 9px;
      margin-top: 18px;
    }
    .primary {
      border-color: var(--primary);
      color: #17130f;
      background: var(--primary);
    }
    .primary:hover:not(:disabled), .button.primary:hover { background: var(--primary-strong); }
    .secondary, .button {
      border-color: var(--line);
      color: var(--ink);
      background: var(--surface-strong);
    }
    .status {
      min-height: 20px;
      margin: 10px 0 0;
      color: var(--muted);
      font-size: .7rem;
      line-height: 1.45;
    }
    .expired-shell .brand { margin-bottom: 64px; }
    .expired-shell h1 { max-width: 11ch; font-size: clamp(2.5rem, 8vw, 4.9rem); }
    .expired-shell .button { margin-top: 24px; }
    @keyframes breath-rise {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-100%); }
    }
    @media (max-width: 520px) {
      body { padding: 22px 18px 32px; }
      .page-header { margin-bottom: 38px; }
      .intent-fields { grid-template-columns: 1fr; }
      .intent-fields label[for="intention"],
      .intent-fields #intention,
      .intent-fields label[for="mood"],
      .intent-fields #mood { grid-column: 1; grid-row: auto; }
      .intent-fields label[for="mood"] { margin-top: 8px; }
      .actions { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      button, .button { transition: none; }
      .breath-guide { display: none; }
    }
  `;
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

function safePageNavigationUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !isLocalPageHost(url.hostname) ? url.toString() : "";
  } catch {
    return "";
  }
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
  });
  if (policy || safariFilterDenyMatch(state, parsed)) return "";
  return parsed.toString();
}

function isLocalPageHost(hostname: unknown): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase());
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
