let lastPulseAt = Date.now();
let activePauseOverlay: PauseOverlayState | null = null;
let mediaLockActive = false;
let pageGuardActive = false;
let pageGuardReleaseTimer: number | null = null;
let youtubeAutofillFrictionEnabled = false;
let youtubeAutofillFrictionAttached = false;
const YOUTUBE_AUTOFILL_PREVIOUS_ABSENT = "__sentinel_absent__";
const pausedBySentinel = new Set<HTMLMediaElement>();

type PulseReason = "navigation" | "heartbeat" | "activated" | "history";
type HistoryMethod = "pushState" | "replaceState";

interface PulseResponse {
  ok?: boolean;
  blocked?: boolean;
  paused?: boolean;
  redirectUrl?: string;
  browserNoiseBlockingEnabled?: boolean;
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
  result?: unknown;
}

interface PulseOptions {
  guard?: boolean;
}

interface PauseActionMessage {
  type: "SENTINEL_PAUSE_ACTION";
  action: "continue" | "skip";
  requestId: string;
  intention?: string;
  mood?: string;
  replacement?: string;
}

activatePageGuard();
sendPulse("navigation", { guard: true });
setInterval(() => sendPulse("heartbeat"), 5000);
window.addEventListener("focus", () => resetAndPulse("activated"));
window.addEventListener("pageshow", () => resetAndPulse("activated", { guard: true }));
window.addEventListener("popstate", () => resetAndPulse("history", { guard: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resetAndPulse("activated", { guard: true });
});
document.addEventListener("play", pausePlayingMedia, true);
document.addEventListener("keydown", trapPageKeys, true);

chrome.runtime.onMessage.addListener((message: PauseMessage, _sender, sendResponse: (response?: unknown) => void) => {
  if (message?.type !== "SENTINEL_SHOW_PAUSE") return false;
  sendResponse({ ok: showPauseOverlay(message.result) });
  return false;
});

patchHistory("pushState");
patchHistory("replaceState");

function resetAndPulse(reason: PulseReason, options: PulseOptions = {}): void {
  lastPulseAt = Date.now();
  sendPulse(reason, options);
}

function sendPulse(reason: PulseReason, options: PulseOptions = {}): void {
  if (document.visibilityState !== "visible") return;
  if (!options.guard && !document.hasFocus()) return;
  if (options.guard) activatePageGuard();
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
    }, (result: PulseResponse | undefined) => {
      void chrome.runtime.lastError;
      handlePulseResult(result);
    });
  } catch {
    releasePageGuard();
  }
}

