import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../apiSecurity.js";
import { PORT } from "../defaults.js";
import { emergencyUnlockAllowedForPolicy, activePolicy } from "../policy.js";
import { intentReasonPolicy } from "../intentReason.js";
import { interventionSummary } from "../intervention.js";
import { pausePageData } from "../intentionalUse.js";

export function blockedPage({ url, state, port = PORT }) {
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
  const interventionClass = escapeHtml(intervention.level);
  const interventionCopy = escapeHtml(intervention.message);
  const interventionTargets = escapeHtml(intervention.topTargets.map((target) => `${target.label} x${target.count}`).join(" | ") || "No recent targets");
  const pageData = {
    site: url.searchParams.get("site") || "",
    kind: url.searchParams.get("kind") || "manual",
    lockId: url.searchParams.get("lockId") || "",
    returnUrl: url.searchParams.get("return") || "",
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
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17201d; background: #f4f2ec; }
    main { width: min(560px, calc(100vw - 32px)); }
    h1 { font-size: 3.5rem; line-height: .94; margin: 0 0 18px; letter-spacing: 0; }
    p { font-size: 1.05rem; line-height: 1.55; color: #4b5753; margin: 0 0 14px; }
    a { color: #126a6f; font-weight: 700; }
    .meta { margin-top: 24px; padding-top: 18px; border-top: 1px solid #d8d3c6; color: #6c746f; }
    .break-panel { margin-top: 28px; padding-top: 22px; border-top: 1px solid #d8d3c6; display: grid; gap: 12px; }
    .break-panel h2 { margin: 0; font-size: 1.05rem; letter-spacing: 0; }
    .break-panel input { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c9c2b5; border-radius: 6px; padding: 0 12px; background: #fffcf4; color: #17201d; font: inherit; }
    .challenge { display: none; border: 1px dashed #b69a5b; border-radius: 6px; background: #fff4d2; color: #4a3510; padding: 10px 12px; font-weight: 900; overflow-wrap: anywhere; }
    .break-actions, .distance-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .distance-row input { flex: 1 1 220px; }
    button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 16px; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .52; }
    .primary { color: #fffdf6; background: #126a6f; }
    .secondary { color: #17201d; background: #ded8ca; }
    .status { min-height: 22px; color: #5c6762; font-size: .94rem; }
    .intervention { margin-top: 18px; border: 1px solid #d8d3c6; border-radius: 8px; background: #fffcf4; padding: 12px; }
    .intervention strong { display: block; margin-bottom: 5px; }
    .intervention span { display: block; color: #5c6762; font-size: .94rem; overflow-wrap: anywhere; }
    .intervention.elevated { border-color: #d7a63b; background: #fff5d7; }
    .intervention.high { border-color: #c7472f; background: #f9ddd7; }
    @media (max-width: 620px) { h1 { font-size: 2.3rem; } }
  </style>
</head>
<body>
  <main>
    <h1>${site} is blocked.</h1>
    <p>The ${mode} lock is active. The useful move is to close this tab and go back to the thing you chose before impulse got loud.</p>
    <div class="intervention ${interventionClass}">
      <strong>Adaptive friction</strong>
      <span>${interventionCopy}</span>
      <span>${interventionTargets}</span>
    </div>
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
    <p class="meta">Locked until ${until || "the session ends"}. Sentinel: <a href="http://127.0.0.1:${port}">open app</a></p>
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
    let scanStream = null;

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

export function pausePage({ url, state, port = PORT }) {
  const requestId = url.searchParams.get("requestId") || "";
  const data = pausePageData(state, requestId);
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
    <p class="eyebrow">Sentinel</p>
    <h1>Pause expired.</h1>
    <p>This intentional-use pause is no longer active. Open Sentinel or try the site again if you still mean it.</p>
    <a class="button" href="http://127.0.0.1:${port}">Open Sentinel</a>
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
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #15201c; background: #f5f1e8; }
    main { width: min(760px, calc(100vw - 32px)); padding: 44px 0; }
    h1 { margin: 0 0 12px; font-size: 3rem; line-height: .98; letter-spacing: 0; }
    h2 { margin: 0 0 10px; font-size: .95rem; letter-spacing: 0; }
    p { color: #53605b; line-height: 1.55; }
    .eyebrow { margin: 0 0 8px; color: #126a6f; font-weight: 900; text-transform: uppercase; letter-spacing: .12em; font-size: .72rem; }
    .lead { max-width: 620px; margin-bottom: 22px; }
    .timer { width: 156px; height: 156px; border-radius: 50%; border: 8px solid #126a6f; display: grid; place-items: center; margin: 16px 0 22px; background: #fffcf4; }
    .timer strong { display: block; font-size: 3rem; line-height: 1; text-align: center; }
    .timer span { display: block; color: #6a746f; font-weight: 800; font-size: .78rem; text-transform: uppercase; letter-spacing: .1em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    section { border-top: 1px solid #d9d0bf; padding-top: 14px; }
    input, select { box-sizing: border-box; width: 100%; min-height: 46px; border: 1px solid #c8c0b2; border-radius: 6px; padding: 0 12px; background: #fffcf4; color: inherit; font: inherit; margin-bottom: 10px; }
    button, .button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 15px; font: inherit; font-weight: 900; cursor: pointer; text-decoration: none; display: inline-grid; place-items: center; }
    button:disabled { opacity: .52; cursor: not-allowed; }
    .primary { color: #fffdf6; background: #126a6f; }
    .secondary, .choice, .button { color: #17201d; background: #ded7c9; }
    .choices { display: grid; gap: 8px; }
    .choice { justify-content: start; text-align: left; }
    .choice.selected { background: #d6eadc; outline: 2px solid #28734f; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .meta span { border: 1px solid #d5ccb9; border-radius: 999px; padding: 7px 10px; color: #53605b; background: #fffcf4; font-size: .88rem; }
    .status { min-height: 24px; margin-top: 14px; }
    @media (max-width: 680px) { h1 { font-size: 2.2rem; } .grid { grid-template-columns: 1fr; } .timer { width: 128px; height: 128px; } }
  `;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

export function safeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026"
  })[char]);
}

export function commitmentLockError(policy) {
  if (policy?.kind === "integrity") {
    return "Integrity lockdown cannot be ended with an emergency unlock. Open a protected maintenance window after checking the alarm.";
  }
  if (policy?.kind === "panic") {
    return "Panic lockout cannot be ended early.";
  }
  return "This commitment lock does not allow emergency unlocks. Open a protected maintenance window if this was a mistake.";
}
