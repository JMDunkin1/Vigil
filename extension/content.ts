let lastPulseAt = Date.now();
let pulseGeneration = 0;
let activePauseOverlay: PauseOverlayState | null = null;
let mediaLockActive = false;
let pageGuardActive = false;
let pageGuardReleaseTimer: number | null = null;
let pageGuardPreviousVisibility: { value: string; priority: string } | null = null;
let youtubeAutofillFrictionEnabled = false;
let youtubeAutofillFrictionAttached = false;
let focusedSocialCleanupEnabled = false;
let focusedSocialCleanupAttached = false;
let focusedSocialCleanupSignature = "";
let focusedSocialCleanupObserver: MutationObserver | null = null;
let focusedSocialCleanupTimer: number | null = null;
let matureContentInterlockAttached = false;
let matureContentScanInProgress = false;
let matureContentObserver: MutationObserver | null = null;
const YOUTUBE_AUTOFILL_PREVIOUS_ABSENT = "__vigil_absent__";
const pausedByVigil = new Set<HTMLMediaElement>();

type MaturePlatform = "reddit" | "x";

type PulseReason = "navigation" | "heartbeat" | "activated" | "history";
type HistoryMethod = "pushState" | "replaceState";

interface PulseResponse {
  ok?: boolean;
  skipped?: boolean;
  stale?: boolean;
  blocked?: boolean;
  paused?: boolean;
  redirectUrl?: string;
  browserNoiseBlockingEnabled?: boolean;
  focusedSocialCleanupEnabled?: boolean;
  focusedSocialCleanupSettings?: unknown;
  offline?: boolean;
}

interface InstagramCleanupSettings {
  enabled: boolean;
  reels: boolean;
  explore: boolean;
  suggested: boolean;
  shopping: boolean;
  ads: boolean;
}

interface YoutubeCleanupSettings {
  enabled: boolean;
  shorts: boolean;
  home: boolean;
  explore: boolean;
  suggested: boolean;
  ads: boolean;
}

interface SnapchatCleanupSettings {
  enabled: boolean;
  spotlight: boolean;
  stories: boolean;
}

interface FocusedSocialCleanupSettings {
  enabled: boolean;
  instagram: InstagramCleanupSettings;
  youtube: YoutubeCleanupSettings;
  snapchat: SnapchatCleanupSettings;
}

interface PauseOverlayDecision {
  requestId: string;
  targetLabel: string;
  ruleName: string;
  waitSeconds: number;
  sessionMinutes: number;
  goalStatement: string;
  replacements: string[];
  budgetText: string;
  contextMessage: string;
}

interface PauseOverlayState {
  host: HTMLElement;
  requestId: string;
  timer: number | null;
}

interface PauseMessage {
  type?: string;
  expectedUrl?: string;
  result?: unknown;
}

interface PulseOptions {
  guard?: boolean;
}

interface PauseActionMessage {
  type: "VIGIL_PAUSE_ACTION";
  action: "continue" | "skip";
  requestId: string;
  intention?: string;
  mood?: string;
  replacement?: string;
}

let focusedSocialCleanupSettings = defaultFocusedSocialCleanupSettings();