function handlePulseResult(result: PulseResponse | undefined): void {
  if (result?.browserNoiseBlockingEnabled === true) {
    cleanupBrowserNoise();
  } else if (result?.browserNoiseBlockingEnabled === false) {
    teardownYoutubeAutofillFriction();
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

  const host = document.createElement("sentinel-pause-overlay");
  host.id = "sentinel-pause-overlay";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = pauseOverlayCss();
  shadow.append(style, pauseOverlayContent(decision));
  root.append(host);

  const timer = startPauseTimer(shadow, decision.waitSeconds);
  activePauseOverlay = { host, requestId: decision.requestId, timer };
  window.setTimeout(() => {
    const input = shadow.querySelector<HTMLInputElement>("#sentinel-intention");
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
  const timer = element("div", "timer");
  const countdown = element("strong", "", String(decision.waitSeconds));
  countdown.id = "sentinel-countdown";
  timer.append(countdown, element("span", "", "slow seconds"));

  const grid = element("div", "grid");
  const reasonSection = element("section", "");
  reasonSection.append(element("h2", "", "Use this for"));
  const intention = document.createElement("input");
  intention.id = "sentinel-intention";
  intention.type = "text";
  intention.autocomplete = "off";
  intention.placeholder = "One clear reason";
  const mood = document.createElement("select");
  mood.id = "sentinel-mood";
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
  continueButton.id = "sentinel-continue";
  continueButton.disabled = decision.waitSeconds > 0;
  actions.append(skip, close, continueButton);
  const status = element("p", "status", decision.waitSeconds > 0
    ? "Breathe first. The continue button will unlock when the timer reaches zero."
    : "Ready. Continue only if this still matches the reason you wrote.");
  status.id = "sentinel-status";

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

  panel.append(eyebrow, title, lead, timer, grid, meta, actions, status);
  backdrop.append(panel);
  return backdrop;
}

function startPauseTimer(root: ShadowRoot, waitSeconds: number): number | null {
  let remaining = Math.max(0, Math.ceil(waitSeconds));
  const countdown = root.querySelector<HTMLElement>("#sentinel-countdown");
  const continueButton = root.querySelector<HTMLButtonElement>("#sentinel-continue");
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
      type: "SENTINEL_PAUSE_ACTION",
      action: "continue",
      requestId: decision.requestId,
      intention,
      mood
    });
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
      type: "SENTINEL_PAUSE_ACTION",
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
  return sendRuntimeMessage({ type: "SENTINEL_CLOSE_TAB" });
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
        reject(new Error("Sentinel did not respond."));
        return;
      }
      if (response.ok === false) {
        reject(new Error(typeof response.error === "string" ? response.error : "Sentinel request failed."));
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
  if (isLocalSentinelPage()) return;
  injectPageGuardStyle();
  pageGuardActive = true;
  document.documentElement?.setAttribute("data-sentinel-page-guard", "active");
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
  document.documentElement?.removeAttribute("data-sentinel-page-guard");
}

function replaceLocation(url: string): void {
  try {
    window.location.replace(url);
  } catch {
    window.location.href = url;
  }
}

function injectPageGuardStyle(): void {
  if (document.getElementById("sentinel-page-guard-style")) return;
  const style = document.createElement("style");
  style.id = "sentinel-page-guard-style";
  style.textContent = `
    html[data-sentinel-page-guard="active"]::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: #f7faf7;
      pointer-events: auto;
    }
    html[data-sentinel-page-guard="active"] > body {
      visibility: hidden !important;
    }
    html[data-sentinel-page-guard="active"] > sentinel-pause-overlay {
      visibility: visible !important;
    }
  `;
  (document.head || document.documentElement).append(style);
}

function isLocalSentinelPage(): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(location.hostname.toLowerCase());
}

function pauseAllMedia(): void {
  mediaLockActive = true;
  document.querySelectorAll("video, audio").forEach((item) => {
    if (item instanceof HTMLMediaElement && !item.paused) {
      pausedBySentinel.add(item);
      item.pause();
    }
  });
}

function pausePlayingMedia(event: Event): void {
  if (!mediaLockActive) return;
  const target = event.target;
  if (!(target instanceof HTMLMediaElement)) return;
  pausedBySentinel.add(target);
  window.setTimeout(() => target.pause(), 0);
}

