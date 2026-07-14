import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../apiSecurity.js";
import { PORT } from "../defaults.js";
import { emergencyUnlockAllowedForPolicy, activePolicy } from "../policy.js";
import { intentReasonPolicy } from "../intentReason.js";
import { interventionSummary } from "../intervention.js";
import { pausePageData } from "../intentionalUse.js";
import type { ActivePolicy, VigilState } from "../types.js";

interface PageInput {
  url: URL;
  state: VigilState;
  port?: number;
}

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

export function blockedPage({ url }: PageInput): string {
  const site = escapeHtml(url.searchParams.get("site") || "This target");
  const backUrl = safePageNavigationUrl(url.searchParams.get("back"));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked</title>
  <style>
    :root { color-scheme: light; --paper: #eee8dc; --paper-2: #e2d8c6; --ink: #261f1a; --primary: #385b68; --primary-strong: #243f4a; --focus: rgba(181, 139, 60, .25); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; color: var(--ink); background: radial-gradient(circle at 78% -8%, rgba(181, 139, 60, .16), transparent 32rem), linear-gradient(180deg, var(--paper), var(--paper-2)); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, 100%); }
    h1 { max-width: 12ch; margin: 0; font: 700 clamp(2.75rem, 8vw, 5rem)/.98 Georgia, "Times New Roman", serif; letter-spacing: -.04em; text-wrap: balance; }
    .escape-actions { margin-top: 32px; }
    .escape-actions a { min-height: 48px; display: inline-grid; place-items: center; padding: 0 22px; border-radius: 7px; color: #fffdf7; background: var(--primary); text-decoration: none; font-weight: 700; transition: background .15s ease, transform .15s ease; }
    .escape-actions a:hover { background: var(--primary-strong); }
    .escape-actions a:active { transform: translateY(1px); }
    .escape-actions a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    @media (max-width: 520px) { body { place-items: start; padding: 64px 24px; } }
  </style>
</head>
<body>
  <main>
    <h1>${site} is blocked.</h1>
    <div class="escape-actions">
      <a id="leaveBlockedPage" href="${escapeHtml(backUrl || "#")}">Go back</a>
    </div>
  </main>
  <script>
    const explicitBackUrl = ${safeScriptJson(backUrl)};
    const leaveBlockedPage = document.querySelector("#leaveBlockedPage");
    const escapeTarget = blockedEscapeTarget();
    if (leaveBlockedPage) {
      if (escapeTarget) leaveBlockedPage.href = escapeTarget;
      leaveBlockedPage.addEventListener("click", (event) => {
        event.preventDefault();
        if (escapeTarget) location.replace(escapeTarget);
        else history.go(-2);
      });
    }

    function blockedEscapeTarget() {
      return safeNavigationUrl(explicitBackUrl) || safeNavigationUrl(document.referrer);
    }

    function safeNavigationUrl(value) {
      try {
        const candidate = new URL(String(value || ""), location.href);
        if (!["http:", "https:"].includes(candidate.protocol)) return "";
        if (["127.0.0.1", "localhost", "::1"].includes(candidate.hostname)) return "";
        return candidate.toString();
      } catch {
        return "";
      }
    }
  </script>
</body>
</html>`;
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
    .challenge { display: none; border: 1px dashed #9d7a37; border-radius: 3px; background: #211a0e; color: var(--gold-soft); padding: 10px 12px; font: 800 .9rem ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .break-actions, .distance-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .distance-row input { flex: 1 1 220px; }
    button { min-height: 44px; border: 1px solid transparent; border-radius: 3px; padding: 0 16px; font: 800 .82rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .05em; cursor: pointer; box-shadow: 3px 3px 0 #04060a; }
    button:disabled { cursor: not-allowed; opacity: .52; }
    .primary { color: #100d08; background: var(--gold); border-color: #f0d580; }
    .secondary { color: #e7e5dd; background: #1b2737; border-color: #43536a; }
    .escape-actions { display: none; margin-top: 22px; }
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
      <a id="leaveBlockedPage" href="${escapeHtml(backUrl || "#")}">Go back</a>
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
      <code id="breakChallenge" class="challenge"></code>
      <input id="breakChallengeInput" type="text" autocomplete="off" placeholder="Typing challenge" style="display:none">
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
    if (escapeActions && leaveBlockedPage && (escapeTarget || history.length > 1)) {
      escapeActions.style.display = "flex";
      if (escapeTarget) leaveBlockedPage.href = escapeTarget;
      leaveBlockedPage.addEventListener("click", (event) => {
        event.preventDefault();
        if (escapeTarget) {
          location.replace(escapeTarget);
        } else {
          history.go(-2);
        }
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
        video.style.width = "100%";
        video.style.borderRadius = "8px";
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
      return safeNavigationTarget(pageData.backUrl) || safeNavigationTarget(document.referrer);
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
        challenge.style.display = "block";
        challengeInput.style.display = "block";
        challenge.textContent = "Type: " + pending.challenge.text;
      } else {
        challenge.style.display = "none";
        challengeInput.style.display = "none";
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
  <title>Pause expired</title>
  <style>${pausePageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Vigil</p>
    <h1>Pause expired.</h1>
    <p>This intentional-use pause is no longer active. Open Vigil or try the site again if you still mean it.</p>
    <a class="button" href="http://127.0.0.1:${port}">Open Vigil</a>
  </main>
</body>
</html>`;
  }

  const pause = data.pause;
  const goal = data.goal || {};
  const budget = data.budget || {};
  const context = data.context || {};
  const replacements = (data.replacements || []).slice(0, 6);
  const budgetText = budget.budgetSeconds
    ? `${Math.round((budget.seconds || 0) / 60)} of ${Math.round(budget.budgetSeconds / 60)} min used today`
    : "No daily budget set";
  const buttons = replacements
    .map((item) => `<button class="choice" type="button" data-replacement="${escapeHtml(item)}">${escapeHtml(item)}</button>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intentional Use</title>
  <style>${pausePageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Intentional Use</p>
    <h1>Before ${escapeHtml(pause.targetLabel)}.</h1>
    <p class="lead">${escapeHtml(goal.statement || "Use screens on purpose, not by reflex.")}</p>
    <blockquote>“The measure of love is to love without measure.”<cite>Saint Augustine</cite></blockquote>
    <div class="timer">
      <strong id="countdown">${Math.max(0, data.waitSeconds || 0)}</strong>
      <span>slow seconds</span>
    </div>
    <div class="grid">
      <section>
        <h2>Use this for</h2>
        <input id="intention" type="text" autocomplete="off" placeholder="One clear reason">
        <select id="mood">
          <option value="">Current state</option>
          <option>Focused</option>
          <option>Bored</option>
          <option>Tired</option>
          <option>Anxious</option>
          <option>Avoiding something</option>
        </select>
      </section>
      <section>
        <h2>Or switch to</h2>
        <div class="choices">${buttons || '<button class="choice" type="button" data-replacement="Close this tab">Close this tab</button>'}</div>
      </section>
    </div>
    <div class="meta">
      <span>${escapeHtml(pause.ruleName)}</span>
      <span>${escapeHtml(budgetText)}</span>
      <span>${escapeHtml(context.message || "Normal pause")}</span>
    </div>
    <div class="actions">
      <button id="skip" class="secondary" type="button">Use replacement</button>
      <button id="continue" class="primary" type="button" disabled>Continue for ${Math.round(pause.sessionMinutes || 10)} min</button>
    </div>
    <p id="status" class="status">Breathe first. The continue button will unlock when the timer reaches zero.</p>
  </main>
  <script>
    const pageData = ${safeScriptJson({ requestId: pause.id, returnUrl: pause.returnUrl, waitSeconds: Math.max(0, data.waitSeconds || 0) })};
    const countdown = document.querySelector("#countdown");
    const continueButton = document.querySelector("#continue");
    const skipButton = document.querySelector("#skip");
    const status = document.querySelector("#status");
    const intention = document.querySelector("#intention");
    const mood = document.querySelector("#mood");
    let selectedReplacement = "";
    let remaining = pageData.waitSeconds || 0;

    document.querySelectorAll(".choice").forEach((button) => {
      button.addEventListener("click", () => {
        selectedReplacement = button.dataset.replacement || button.textContent;
        document.querySelectorAll(".choice").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        status.textContent = "Replacement selected.";
      });
    });

    const timer = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      countdown.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        continueButton.disabled = false;
        status.textContent = "Ready. Continue only if this still matches the reason you wrote.";
      }
    }, 1000);
    if (remaining <= 0) continueButton.disabled = false;

    continueButton.addEventListener("click", async () => {
      continueButton.disabled = true;
      try {
        const result = await postJson("/api/intentional-use/pause/continue", {
          requestId: pageData.requestId,
          intention: intention.value,
          mood: mood.value
        });
        status.textContent = "Intentional window opened.";
        if (result.returnUrl) {
          setTimeout(() => { location.href = result.returnUrl; }, 350);
        } else if (result.launch?.ok) {
          status.textContent = "Intentional window opened in " + (result.pause?.app || result.pause?.targetLabel || "the app") + ".";
        } else {
          setTimeout(() => { location.href = "http://127.0.0.1:${port}"; }, 350);
        }
      } catch (error) {
        status.textContent = error.message;
        continueButton.disabled = false;
      }
    });

    skipButton.addEventListener("click", async () => {
      skipButton.disabled = true;
      try {
        await postJson("/api/intentional-use/pause/skip", {
          requestId: pageData.requestId,
          replacement: selectedReplacement || "Closed the loop",
          mood: mood.value
        });
        status.textContent = "Nice. Keep the replacement small and concrete.";
      } catch (error) {
        status.textContent = error.message;
        skipButton.disabled = false;
      }
    });

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

function pausePageCss() {
  return `
    :root { color-scheme: dark; --ink: #f1eee4; --muted: #aeb3af; --gold: #d1a94d; --gold-soft: #f1d98f; --line: #5f4b2d; --panel: #101927; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Georgia, "Times New Roman", serif; color: var(--ink); background: radial-gradient(circle at 50% 18%, #18345b 0, #0a111d 44%, #05080e 100%); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .2; background-image: linear-gradient(90deg, transparent 49%, #d1a94d22 50%, transparent 51%), linear-gradient(transparent 49%, #d1a94d12 50%, transparent 51%); background-size: 48px 48px; }
    main { position: relative; width: min(760px, calc(100vw - 32px)); margin: 32px 0; padding: 34px; border: 1px solid var(--line); border-radius: 6px; background: linear-gradient(145deg, #142238f7, #0b121df7); box-shadow: 0 24px 80px #000b, inset 0 0 0 3px #080d15, inset 0 0 0 4px #6f5529; }
    main::before { content: "✠"; float: right; display: grid; place-items: center; width: 42px; height: 42px; margin-left: 20px; border: 1px solid #8b6c34; color: var(--gold); background: #0a111c; font-size: 1.45rem; box-shadow: 4px 4px 0 #04070c; }
    h1 { margin: 0 0 12px; font-size: clamp(2.25rem, 7vw, 3.75rem); line-height: .98; letter-spacing: -.035em; }
    h2 { margin: 0 0 10px; color: #e8e3d5; font: 800 .8rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
    p { color: var(--muted); line-height: 1.55; }
    .eyebrow { margin: 0 0 8px; color: var(--gold); font: 900 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .14em; }
    .lead { max-width: 620px; margin-bottom: 14px; }
    blockquote { max-width: 610px; margin: 16px 0 24px; padding: 12px 15px; border-left: 3px solid var(--gold); background: #080d15a8; color: #d8d5ca; font-style: italic; line-height: 1.45; }
    blockquote cite { display: block; margin-top: 6px; color: #979e9a; font-size: .8rem; font-style: normal; }
    .timer { width: 156px; height: 156px; border: 6px solid var(--gold); border-radius: 5px; display: grid; place-items: center; margin: 16px 0 24px; background: radial-gradient(circle, #172b48, #090f19); box-shadow: 5px 5px 0 #04070c, inset 0 0 0 3px #6a5128; }
    .timer strong { display: block; color: var(--gold-soft); font: 800 3rem ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1; text-align: center; }
    .timer span { display: block; color: #aeb3af; font: 800 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .1em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    section { border-top: 1px solid #4d402d; padding-top: 14px; }
    input, select { width: 100%; min-height: 46px; border: 1px solid #554b3b; border-radius: 3px; padding: 0 12px; background: #080e17; color: var(--ink); font: 500 .94rem ui-sans-serif, system-ui, sans-serif; margin-bottom: 10px; }
    input:focus, select:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
    button, .button { min-height: 44px; border: 1px solid transparent; border-radius: 3px; padding: 0 15px; color: inherit; font: 900 .79rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; text-decoration: none; display: inline-grid; place-items: center; box-shadow: 3px 3px 0 #04070c; }
    button:disabled { opacity: .52; cursor: not-allowed; }
    .primary { color: #120e07; background: var(--gold); border-color: #efd47f; }
    .secondary, .choice, .button { color: #e6e3da; background: #1b293c; border-color: #40536d; }
    .choices { display: grid; gap: 8px; }
    .choice { justify-content: start; text-align: left; }
    .choice.selected { color: #fff0b3; background: #3a2d16; border-color: var(--gold); outline: 1px solid var(--gold); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .meta span { border: 1px solid #4d4436; border-radius: 3px; padding: 7px 10px; color: #aeb3af; background: #090f18; font: .78rem ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status { min-height: 24px; margin-top: 14px; color: #aeb3af; }
    @media (max-width: 680px) { main { padding: 25px 20px; } h1 { font-size: 2.25rem; } .grid { grid-template-columns: 1fr; } .timer { width: 128px; height: 128px; } }
    @media (prefers-reduced-motion: no-preference) { main::before { animation: vigil-cross 3s steps(2, end) infinite; } @keyframes vigil-cross { 50% { color: #fff0ad; transform: translateY(-2px); } } }
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