activatePageGuard();
applyAlwaysOnMatureContentRestrictions();
applyAlwaysOnYoutubeRestrictions();
sendPulse("navigation", { guard: true });
setInterval(() => {
  applyAlwaysOnMatureContentRestrictions();
  applyAlwaysOnYoutubeRestrictions();
  sendPulse("heartbeat");
}, 5000);
window.addEventListener("focus", () => resetAndPulse("activated"));
window.addEventListener("pageshow", () => resetAndPulse("activated", { guard: true }));
window.addEventListener("popstate", () => resetAndPulse("history", { guard: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resetAndPulse("activated", { guard: true });
});
document.addEventListener("play", pausePlayingMedia, true);
document.addEventListener("keydown", trapPageKeys, true);

chrome.runtime.onMessage.addListener((message: PauseMessage, _sender, sendResponse: (response?: unknown) => void) => {
  if (message?.type !== "VIGIL_SHOW_PAUSE") return false;
  if (message.expectedUrl && message.expectedUrl !== location.href) {
    sendResponse({ ok: false, stale: true });
    return false;
  }
  sendResponse({ ok: showPauseOverlay(message.result) });
  return false;
});

patchHistory("pushState");
patchHistory("replaceState");

function resetAndPulse(reason: PulseReason, options: PulseOptions = {}): void {
  lastPulseAt = Date.now();
  applyAlwaysOnMatureContentRestrictions();
  sendPulse(reason, options);
}

function sendPulse(reason: PulseReason, options: PulseOptions = {}): void {
  if (document.visibilityState !== "visible") return;
  if (!options.guard && !document.hasFocus()) return;
  if (options.guard) activatePageGuard();
  const generation = ++pulseGeneration;
  const now = Date.now();
  const seconds = Math.max(1, Math.min(15, (now - lastPulseAt) / 1000));
  lastPulseAt = now;
  try {
    chrome.runtime.sendMessage({
      type: "VIGIL_PULSE",
      url: location.href,
      title: document.title,
      reason,
      seconds
    }, (result: PulseResponse | undefined) => {
      void chrome.runtime.lastError;
      if (generation !== pulseGeneration) return;
      handlePulseResult(result);
    });
  } catch {
    if (generation === pulseGeneration && !activePauseOverlay) releasePageGuard();
  }
}

function handlePulseResult(result: PulseResponse | undefined): void {
  if (!result) {
    if (!activePauseOverlay) releasePageGuard();
    return;
  }
  if (result.stale === true || result.skipped === true) {
    // sendPulse already rejects callbacks from an older content-script pulse.
    // A stale background check therefore cannot authorize or block this page,
    // but it also must not strand the current page behind the navigation guard.
    if (!activePauseOverlay) releasePageGuard();
    return;
  }
  if (result.browserNoiseBlockingEnabled === true) {
    cleanupBrowserNoise();
  } else if (result.browserNoiseBlockingEnabled === false) {
    teardownYoutubeAutofillFriction();
  }
  if (result.focusedSocialCleanupEnabled === true) {
    applyFocusedSocialCleanup(result.focusedSocialCleanupSettings);
  } else if (result.focusedSocialCleanupEnabled === false) {
    teardownFocusedSocialCleanup();
  }
  if (result.offline === true || result.ok === false) {
    if (!activePauseOverlay) releasePageGuard();
    return;
  }
  if (result?.blocked && result.redirectUrl) {
    replaceLocation(result.redirectUrl);
    return;
  }
  if (result?.paused) {
    if (!showPauseOverlay(result) && result.redirectUrl) {
      replaceLocation(result.redirectUrl);
    }
    return;
  }
  releasePageGuard();
}

function patchHistory(method: HistoryMethod): void {
  const original = history[method].bind(history) as (data: unknown, unused: string, url?: string | URL | null) => void;
  history[method] = function patchedHistoryMethod(data: unknown, unused: string, url?: string | URL | null): void {
    const result = original(data, unused, url);
    applyAlwaysOnMatureContentRestrictions();
    setTimeout(() => resetAndPulse("history"), 0);
    return result;
  } as History[HistoryMethod];
}

function showPauseOverlay(value: unknown): boolean {
  const decision = pauseDecision(value);
  if (!decision) return false;
  if (activePauseOverlay?.requestId === decision.requestId) return true;

  removePauseOverlay(false);
  pauseAllMedia();
  activatePageGuard(0);

  const root = document.documentElement || document.body;
  if (!root) return false;

  const host = document.createElement("vigil-pause-overlay");
  host.id = "vigil-pause-overlay";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = pauseOverlayCss();
  shadow.append(style, pauseOverlayContent(decision));
  root.append(host);

  const timer = startPauseTimer(shadow, decision.waitSeconds);
  activePauseOverlay = { host, requestId: decision.requestId, timer };
  window.setTimeout(() => {
    const input = shadow.querySelector<HTMLInputElement>("#vigil-intention");
    input?.focus();
  }, 25);
  return true;
}

function pauseOverlayContent(decision: PauseOverlayDecision): HTMLElement {
  const backdrop = element("div", "backdrop");
  const panel = element("main", "panel");
  const eyebrow = element("p", "eyebrow", "Intentional Use");
  const title = element("h1", "", `Before ${decision.targetLabel}.`);
  const lead = element("p", "lead", decision.goalStatement);
  const quote = element("blockquote", "", "“The measure of love is to love without measure.”");
  quote.append(element("cite", "", "Saint Augustine"));
  const timer = element("div", "timer");
  const countdown = element("strong", "", String(decision.waitSeconds));
  countdown.id = "vigil-countdown";
  timer.append(countdown, element("span", "", "slow seconds"));

  const grid = element("div", "grid");
  const reasonSection = element("section", "");
  reasonSection.append(element("h2", "", "Use this for"));
  const intention = document.createElement("input");
  intention.id = "vigil-intention";
  intention.type = "text";
  intention.autocomplete = "off";
  intention.placeholder = "One clear reason";
  const mood = document.createElement("select");
  mood.id = "vigil-mood";
  for (const option of ["Current state", "Focused", "Bored", "Tired", "Anxious", "Avoiding something"]) {
    const item = document.createElement("option");
    item.value = option === "Current state" ? "" : option;
    item.textContent = option;
    mood.append(item);
  }
  reasonSection.append(intention, mood);

  const replacementSection = element("section", "");
  replacementSection.append(element("h2", "", "Or switch to"));
  const choices = element("div", "choices");
  let selectedReplacement = "";
  const replacements = decision.replacements.length ? decision.replacements : ["Close this tab"];
  for (const replacement of replacements) {
    const button = buttonElement("choice", replacement);
    button.addEventListener("click", () => {
      selectedReplacement = replacement;
      choices.querySelectorAll(".choice").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
      setOverlayStatus(panel, "Replacement selected.");
    });
    choices.append(button);
  }
  replacementSection.append(choices);
  grid.append(reasonSection, replacementSection);

  const meta = element("div", "meta");
  meta.append(element("span", "", decision.ruleName), element("span", "", decision.budgetText), element("span", "", decision.contextMessage));

  const actions = element("div", "actions");
  const skip = buttonElement("secondary", "Use replacement");
  const close = buttonElement("secondary", "Close tab");
  close.hidden = true;
  const continueButton = buttonElement("primary", `Continue for ${Math.round(decision.sessionMinutes)} min`);
  continueButton.id = "vigil-continue";
  continueButton.disabled = decision.waitSeconds > 0;
  actions.append(skip, close, continueButton);
  const status = element("p", "status", decision.waitSeconds > 0
    ? "Breathe first. The continue button will unlock when the timer reaches zero."
    : "Ready. Continue only if this still matches the reason you wrote.");
  status.id = "vigil-status";

  continueButton.addEventListener("click", () => {
    void continueFromOverlay(decision, intention.value, mood.value, continueButton);
  });
  skip.addEventListener("click", () => {
    void skipFromOverlay(decision, selectedReplacement || "Closed the loop", mood.value, skip, close);
  });
  close.addEventListener("click", () => {
    void sendCloseTab().catch((error: unknown) => {
      setOverlayStatus(panel, errorMessage(error));
    });
  });

  panel.append(eyebrow, title, lead, quote, timer, grid, meta, actions, status);
  backdrop.append(panel);
  return backdrop;
}

function startPauseTimer(root: ShadowRoot, waitSeconds: number): number | null {
  let remaining = Math.max(0, Math.ceil(waitSeconds));
  const countdown = root.querySelector<HTMLElement>("#vigil-countdown");
  const continueButton = root.querySelector<HTMLButtonElement>("#vigil-continue");
  if (remaining <= 0) {
    if (continueButton) continueButton.disabled = false;
    return null;
  }
  return window.setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    if (countdown) countdown.textContent = String(remaining);
    if (remaining <= 0) {
      if (activePauseOverlay?.timer) window.clearInterval(activePauseOverlay.timer);
      if (activePauseOverlay) activePauseOverlay.timer = null;
      if (continueButton) continueButton.disabled = false;
      const panel = root.querySelector<HTMLElement>(".panel");
      if (panel) setOverlayStatus(panel, "Ready. Continue only if this still matches the reason you wrote.");
    }
  }, 1000);
}

async function continueFromOverlay(decision: PauseOverlayDecision, intention: string, mood: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  setOverlayStatus(button, "Opening intentional window.");
  try {
    await sendPauseAction({
      type: "VIGIL_PAUSE_ACTION",
      action: "continue",
      requestId: decision.requestId,
      intention,
      mood
    });
    if (activePauseOverlay?.requestId !== decision.requestId) return;
    removePauseOverlay(true);
    resetAndPulse("activated");
  } catch (error) {
    setOverlayStatus(button, errorMessage(error));
    button.disabled = false;
  }
}

async function skipFromOverlay(
  decision: PauseOverlayDecision,
  replacement: string,
  mood: string,
  button: HTMLButtonElement,
  closeButton: HTMLButtonElement
): Promise<void> {
  button.disabled = true;
  try {
    await sendPauseAction({
      type: "VIGIL_PAUSE_ACTION",
      action: "skip",
      requestId: decision.requestId,
      replacement,
      mood
    });
    closeButton.hidden = false;
    setOverlayStatus(button, "Good. Keep the replacement small and concrete.");
  } catch (error) {
    setOverlayStatus(button, errorMessage(error));
    button.disabled = false;
  }
}

function sendPauseAction(message: PauseActionMessage): Promise<Record<string, unknown>> {
  return sendRuntimeMessage({ ...message });
}

async function sendCloseTab(): Promise<Record<string, unknown>> {
  return sendRuntimeMessage({ type: "VIGIL_CLOSE_TAB" });
}

function sendRuntimeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!isRecord(response)) {
        reject(new Error("Vigil did not respond."));
        return;
      }
      if (response.ok === false) {
        reject(new Error(typeof response.error === "string" ? response.error : "Vigil request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function removePauseOverlay(resumeMedia: boolean): void {
  if (!activePauseOverlay) return;
  if (activePauseOverlay.timer) window.clearInterval(activePauseOverlay.timer);
  activePauseOverlay.host.remove();
  activePauseOverlay = null;
  releasePageGuard();
  if (resumeMedia) resumePausedMedia();
}

function activatePageGuard(maxMs = 3500): void {
  if (isLocalVigilPage()) return;
  injectPageGuardStyle();
  const root = document.documentElement;
  if (!pageGuardActive && root) {
    pageGuardPreviousVisibility = {
      value: root.style.getPropertyValue("visibility"),
      priority: root.style.getPropertyPriority("visibility")
    };
  }
  pageGuardActive = true;
  root?.style.setProperty("visibility", "hidden", "important");
  root?.setAttribute("data-vigil-page-guard", "active");
  if (pageGuardReleaseTimer) window.clearTimeout(pageGuardReleaseTimer);
  pageGuardReleaseTimer = maxMs > 0
    ? window.setTimeout(() => releasePageGuard(), maxMs)
    : null;
}

function releasePageGuard(): void {
  if (pageGuardReleaseTimer) window.clearTimeout(pageGuardReleaseTimer);
  pageGuardReleaseTimer = null;
  if (!pageGuardActive) return;
  pageGuardActive = false;
  const root = document.documentElement;
  root?.removeAttribute("data-vigil-page-guard");
  if (root && pageGuardPreviousVisibility) {
    if (pageGuardPreviousVisibility.value) {
      root.style.setProperty("visibility", pageGuardPreviousVisibility.value, pageGuardPreviousVisibility.priority);
    } else {
      root.style.removeProperty("visibility");
    }
  }
  pageGuardPreviousVisibility = null;
}

function replaceLocation(url: string): void {
  try {
    window.location.replace(url);
  } catch {
    window.location.href = url;
  }
}

function injectPageGuardStyle(): void {
  if (document.getElementById("vigil-page-guard-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-page-guard-style";
  style.textContent = `
    html[data-vigil-page-guard="active"]::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: #101111;
      pointer-events: auto;
      visibility: visible !important;
    }
    html[data-vigil-page-guard="active"] > body {
      visibility: hidden !important;
    }
    html[data-vigil-page-guard="active"] > vigil-pause-overlay {
      visibility: visible !important;
    }
  `;
  (document.head || document.documentElement).append(style);
}

function isLocalVigilPage(): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(location.hostname.toLowerCase());
}

function pauseAllMedia(): void {
  mediaLockActive = true;
  document.querySelectorAll("video, audio").forEach((item) => {
    if (item instanceof HTMLMediaElement && !item.paused) {
      pausedByVigil.add(item);
      item.pause();
    }
  });
}

function pausePlayingMedia(event: Event): void {
  if (!mediaLockActive) return;
  const target = event.target;
  if (!(target instanceof HTMLMediaElement)) return;
  pausedByVigil.add(target);
  window.setTimeout(() => target.pause(), 0);
}

function resumePausedMedia(): void {
  mediaLockActive = false;
  for (const media of pausedByVigil) {
    if (media.isConnected && media.paused && !media.ended) {
      void media.play().catch(() => {});
    }
  }
  pausedByVigil.clear();
}

function trapPageKeys(event: KeyboardEvent): void {
  if (!activePauseOverlay) return;
  if (event.composedPath().some(isEditableElement)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function pauseDecision(value: unknown): PauseOverlayDecision | null {
  const result = asRecord(value);
  const pause = asRecord(result?.pause);
  if (!pause) return null;
  const requestId = stringField(pause, "id");
  if (!requestId) return null;
  const overlay = asRecord(result?.overlay);
  const rule = asRecord(result?.rule);
  return {
    requestId,
    targetLabel: stringField(pause, "targetLabel") || stringField(result, "hostname") || "this page",
    ruleName: stringField(rule, "name") || "Intentional Use",
    waitSeconds: numberField(overlay, "waitSeconds", secondsUntil(stringField(pause, "eligibleAt"))),
    sessionMinutes: numberField(pause, "sessionMinutes", 10),
    goalStatement: stringField(overlay, "goalStatement") || "Use screens on purpose, not by reflex.",
    replacements: stringArrayField(overlay, "replacements"),
    budgetText: stringField(overlay, "budgetText") || "No daily budget set",
    contextMessage: stringField(overlay, "contextMessage") || "Normal pause"
  };
}

function secondsUntil(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

function element<K extends keyof HTMLElementTagNameMap>(tagName: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const item = document.createElement(tagName);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function buttonElement(className: string, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = text;
  return button;
}

function setOverlayStatus(source: Element, text: string): void {
  const root = source.getRootNode();
  const status = root instanceof ShadowRoot ? root.querySelector("#vigil-status") : null;
  if (status) status.textContent = text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  return typeof record?.[key] === "string" ? String(record[key]) : "";
}

function numberField(record: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEditableElement(value: unknown): boolean {
  return value instanceof HTMLInputElement
    || value instanceof HTMLTextAreaElement
    || value instanceof HTMLSelectElement
    || (value instanceof HTMLElement && value.isContentEditable);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Request failed.");
}

function pauseOverlayCss() {
  return `
    :host {
      color-scheme: dark;
      font-family: Inter, "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 78% -8%, rgba(183, 121, 82, .08), transparent 34rem),
        radial-gradient(circle at 28% 106%, rgba(157, 124, 88, .04), transparent 30rem),
        linear-gradient(180deg, #101111, #161717);
    }
    .panel {
      width: min(720px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      overflow: auto;
      border: 1px solid #353532;
      border-radius: 12px;
      background: rgba(28, 29, 28, .96);
      color: #f0ece5;
      box-shadow: 0 28px 84px rgba(0, 0, 0, .44);
      padding: 28px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: #d5a16b;
      font: 800 12px "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace;
      text-transform: uppercase;
      letter-spacing: .12em;
    }
    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.12;
      font-weight: 720;
      letter-spacing: -.025em;
    }
    .lead {
      margin: 12px 0 20px;
      color: #aaa398;
      font-size: 16px;
      line-height: 1.45;
    }
    .timer {
      display: grid;
      place-items: center;
      min-height: 120px;
      margin: 0 0 18px;
      border: 1px solid rgba(213, 161, 107, .52);
      border-radius: 12px;
      background: radial-gradient(circle, rgba(183, 121, 82, .18), rgba(34, 35, 33, .88) 70%);
      box-shadow: 0 18px 56px rgba(0, 0, 0, .28), 0 0 42px rgba(183, 121, 82, .08);
    }
    .timer strong {
      display: block;
      font-size: 48px;
      line-height: 1;
    }
    .timer span {
      display: block;
      color: #aaa398;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 16px;
    }
    section {
      min-width: 0;
      border-top: 1px solid #353532;
      padding-top: 14px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
      line-height: 1.2;
    }
    input,
    select {
      width: 100%;
      min-height: 44px;
      margin: 0 0 10px;
      border: 1px solid #575248;
      border-radius: 9px;
      background: #151616;
      color: #f0ece5;
      font: inherit;
      padding: 10px 12px;
    }
    input:focus-visible,
    select:focus-visible,
    button:focus-visible {
      outline: 3px solid rgba(213, 161, 107, .24);
      outline-offset: 2px;
    }
    .choices {
      display: grid;
      gap: 8px;
    }
    button {
      min-height: 42px;
      border: 1px solid transparent;
      border-radius: 9px;
      font: inherit;
      font-weight: 760;
      cursor: pointer;
      transition: transform .16s ease, border-color .16s ease, background .16s ease, color .16s ease;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); }
    button:disabled {
      cursor: not-allowed;
      opacity: .58;
    }
    .choice {
      width: 100%;
      border-color: #575248;
      background: #222321;
      color: #f0ece5;
      text-align: left;
      padding: 10px 12px;
    }
    .choice.selected {
      border-color: #d5a16b;
      background: rgba(183, 121, 82, .16);
      color: #f0ece5;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 18px 0;
    }
    .meta span {
      border: 1px solid #353532;
      border-radius: 999px;
      background: rgba(34, 35, 33, .72);
      color: #aaa398;
      font-size: 12px;
      font-weight: 750;
      padding: 7px 10px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
    }
    .primary {
      background: #b77952;
      color: #16120f;
      padding: 10px 16px;
    }
    .primary:hover:not(:disabled) { background: #d5a16b; }
    .secondary {
      border-color: #575248;
      background: #222321;
      color: #f0ece5;
      padding: 10px 14px;
    }
    .status {
      min-height: 22px;
      margin: 14px 0 0;
      color: #aaa398;
      font-size: 14px;
      line-height: 1.4;
    }
    blockquote {
      margin: 14px 0 22px;
      padding: 11px 14px;
      border-left: 2px solid rgba(213, 161, 107, .52);
      background: rgba(183, 121, 82, .06);
      color: #d7d0c5;
      font-style: italic;
      line-height: 1.45;
    }
    blockquote cite {
      display: block;
      margin-top: 6px;
      color: #aaa398;
      font-size: 12px;
      font-style: normal;
    }
    @media (max-width: 700px) {
      .backdrop {
        align-items: stretch;
        padding: 12px;
      }
      .panel {
        max-height: calc(100vh - 24px);
        padding: 20px;
      }
      h1 {
        font-size: 26px;
      }
      .grid {
        grid-template-columns: 1fr;
      }
      .actions {
        justify-content: stretch;
      }
      .actions button {
        flex: 1 1 100%;
      }
    }
  `;
}

function cleanupBrowserNoise() {
  injectCleanupStyle();
  removeCookiePrompts();
  applyYoutubeAutofillFriction();
}

function maturePlatformForHost(hostValue: string): MaturePlatform | null {
  const host = hostValue.trim().toLowerCase().replace(/^www\./, "");
  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it" || host.endsWith(".redd.it")) return "reddit";
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
  return null;
}

function matureAgeGateRoute(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return maturePlatformForHost(url.hostname) === "reddit" && /^\/over18(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function matureSafeDestination(platform: MaturePlatform): string {
  return platform === "reddit" ? "https://www.reddit.com/" : "https://x.com/home";
}

function applyAlwaysOnMatureContentRestrictions(): void {
  const platform = maturePlatformForHost(location.hostname);
  if (!platform) return;
  if (matureAgeGateRoute(location.href)) {
    location.replace(matureSafeDestination(platform));
    return;
  }
  const root = document.documentElement;
  if (!root) {
    document.addEventListener("DOMContentLoaded", applyAlwaysOnMatureContentRestrictions, { once: true });
    return;
  }
  root.setAttribute("data-vigil-mature-interlock", platform);
  injectMatureContentStyle();
  scanMatureContent(platform);
  if (matureContentInterlockAttached) return;
  matureContentInterlockAttached = true;
  for (const eventName of ["pointerdown", "mousedown", "touchstart", "click", "submit", "change", "input", "keydown"]) {
    document.addEventListener(eventName, guardMatureContentAction, true);
  }
  matureContentObserver = new MutationObserver((records) => scanMatureContentMutations(platform, records));
  matureContentObserver.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-checked", "data-testid", "href", "nsfw", "over-18", "data-nsfw", "data-over-18", "data-over18", "title"]
  });
}

function injectMatureContentStyle(): void {
  if (document.getElementById("vigil-mature-content-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-mature-content-style";
  style.textContent = `
    html[data-vigil-mature-interlock] [data-vigil-mature-control="blocked"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] img,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] picture,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] video,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] audio,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] canvas,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] iframe,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] object,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] embed,
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] svg[role="img"],
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] [style*="background-image" i] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      background-image: none !important;
    }
    html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"]::before {
      content: "Mature media removed by Vigil";
      display: block !important;
      box-sizing: border-box !important;
      margin: 8px 0 !important;
      padding: 14px 16px !important;
      border: 1px solid rgba(183, 121, 82, 0.55) !important;
      border-radius: 10px !important;
      background: #211d1a !important;
      color: #eadfd7 !important;
      font: 600 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      text-align: center !important;
    }
  `;
  document.documentElement.append(style);
}

function matureQuerySelectorAll(scope: ParentNode, selector: string): HTMLElement[] {
  const matches: HTMLElement[] = [];
  if (scope instanceof HTMLElement) {
    try {
      if (scope.matches(selector)) matches.push(scope);
    } catch {
      return matches;
    }
  }
  try {
    matches.push(...scope.querySelectorAll<HTMLElement>(selector));
  } catch {
    // A changed site selector should not disable the other adapter rules.
  }
  return matches;
}

function scanMatureContentMutations(platform: MaturePlatform, records: MutationRecord[]): void {
  const scopes = new Set<HTMLElement>();
  for (const record of records) {
    if (record.target instanceof HTMLElement) scopes.add(record.target);
    else if (record.target.parentElement) scopes.add(record.target.parentElement);
    for (const node of record.addedNodes) {
      if (node instanceof HTMLElement) scopes.add(node);
      else if (node.parentElement) scopes.add(node.parentElement);
    }
  }
  if (scopes.size > 40) {
    scanMatureContent(platform);
    return;
  }
  for (const scope of scopes) scanMatureContent(platform, scope);
}

function scanMatureContent(platform: MaturePlatform, scope: ParentNode = document): void {
  if (matureContentScanInProgress) return;
  matureContentScanInProgress = true;
  try {
    const structuredSelectors = platform === "reddit"
      ? [
          "shreddit-post[nsfw]",
          "shreddit-post[over-18]",
          ".thing.over18",
          "[data-nsfw='true' i]",
          "[data-over-18='true' i]",
          "[data-over18='true' i]"
        ]
      : [
          "[data-testid*='sensitiveMedia' i]",
          "[data-testid*='sensitive_media' i]",
          "[aria-label*='sensitive content' i]",
          "[aria-label*='sensitive media' i]"
        ];
    for (const selector of structuredSelectors) {
      for (const marker of matureQuerySelectorAll(scope, selector).slice(0, 400)) markMatureContent(marker, platform);
    }

    const textSelector = platform === "reddit"
      ? ".thing .nsfw-stamp, [data-testid='post-container'] [class*='badge' i], shreddit-post [slot*='flair' i], [class*='nsfw' i], [data-testid*='label' i]"
      : "article span, [role='dialog'] span, [data-testid*='sensitive' i]";
    const textCandidates = matureQuerySelectorAll(scope, textSelector).slice(0, 800);
    for (const marker of textCandidates) {
      const text = normalizeMatureText(marker.textContent || "");
      if (platform === "x" ? matureXMarkerText(text) : matureMarkerText(text)) markMatureContent(marker, platform);
    }

    for (const control of matureQuerySelectorAll(scope, "a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem']").slice(0, 800)) {
      if (matureControlIsReveal(control)) blockMatureControl(control, platform);
    }
  } finally {
    matureContentScanInProgress = false;
  }
}

function normalizeMatureText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function matureMarkerText(value: string): boolean {
  return /^(?:nsfw|18\+|mature content|adult content|sensitive content|this (?:media|post|profile|community) may contain sensitive (?:content|material))\.?$/i.test(value);
}

function matureXMarkerText(value: string): boolean {
  return /^(?:sensitive content|this (?:media|post|profile) may contain sensitive (?:content|material))\.?$/i.test(value);
}

function matureRevealText(value: string): boolean {
  const text = normalizeMatureText(value);
  return [
    /\b(?:show|display|view|reveal|see|allow|enable)\s+(?:(?:potentially\s+)?(?:sensitive|mature|adult|nsfw))(?:\s+(?:content|media|posts?|communities|profiles?|images?))?\b/i,
    /\bdisplay\s+media\s+that\s+may\s+contain\s+sensitive\s+(?:content|material)\b/i,
    /\b(?:yes[,]?\s*)?(?:i(?:'|’)m|i am)\s+(?:over\s+)?18\b/i,
    /\bcontinue(?:\s+to)?\s+(?:18\+|mature|adult|nsfw)\b/i,
    /\bshow\s+mature\s*\(?18\+\)?\s*content\b/i
  ].some((pattern) => pattern.test(text));
}

function matureControlDescriptor(element: HTMLElement): string {
  const values = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.getAttribute("name"),
    element.getAttribute("value"),
    element.textContent
  ];
  if (element instanceof HTMLInputElement) {
    for (const label of element.labels || []) values.push(label.textContent);
  }
  return normalizeMatureText(values.filter((value): value is string => Boolean(value)).join(" ").slice(0, 900));
}

function matureControlIsReveal(element: HTMLElement): boolean {
  const descriptor = matureControlDescriptor(element);
  if (matureRevealText(descriptor)) return true;
  if (!/^(?:show|view|continue|yes|enable|allow)$/i.test(descriptor)) return false;
  const context = element.closest<HTMLElement>("[role='dialog'], [role='menuitem'], label, li, form, article");
  return Boolean(context && /\b(?:nsfw|18\+|mature|adult|sensitive)\b/i.test((context.textContent || "").slice(0, 900)));
}

function matureContentContainer(element: Element, platform: MaturePlatform): HTMLElement | null {
  const selectors = platform === "reddit"
    ? ["shreddit-post", "article", ".thing", "[data-testid='post-container']", "[role='article']", ".Post", "[data-click-id='background']", "[role='dialog']"]
    : ["article", "[data-testid='cellInnerDiv']", "[role='article']", "[role='dialog']"];
  for (const selector of selectors) {
    const container = element.closest(selector);
    if (container instanceof HTMLElement) return container;
  }
  return null;
}

function markMatureContent(marker: HTMLElement, platform: MaturePlatform): void {
  const container = matureContentContainer(marker, platform) || marker;
  container.setAttribute("data-vigil-mature-content", "blocked");
  container.querySelectorAll("video, audio").forEach((media) => {
    if (media instanceof HTMLMediaElement) media.pause();
  });
}

function blockMatureControl(control: HTMLElement, platform: MaturePlatform): void {
  control.setAttribute("data-vigil-mature-control", "blocked");
  control.setAttribute("aria-disabled", "true");
  control.setAttribute("aria-hidden", "true");
  control.setAttribute("tabindex", "-1");
  if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
  if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) control.checked = false;
  const container = matureContentContainer(control, platform);
  if (container && !control.closest("label, [role='menuitem'], form")) markMatureContent(container, platform);
}

function matureEventElement(event: Event): HTMLElement | null {
  for (const value of event.composedPath?.() || []) {
    if (value instanceof HTMLElement) return value;
  }
  return event.target instanceof HTMLElement ? event.target : null;
}

function guardMatureContentAction(event: Event): void {
  const platform = maturePlatformForHost(location.hostname);
  if (!platform) return;
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  const target = matureEventElement(event);
  if (!target) return;
  const control = target.closest<HTMLElement>("a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem'], form") || target;
  const anchor = control.closest<HTMLAnchorElement>("a[href]");
  const blocked = control.closest<HTMLElement>("[data-vigil-mature-control='blocked']");
  if (!blocked && !matureControlIsReveal(control) && !matureAgeGateRoute(anchor?.href || "")) return;
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
  blockMatureControl(control, platform);
  if (anchor && matureAgeGateRoute(anchor.href)) location.replace(matureSafeDestination(platform));
  scanMatureContent(platform);
}

function applyAlwaysOnYoutubeRestrictions(): void {
  if (!isYoutubeHost()) return;
  const root = document.documentElement;
  if (!root) {
    document.addEventListener("DOMContentLoaded", applyAlwaysOnYoutubeRestrictions, { once: true });
    return;
  }
  root.setAttribute("data-vigil-youtube-comments", "hidden");
  if (document.getElementById("vigil-youtube-comments-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-youtube-comments-style";
  style.textContent = `
    html[data-vigil-youtube-comments="hidden"] ytd-comments,
    html[data-vigil-youtube-comments="hidden"] ytd-comments-header-renderer,
    html[data-vigil-youtube-comments="hidden"] ytd-comment-thread-renderer,
    html[data-vigil-youtube-comments="hidden"] ytd-item-section-renderer[section-identifier="comment-item-section"],
    html[data-vigil-youtube-comments="hidden"] ytm-comments-entry-point-header-renderer,
    html[data-vigil-youtube-comments="hidden"] ytm-comments-header-renderer,
    html[data-vigil-youtube-comments="hidden"] ytm-comment-section-renderer,
    html[data-vigil-youtube-comments="hidden"] ytm-engagement-panel-section-list-renderer[target-id*="comments" i],
    html[data-vigil-youtube-comments="hidden"] [section-identifier="comments-entry-point"],
    html[data-vigil-youtube-comments="hidden"] #comments,
    html[data-vigil-youtube-comments="hidden"] #comments-button,
    html[data-vigil-youtube-comments="hidden"] a[href*="#comments" i],
    html[data-vigil-youtube-comments="hidden"] button[aria-label*="comment" i] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  root.append(style);
}

function applyFocusedSocialCleanup(settingsValue?: unknown): void {
  if (!isFocusedSocialHost()) return;
  const nextSettings = normalizeFocusedSocialCleanupSettings(settingsValue);
  const nextSignature = JSON.stringify(nextSettings);
  if (!focusedSocialCleanupAppliesToCurrentHost(nextSettings)) {
    teardownFocusedSocialCleanup();
    focusedSocialCleanupSettings = nextSettings;
    focusedSocialCleanupSignature = nextSignature;
    return;
  }
  if (focusedSocialCleanupSignature && focusedSocialCleanupSignature !== nextSignature) restoreFocusedSocialElements();
  focusedSocialCleanupSettings = nextSettings;
  focusedSocialCleanupSignature = nextSignature;
  focusedSocialCleanupEnabled = true;
  document.documentElement.setAttribute("data-vigil-focused-social", "active");
  injectFocusedSocialStyle();
  runFocusedSocialCleanupSoon(0);
  if (focusedSocialCleanupAttached) return;
  focusedSocialCleanupAttached = true;
  document.addEventListener("click", focusedSocialCleanupFromEvent, true);
  focusedSocialCleanupObserver = new MutationObserver(() => runFocusedSocialCleanupSoon(80));
  focusedSocialCleanupObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function teardownFocusedSocialCleanup(): void {
  focusedSocialCleanupEnabled = false;
  focusedSocialCleanupSignature = "";
  document.documentElement.removeAttribute("data-vigil-focused-social");
  document.getElementById("vigil-focused-social-style")?.remove();
  if (focusedSocialCleanupTimer) window.clearTimeout(focusedSocialCleanupTimer);
  focusedSocialCleanupTimer = null;
  focusedSocialCleanupObserver?.disconnect();
  focusedSocialCleanupObserver = null;
  restoreFocusedSocialElements();
  if (!focusedSocialCleanupAttached) return;
  focusedSocialCleanupAttached = false;
  document.removeEventListener("click", focusedSocialCleanupFromEvent, true);
}

function focusedSocialCleanupFromEvent(event: Event): void {
  if (!focusedSocialCleanupEnabled) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (!link || !isAddictiveSocialHref(link.getAttribute("href") || "")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  runFocusedSocialCleanupSoon(0);
}

function runFocusedSocialCleanupSoon(delayMs: number): void {
  if (focusedSocialCleanupTimer) window.clearTimeout(focusedSocialCleanupTimer);
  focusedSocialCleanupTimer = window.setTimeout(() => {
    focusedSocialCleanupTimer = null;
    applyFocusedSocialDomCleanup();
  }, delayMs);
}

function applyFocusedSocialDomCleanup(): void {
  if (!focusedSocialCleanupEnabled) return;
  if (isYoutubeHost() && focusedSocialCleanupSettings.youtube.enabled) cleanupYoutubeSocialFeatures();
  if (isInstagramHost() && focusedSocialCleanupSettings.instagram.enabled) cleanupInstagramSocialFeatures();
  if (isSnapchatHost() && focusedSocialCleanupSettings.snapchat.enabled) cleanupSnapchatSocialFeatures();
}

function cleanupYoutubeSocialFeatures(): void {
  const settings = focusedSocialCleanupSettings.youtube;
  if (settings.shorts) {
    hideSocialMatches([
      "a[href*='/shorts']",
      "ytd-reel-shelf-renderer",
      "ytm-reel-shelf-renderer",
      "ytd-rich-section-renderer:has(a[href*='/shorts'])",
      "ytm-rich-section-renderer:has(a[href*='/shorts'])",
      "ytd-mini-guide-entry-renderer:has(a[href*='/shorts'])",
      "ytd-guide-entry-renderer:has(a[href*='/shorts'])",
      "ytm-pivot-bar-item-renderer:has(a[href*='/shorts'])"
    ], youtubeCleanupContainer);
    hideElementsWithText([
      "ytd-rich-section-renderer",
      "ytm-rich-section-renderer",
      "section",
      "aside"
    ], ["shorts"], youtubeCleanupContainer);
  }
  if (settings.explore) {
    hideSocialMatches([
      "a[href*='/feed/explore']",
      "a[href*='/feed/trending']"
    ], youtubeCleanupContainer);
  }
  if (settings.home) {
    hideSocialMatches([
      "a[href*='/feed/recommended']"
    ], youtubeCleanupContainer);
    hideElementsWithText([
      "ytd-rich-section-renderer",
      "ytm-rich-section-renderer",
      "section",
      "aside"
    ], ["recommended"], youtubeCleanupContainer);
    if (isYoutubeHomePage()) {
      hideSocialMatches([
        "ytd-browse[page-subtype='home'] ytd-rich-grid-renderer",
        "ytd-browse[page-subtype='home'] ytd-two-column-browse-results-renderer",
        "ytm-browse ytm-rich-grid-renderer",
        "ytm-browse ytm-item-section-renderer"
      ], youtubeCleanupContainer);
    }
  }
  if (settings.suggested) {
    hideSocialMatches([
      "a[href^='/results?search_query=shorts']",
      "a[href*='/results?search_query=shorts']"
    ], youtubeCleanupContainer);
  }
  if (settings.ads) {
    hideSocialMatches([
      "ytd-promoted-video-renderer",
      "ytd-display-ad-renderer",
      "ytd-ad-slot-renderer",
      "ytm-promoted-video-renderer"
    ], youtubeCleanupContainer);
    hideElementsWithText([
      "ytd-rich-section-renderer",
      "ytm-rich-section-renderer",
      "section",
      "aside"
    ], ["sponsored"], youtubeCleanupContainer);
  }
}

function cleanupInstagramSocialFeatures(): void {
  const settings = focusedSocialCleanupSettings.instagram;
  if (settings.reels) {
    hideSocialMatches([
      "a[href^='/reel']",
      "a[href*='/reel/']",
      "a[href^='/reels']",
      "nav a[href*='/reel']"
    ], instagramCleanupContainer);
    hideElementsWithText([
      "article",
      "section",
      "div[role='dialog']"
    ], ["reels"], instagramCleanupContainer);
  }
  if (settings.suggested) {
    hideSocialMatches([
      "a[href^='/explore/people/suggested']",
      "nav a[href*='/explore/people/suggested']"
    ], instagramCleanupContainer);
    hideElementsWithText([
      "article",
      "section",
      "div[role='dialog']"
    ], ["suggested for you", "suggested posts"], instagramCleanupContainer);
  }
  if (settings.explore) {
    hideSocialMatches([
      "a[href^='/explore']",
      "nav a[href*='/explore']"
    ], instagramCleanupContainer);
  }
  if (settings.shopping) {
    hideSocialMatches([
      "a[href^='/shop']",
      "a[href^='/shopping']",
      "a[href^='/live']",
      "nav a[href*='/shop']"
    ], instagramCleanupContainer);
  }
  if (settings.ads) {
    hideElementsWithText([
      "article",
      "section",
      "div[role='dialog']"
    ], ["sponsored"], instagramCleanupContainer);
  }
}

function cleanupSnapchatSocialFeatures(): void {
  const settings = focusedSocialCleanupSettings.snapchat;
  if (settings.spotlight) {
    hideSocialMatches([
      "a[href*='/spotlight']",
      "a[href*='snapchat.com/spotlight']",
      "button[aria-label*='Spotlight' i]",
      "[role='button'][aria-label*='Spotlight' i]"
    ], snapchatCleanupContainer);
    hideElementsWithText([
      "nav a",
      "nav button",
      "[role='tab']",
      "[role='button']"
    ], ["spotlight"], snapchatCleanupContainer);
  }
  if (settings.stories) {
    hideSocialMatches([
      "a[href*='/stories']",
      "a[href*='story.snapchat.com']",
      "a[href*='snapchat.com/stories']",
      "button[aria-label*='Stories' i]",
      "[role='button'][aria-label*='Stories' i]"
    ], snapchatCleanupContainer);
    hideElementsWithText([
      "nav a",
      "nav button",
      "[role='tab']",
      "[role='button']"
    ], ["stories"], snapchatCleanupContainer);
  }
}

function hideSocialMatches(selectors: string[], containerFor: (element: Element) => HTMLElement | null): void {
  for (const selector of selectors) {
    for (const element of safeQuerySelectorAll(selector)) {
      const container = containerFor(element);
      if (container) hideFocusedSocialElement(container);
    }
  }
}

function hideElementsWithText(selectors: string[], needles: string[], containerFor: (element: Element) => HTMLElement | null): void {
  const selector = selectors.join(",");
  for (const element of safeQuerySelectorAll(selector).slice(0, 180)) {
    const text = (element.textContent || "").trim().toLowerCase();
    if (!text || !needles.some((needle) => text.includes(needle))) continue;
    const container = containerFor(element);
    if (container) hideFocusedSocialElement(container);
  }
}

function safeQuerySelectorAll(selector: string): HTMLElement[] {
  try {
    return [...document.querySelectorAll<HTMLElement>(selector)];
  } catch {
    return [];
  }
}

function youtubeCleanupContainer(element: Element): HTMLElement | null {
  return closestHTMLElement(element, [
    "ytd-reel-shelf-renderer",
    "ytm-reel-shelf-renderer",
    "ytd-rich-section-renderer",
    "ytm-rich-section-renderer",
    "ytd-mini-guide-entry-renderer",
    "ytd-guide-entry-renderer",
    "ytm-pivot-bar-item-renderer",
    "ytd-promoted-video-renderer",
    "ytd-display-ad-renderer",
    "ytd-ad-slot-renderer",
    "ytm-promoted-video-renderer",
    "ytd-rich-grid-renderer",
    "ytd-two-column-browse-results-renderer",
    "ytm-rich-grid-renderer",
    "ytm-item-section-renderer",
    "a"
  ]);
}

function instagramCleanupContainer(element: Element): HTMLElement | null {
  return closestHTMLElement(element, [
    "nav li",
    "nav a",
    "[role='tab']",
    "article",
    "section",
    "div[role='dialog']",
    "a"
  ]);
}

function snapchatCleanupContainer(element: Element): HTMLElement | null {
  return closestHTMLElement(element, [
    "nav li",
    "nav a",
    "nav button",
    "[role='tab']",
    "[role='button']",
    "a",
    "button",
    "div[role='dialog']"
  ]);
}

function closestHTMLElement(element: Element, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const closest = element.closest(selector);
    if (closest instanceof HTMLElement) return closest;
  }
  return element instanceof HTMLElement ? element : null;
}

function hideFocusedSocialElement(element: HTMLElement): void {
  if (element.dataset.vigilFocusedSocialHidden === "active") return;
  element.dataset.vigilFocusedSocialHidden = "active";
  element.dataset.vigilPreviousHidden = String(element.hidden);
  element.dataset.vigilPreviousAriaHidden = element.getAttribute("aria-hidden") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  pauseMediaInside(element);
}

function restoreFocusedSocialElements(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-vigil-focused-social-hidden='active']")) {
    element.hidden = element.dataset.vigilPreviousHidden === "true";
    if (element.dataset.vigilPreviousAriaHidden && element.dataset.vigilPreviousAriaHidden !== YOUTUBE_AUTOFILL_PREVIOUS_ABSENT) {
      element.setAttribute("aria-hidden", element.dataset.vigilPreviousAriaHidden);
    } else {
      element.removeAttribute("aria-hidden");
    }
    delete element.dataset.vigilFocusedSocialHidden;
    delete element.dataset.vigilPreviousHidden;
    delete element.dataset.vigilPreviousAriaHidden;
  }
}

function pauseMediaInside(element: HTMLElement): void {
  element.querySelectorAll("video, audio").forEach((item) => {
    if (item instanceof HTMLMediaElement) item.pause();
  });
}

function defaultFocusedSocialCleanupSettings(): FocusedSocialCleanupSettings {
  return {
    enabled: true,
    instagram: {
      enabled: true,
      reels: true,
      explore: true,
      suggested: true,
      shopping: true,
      ads: true
    },
    youtube: {
      enabled: true,
      shorts: true,
      home: true,
      explore: true,
      suggested: true,
      ads: true
    },
    snapchat: {
      enabled: true,
      spotlight: true,
      stories: true
    }
  };
}

function normalizeFocusedSocialCleanupSettings(value: unknown): FocusedSocialCleanupSettings {
  const defaults = defaultFocusedSocialCleanupSettings();
  const record = asRecord(value);
  const instagram = asRecord(record?.instagram);
  const youtube = asRecord(record?.youtube);
  const snapchat = asRecord(record?.snapchat);
  return {
    enabled: booleanField(record, "enabled", defaults.enabled),
    instagram: {
      enabled: booleanField(instagram, "enabled", defaults.instagram.enabled),
      reels: booleanField(instagram, "reels", defaults.instagram.reels),
      explore: booleanField(instagram, "explore", defaults.instagram.explore),
      suggested: booleanField(instagram, "suggested", defaults.instagram.suggested),
      shopping: booleanField(instagram, "shopping", defaults.instagram.shopping),
      ads: booleanField(instagram, "ads", defaults.instagram.ads)
    },
    youtube: {
      enabled: booleanField(youtube, "enabled", defaults.youtube.enabled),
      shorts: booleanField(youtube, "shorts", defaults.youtube.shorts),
      home: booleanField(youtube, "home", defaults.youtube.home),
      explore: booleanField(youtube, "explore", defaults.youtube.explore),
      suggested: booleanField(youtube, "suggested", defaults.youtube.suggested),
      ads: booleanField(youtube, "ads", defaults.youtube.ads)
    },
    snapchat: {
      enabled: booleanField(snapchat, "enabled", defaults.snapchat.enabled),
      spotlight: booleanField(snapchat, "spotlight", defaults.snapchat.spotlight),
      stories: booleanField(snapchat, "stories", defaults.snapchat.stories)
    }
  };
}

function booleanField(record: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  return typeof record?.[key] === "boolean" ? Boolean(record[key]) : fallback;
}

function focusedSocialCleanupAppliesToCurrentHost(settings: FocusedSocialCleanupSettings): boolean {
  if (!settings.enabled) return false;
  if (isYoutubeHost()) return settings.youtube.enabled;
  if (isInstagramHost()) return settings.instagram.enabled;
  if (isSnapchatHost()) return settings.snapchat.enabled;
  return false;
}

function isFocusedSocialHost(): boolean {
  return isYoutubeHost() || isInstagramHost() || isSnapchatHost();
}

function isInstagramHost(): boolean {
  const host = location.hostname.toLowerCase();
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

function isYoutubeHomePage(): boolean {
  return isYoutubeHost() && ["/", "/feed/recommended"].includes(location.pathname || "/");
}

function isSnapchatHost(): boolean {
  const host = location.hostname.toLowerCase();
  return host === "snapchat.com" || host.endsWith(".snapchat.com");
}

function isAddictiveSocialHref(raw: string): boolean {
  try {
    const url = new URL(raw, location.href);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const { instagram, youtube, snapchat } = focusedSocialCleanupSettings;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      return Boolean(youtube.enabled && (
        (youtube.shorts && /^\/shorts(?:\/|$)/i.test(url.pathname))
        || (youtube.explore && /^\/feed\/(?:explore|trending)(?:\/|$)/i.test(url.pathname))
        || (youtube.home && /^\/feed\/recommended(?:\/|$)/i.test(url.pathname))
        || (youtube.suggested && url.pathname === "/results" && (url.searchParams.get("search_query") || "").toLowerCase().includes("shorts"))
      ));
    }
    if (host === "instagram.com") {
      return Boolean(instagram.enabled && (
        (instagram.reels && /^\/reels?(?:\/|$)/i.test(url.pathname))
        || (instagram.suggested && /^\/explore\/people\/suggested(?:\/|$)/i.test(url.pathname))
        || (instagram.explore && /^\/explore(?:\/|$)/i.test(url.pathname))
        || (instagram.shopping && /^\/(?:shop|shopping|live)(?:\/|$)/i.test(url.pathname))
      ));
    }
    if (host === "snapchat.com" || host.endsWith(".snapchat.com")) {
      return Boolean(snapchat.enabled && (
        (snapchat.spotlight && /^\/spotlight(?:\/|$)/i.test(url.pathname))
        || (snapchat.stories && (host === "story.snapchat.com" || /^\/stories?(?:\/|$)/i.test(url.pathname)))
      ));
    }
  } catch {
    return false;
  }
  return false;
}

function injectFocusedSocialStyle(): void {
  if (document.getElementById("vigil-focused-social-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-focused-social-style";
  style.textContent = `
    html[data-vigil-focused-social="active"] [data-vigil-focused-social-hidden="active"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.append(style);
}

function applyYoutubeAutofillFriction(): void {
  if (!isYoutubeHost()) return;
  youtubeAutofillFrictionEnabled = true;
  document.documentElement.setAttribute("data-vigil-youtube-friction", "active");
  injectYoutubeAutofillStyle();
  hardenYoutubeSearchInputs();
  if (youtubeAutofillFrictionAttached) return;
  youtubeAutofillFrictionAttached = true;
  document.addEventListener("focusin", hardenYoutubeSearchFromEvent, true);
  document.addEventListener("input", hardenYoutubeSearchFromEvent, true);
  document.addEventListener("keydown", hideYoutubeSearchSuggestionsFromEvent, true);
}

function teardownYoutubeAutofillFriction(): void {
  youtubeAutofillFrictionEnabled = false;
  document.documentElement.removeAttribute("data-vigil-youtube-friction");
  document.getElementById("vigil-youtube-friction-style")?.remove();
  restoreYoutubeSearchInputs();
  restoreYoutubeSearchSuggestions();
  if (!youtubeAutofillFrictionAttached) return;
  youtubeAutofillFrictionAttached = false;
  document.removeEventListener("focusin", hardenYoutubeSearchFromEvent, true);
  document.removeEventListener("input", hardenYoutubeSearchFromEvent, true);
  document.removeEventListener("keydown", hideYoutubeSearchSuggestionsFromEvent, true);
}

function isYoutubeHost(): boolean {
  const host = location.hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host.endsWith(".youtu.be");
}

function injectYoutubeAutofillStyle(): void {
  if (document.getElementById("vigil-youtube-friction-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-youtube-friction-style";
  style.textContent = `
    html[data-vigil-youtube-friction="active"] ytd-searchbox-suggestions,
    html[data-vigil-youtube-friction="active"] yt-searchbox-suggestions,
    html[data-vigil-youtube-friction="active"] ytd-searchbox #suggestions,
    html[data-vigil-youtube-friction="active"] yt-searchbox #suggestions,
    html[data-vigil-youtube-friction="active"] .gstl_50 {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.append(style);
}

function hardenYoutubeSearchFromEvent(event: Event): void {
  if (!youtubeAutofillFrictionEnabled) return;
  if (!isYoutubeSearchInput(event.target)) return;
  hardenYoutubeSearchInput(event.target);
  window.setTimeout(hideYoutubeSearchSuggestions, 0);
}

function hideYoutubeSearchSuggestionsFromEvent(event: Event): void {
  if (!youtubeAutofillFrictionEnabled) return;
  if (!isYoutubeSearchInput(event.target)) return;
  window.setTimeout(hideYoutubeSearchSuggestions, 0);
}

function hardenYoutubeSearchInputs(): void {
  for (const input of youtubeSearchInputs()) hardenYoutubeSearchInput(input);
  hideYoutubeSearchSuggestions();
}

function youtubeSearchInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>("input[name='search_query'], input#search")]
    .filter(isYoutubeSearchInput);
}

function isYoutubeSearchInput(value: unknown): value is HTMLInputElement {
  if (!(value instanceof HTMLInputElement)) return false;
  const name = value.getAttribute("name") || "";
  const id = value.id || "";
  const formAction = value.form?.getAttribute("action") || "";
  const searchContainer = value.closest("ytd-searchbox, yt-searchbox, form[action='/results']");
  return name === "search_query" || (id === "search" && (Boolean(searchContainer) || formAction === "/results"));
}

function hardenYoutubeSearchInput(input: HTMLInputElement): void {
  rememberYoutubeSearchInputState(input);
  input.autocomplete = "off";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-autocomplete", "none");
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  input.dataset.vigilAutofillFriction = "active";
}

function rememberYoutubeSearchInputState(input: HTMLInputElement): void {
  if (input.dataset.vigilAutofillFriction === "active") return;
  input.dataset.vigilPreviousAutocomplete = input.getAttribute("autocomplete") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.vigilPreviousAriaAutocomplete = input.getAttribute("aria-autocomplete") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.vigilPreviousAutocapitalize = input.getAttribute("autocapitalize") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.vigilPreviousAutocorrect = input.getAttribute("autocorrect") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.vigilPreviousSpellcheck = String(input.spellcheck);
}

function restoreYoutubeSearchInputs(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-vigil-autofill-friction='active']")) {
    restoreYoutubeSearchInputAttribute(input, "autocomplete", "vigilPreviousAutocomplete");
    restoreYoutubeSearchInputAttribute(input, "aria-autocomplete", "vigilPreviousAriaAutocomplete");
    restoreYoutubeSearchInputAttribute(input, "autocapitalize", "vigilPreviousAutocapitalize");
    restoreYoutubeSearchInputAttribute(input, "autocorrect", "vigilPreviousAutocorrect");
    if (input.dataset.vigilPreviousSpellcheck) input.spellcheck = input.dataset.vigilPreviousSpellcheck === "true";
    delete input.dataset.vigilAutofillFriction;
    delete input.dataset.vigilPreviousAutocomplete;
    delete input.dataset.vigilPreviousAriaAutocomplete;
    delete input.dataset.vigilPreviousAutocapitalize;
    delete input.dataset.vigilPreviousAutocorrect;
    delete input.dataset.vigilPreviousSpellcheck;
  }
}

function restoreYoutubeSearchInputAttribute(input: HTMLInputElement, attribute: string, datasetKey: keyof DOMStringMap): void {
  const previous = input.dataset[datasetKey];
  if (!previous || previous === YOUTUBE_AUTOFILL_PREVIOUS_ABSENT) {
    input.removeAttribute(attribute);
    return;
  }
  input.setAttribute(attribute, previous);
}

function hideYoutubeSearchSuggestions(): void {
  if (!youtubeAutofillFrictionEnabled) return;
  for (const element of document.querySelectorAll<HTMLElement>("ytd-searchbox-suggestions, yt-searchbox-suggestions, ytd-searchbox #suggestions, yt-searchbox #suggestions, .gstl_50")) {
    if (!element.hidden) element.dataset.vigilYoutubeFrictionHidden = "active";
    if (element.getAttribute("aria-hidden") !== "true") element.dataset.vigilYoutubeFrictionAriaHidden = "active";
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
  }
}

function restoreYoutubeSearchSuggestions(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-vigil-youtube-friction-hidden], [data-vigil-youtube-friction-aria-hidden]")) {
    if (element.dataset.vigilYoutubeFrictionHidden === "active") element.hidden = false;
    if (element.dataset.vigilYoutubeFrictionAriaHidden === "active") element.removeAttribute("aria-hidden");
    delete element.dataset.vigilYoutubeFrictionHidden;
    delete element.dataset.vigilYoutubeFrictionAriaHidden;
  }
}

function injectCleanupStyle() {
  if (document.getElementById("vigil-cleanup-style")) return;
  const style = document.createElement("style");
  style.id = "vigil-cleanup-style";
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
  const candidates = [...document.querySelectorAll<HTMLElement>("[role='dialog'], [aria-modal='true'], body > div, body > section")].slice(0, 120);
  for (const element of candidates) {
    const text = (element.innerText || "").toLowerCase();
    const fixed = ["fixed", "sticky"].includes(getComputedStyle(element).position);
    const mentionsCookies = text.includes("cookie") || text.includes("consent") || text.includes("privacy choices");
    if (fixed && mentionsCookies && element.offsetHeight < window.innerHeight * 0.75) {
      element.remove();
    }
  }
}