function resumePausedMedia(): void {
  mediaLockActive = false;
  for (const media of pausedBySentinel) {
    if (media.isConnected && media.paused && !media.ended) {
      void media.play().catch(() => {});
    }
  }
  pausedBySentinel.clear();
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
  const status = root instanceof ShadowRoot ? root.querySelector("#sentinel-status") : null;
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
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
      background: #091214;
    }
    .panel {
      width: min(720px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      overflow: auto;
      border: 1px solid rgba(255, 255, 255, .46);
      border-radius: 8px;
      background: #f7faf7;
      color: #15201c;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .34);
      padding: 28px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: #48655a;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.12;
      font-weight: 850;
    }
    .lead {
      margin: 12px 0 20px;
      color: #4f5f59;
      font-size: 16px;
      line-height: 1.45;
    }
    .timer {
      display: grid;
      place-items: center;
      min-height: 120px;
      margin: 0 0 18px;
      border: 1px solid #d8e2dc;
      border-radius: 8px;
      background: #ffffff;
    }
    .timer strong {
      display: block;
      font-size: 48px;
      line-height: 1;
    }
    .timer span {
      display: block;
      color: #66756f;
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
      border: 1px solid #cfdad4;
      border-radius: 8px;
      background: #ffffff;
      color: #14201c;
      font: inherit;
      padding: 10px 12px;
    }
    .choices {
      display: grid;
      gap: 8px;
    }
    button {
      min-height: 42px;
      border: 1px solid transparent;
      border-radius: 8px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .58;
    }
    .choice {
      width: 100%;
      border-color: #cfdad4;
      background: #ffffff;
      color: #20302a;
      text-align: left;
      padding: 10px 12px;
    }
    .choice.selected {
      border-color: #1d6b4f;
      background: #e9f5ef;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 18px 0;
    }
    .meta span {
      border: 1px solid #d8e2dc;
      border-radius: 999px;
      background: #ffffff;
      color: #4f5f59;
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
      background: #176a4d;
      color: #ffffff;
      padding: 10px 16px;
    }
    .secondary {
      border-color: #cfdad4;
      background: #ffffff;
      color: #20302a;
      padding: 10px 14px;
    }
    .status {
      min-height: 22px;
      margin: 14px 0 0;
      color: #52635d;
      font-size: 14px;
      line-height: 1.4;
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

function applyYoutubeAutofillFriction(): void {
  if (!isYoutubeHost()) return;
  youtubeAutofillFrictionEnabled = true;
  document.documentElement.setAttribute("data-sentinel-youtube-friction", "active");
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
  document.documentElement.removeAttribute("data-sentinel-youtube-friction");
  document.getElementById("sentinel-youtube-friction-style")?.remove();
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
  if (document.getElementById("sentinel-youtube-friction-style")) return;
  const style = document.createElement("style");
  style.id = "sentinel-youtube-friction-style";
  style.textContent = `
    html[data-sentinel-youtube-friction="active"] ytd-searchbox-suggestions,
    html[data-sentinel-youtube-friction="active"] yt-searchbox-suggestions,
    html[data-sentinel-youtube-friction="active"] ytd-searchbox #suggestions,
    html[data-sentinel-youtube-friction="active"] yt-searchbox #suggestions,
    html[data-sentinel-youtube-friction="active"] .gstl_50 {
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
  input.dataset.sentinelAutofillFriction = "active";
}

function rememberYoutubeSearchInputState(input: HTMLInputElement): void {
  if (input.dataset.sentinelAutofillFriction === "active") return;
  input.dataset.sentinelPreviousAutocomplete = input.getAttribute("autocomplete") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.sentinelPreviousAriaAutocomplete = input.getAttribute("aria-autocomplete") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.sentinelPreviousAutocapitalize = input.getAttribute("autocapitalize") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.sentinelPreviousAutocorrect = input.getAttribute("autocorrect") ?? YOUTUBE_AUTOFILL_PREVIOUS_ABSENT;
  input.dataset.sentinelPreviousSpellcheck = String(input.spellcheck);
}

function restoreYoutubeSearchInputs(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-sentinel-autofill-friction='active']")) {
    restoreYoutubeSearchInputAttribute(input, "autocomplete", "sentinelPreviousAutocomplete");
    restoreYoutubeSearchInputAttribute(input, "aria-autocomplete", "sentinelPreviousAriaAutocomplete");
    restoreYoutubeSearchInputAttribute(input, "autocapitalize", "sentinelPreviousAutocapitalize");
    restoreYoutubeSearchInputAttribute(input, "autocorrect", "sentinelPreviousAutocorrect");
    if (input.dataset.sentinelPreviousSpellcheck) input.spellcheck = input.dataset.sentinelPreviousSpellcheck === "true";
    delete input.dataset.sentinelAutofillFriction;
    delete input.dataset.sentinelPreviousAutocomplete;
    delete input.dataset.sentinelPreviousAriaAutocomplete;
    delete input.dataset.sentinelPreviousAutocapitalize;
    delete input.dataset.sentinelPreviousAutocorrect;
    delete input.dataset.sentinelPreviousSpellcheck;
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
    if (!element.hidden) element.dataset.sentinelYoutubeFrictionHidden = "active";
    if (element.getAttribute("aria-hidden") !== "true") element.dataset.sentinelYoutubeFrictionAriaHidden = "active";
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
  }
}

function restoreYoutubeSearchSuggestions(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-sentinel-youtube-friction-hidden], [data-sentinel-youtube-friction-aria-hidden]")) {
    if (element.dataset.sentinelYoutubeFrictionHidden === "active") element.hidden = false;
    if (element.dataset.sentinelYoutubeFrictionAriaHidden === "active") element.removeAttribute("aria-hidden");
    delete element.dataset.sentinelYoutubeFrictionHidden;
    delete element.dataset.sentinelYoutubeFrictionAriaHidden;
  }
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
