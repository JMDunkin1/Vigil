import type { ControlElement, UnknownRecord } from "./app-model.js";
import { deriveAppUpdateViewState } from "./app-update-state.js";

type GetRequest = <T = unknown>(path: string) => Promise<T>;
type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;
type QueryElement = (selector: string) => ControlElement;

interface AppUpdatePanelContext {
  $: QueryElement;
  get: GetRequest;
  post: PostRequest;
  toast(message: string): void;
  errorMessage(error: unknown): string;
}

interface VigilAppUpdateBridge {
  status(options?: { checkRemote?: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  relaunch(): Promise<unknown>;
  subscribe?(listener: (status: unknown) => void): () => void;
}

interface VigilAppUpdateWindow extends Window {
  vigilAppUpdate?: VigilAppUpdateBridge;
}

export function createAppUpdatePanel({ $, get, post, toast, errorMessage }: AppUpdatePanelContext) {
  let cached: UnknownRecord | null = null;
  let requestInFlight = false;
  let relaunchInFlight = false;
  let visibleOperation: "checking" | "starting" | "setting-up" | null = null;
  let runningRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let requestVersion = 0;
  let acceptedStateRevision = -1;
  let unsubscribeFromState: (() => void) | null = null;
  let unloadCleanupBound = false;

  return {
    bind() {
      unsubscribeFromState?.();
      unsubscribeFromState = appUpdateBridge()?.subscribe?.(acceptPublishedStatus) || null;
      if (!unloadCleanupBound && typeof window.addEventListener === "function") {
        unloadCleanupBound = true;
        window.addEventListener("beforeunload", dispose, { once: true });
      }
      $("#checkAppUpdate").addEventListener("click", () => {
        if (requestInFlight) return;
        const view = currentView();
        if (!view.actionEnabled) return;
        if (view.actionKind === "update" || view.actionKind === "setup") {
          void startUpdate();
          return;
        }
        void refreshStatus(true);
      });
      $("#relaunchVigil").addEventListener("click", () => {
        if (requestInFlight || relaunchInFlight) return;
        if (cached?.running === true
          || cached?.recoveryPending === true
          || cached?.recoveryBlocked === true) return;
        void relaunchVigil();
      });
    },
    refreshStatus,
    render() {
      renderStatus(cached);
    },
    dispose
  };

  function dispose(): void {
    requestVersion += 1;
    requestInFlight = false;
    relaunchInFlight = false;
    visibleOperation = null;
    unsubscribeFromState?.();
    unsubscribeFromState = null;
    if (runningRefreshTimer) clearTimeout(runningRefreshTimer);
    runningRefreshTimer = null;
  }

  async function refreshStatus(checkRemote = false): Promise<void> {
    if (requestInFlight) return;
    const submittedVersion = ++requestVersion;
    requestInFlight = true;
    visibleOperation = checkRemote || !cached ? "checking" : null;
    renderStatus(cached);
    try {
      const status = await requestStatus(checkRemote);
      if (submittedVersion !== requestVersion || !acceptStateRevision(status)) return;
      cached = status;
    } catch (error) {
      if (submittedVersion !== requestVersion) return;
      cached = failedStatus(errorMessage(error), cached);
    } finally {
      if (submittedVersion !== requestVersion) return;
      requestInFlight = false;
      visibleOperation = null;
      renderStatus(cached);
      scheduleRunningRefresh();
    }
  }

  async function startUpdate(): Promise<void> {
    if (requestInFlight) return;
    const requestedAction = currentView().actionKind;
    if (requestedAction !== "update" && requestedAction !== "setup") return;
    const submittedVersion = ++requestVersion;
    requestInFlight = true;
    visibleOperation = requestedAction === "setup" ? "setting-up" : "starting";
    renderStatus(cached);
    try {
      const status = await requestStart();
      if (submittedVersion !== requestVersion || !acceptStateRevision(status)) return;
      cached = status;
      toast(cached.noUpdate === true
        ? String(cached.message || "No newer Vigil update is available.")
        : cached.ok === true
          ? requestedAction === "setup"
            ? "Fast protected updates are ready"
            : "Vigil update started"
          : String(cached.message || cached.error || "Vigil update is already running"));
    } catch (error) {
      if (submittedVersion !== requestVersion) return;
      const message = errorMessage(error);
      cached = failedStatus(message, cached, true);
      toast(message);
    } finally {
      if (submittedVersion !== requestVersion) return;
      requestInFlight = false;
      visibleOperation = null;
      renderStatus(cached);
      scheduleRunningRefresh();
    }
  }

  async function relaunchVigil(): Promise<void> {
    const submittedVersion = ++requestVersion;
    relaunchInFlight = true;
    renderStatus(cached);
    try {
      const status = await requestRelaunch();
      if (submittedVersion !== requestVersion) return;
      cached = { ...(cached || {}), ...status };
      toast(String(status.message || "Vigil is relaunching."));
      renderStatus(cached);
    } catch (error) {
      if (submittedVersion !== requestVersion) return;
      relaunchInFlight = false;
      const message = errorMessage(error);
      cached = failedStatus(message, cached, true);
      toast(message);
      renderStatus(cached);
    }
  }

  function acceptPublishedStatus(value: unknown): void {
    let status: UnknownRecord;
    try {
      status = statusResult(value, "Update state could not be read.");
    } catch {
      return;
    }
    if (!acceptStateRevision(status)) return;
    requestVersion += 1;
    requestInFlight = false;
    visibleOperation = null;
    cached = { ...(cached || {}), ...status };
    renderStatus(cached);
    scheduleRunningRefresh();
  }

  function acceptStateRevision(status: UnknownRecord): boolean {
    const revision = Number(status.updateStateRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) return true;
    if (revision < acceptedStateRevision) return false;
    acceptedStateRevision = revision;
    return true;
  }

  function scheduleRunningRefresh(): void {
    if (runningRefreshTimer) {
      clearTimeout(runningRefreshTimer);
      runningRefreshTimer = null;
    }
    if (!deriveAppUpdateViewState(cached).shouldPoll) return;
    runningRefreshTimer = setTimeout(() => {
      runningRefreshTimer = null;
      void refreshStatus(false);
    }, 1_000);
  }

  async function requestStatus(checkRemote: boolean): Promise<UnknownRecord> {
    const bridge = appUpdateBridge();
    const result = bridge
      ? await bridge.status({ checkRemote })
      : await get<UnknownRecord>(checkRemote ? "/api/app-update/status?check=1" : "/api/app-update/status");
    return statusResult(result, "Update check failed.");
  }

  async function requestStart(): Promise<UnknownRecord> {
    const bridge = appUpdateBridge();
    const result = bridge
      ? await bridge.start()
      : await post<UnknownRecord>("/api/app-update/start", {});
    return successfulResult(result, "Update could not start.");
  }

  async function requestRelaunch(): Promise<UnknownRecord> {
    const bridge = appUpdateBridge();
    const result = bridge
      ? await bridge.relaunch()
      : await post<UnknownRecord>("/api/app-relaunch", {});
    return successfulResult(result, "Vigil could not relaunch.");
  }

  function renderStatus(status: UnknownRecord | null): void {
    const panel = $("#appUpdatePanel");
    const button = $("#checkAppUpdate");
    const relaunchButton = $("#relaunchVigil");
    const progress = $("#appUpdateProgress");
    const view = currentView(status);
    panel.setAttribute("aria-busy", String(view.busy || relaunchInFlight));
    $("#appUpdateStatus").textContent = view.statusMessage;
    $("#appUpdateHelp").textContent = view.helpMessage;
    progress.hidden = !view.showProgress;
    progress.setAttribute("aria-hidden", String(!view.showProgress));
    if (view.progressLabel) progress.setAttribute("aria-valuetext", view.progressLabel);
    else progress.removeAttribute("aria-valuetext");
    relaunchButton.textContent = relaunchInFlight ? "Relaunching Vigil…" : "Relaunch Vigil";
    relaunchButton.disabled = relaunchInFlight
      || requestInFlight
      || view.busy
      || status?.running === true
      || status?.recoveryPending === true
      || status?.recoveryBlocked === true;
    if (!status) {
      $("#appUpdateMeta").textContent = "--";
      button.textContent = view.actionLabel;
      button.disabled = !view.actionEnabled;
      button.classList.remove("primary");
      button.classList.add("secondary");
      return;
    }
    const dirty = Boolean(status.dirty);
    const behind = Number(status.behind || 0);
    const appBundleOutdated = Boolean(status.appBundleOutdated);
    const currentCommit = shortCommit(status.currentCommit);
    const branch = String(status.branch || "");
    $("#appUpdateMeta").textContent = [
      branch,
      currentCommit,
      behind ? `${behind} behind` : "",
      appBundleOutdated ? "app stale" : "",
      dirty ? "local edits" : "",
      status.appBuiltAt ? `built ${formatDate(status.appBuiltAt)}` : ""
    ].filter(Boolean).join(" · ") || "--";
    button.textContent = view.actionLabel;
    button.disabled = !view.actionEnabled;
    const primaryAction = view.actionKind === "update" || view.actionKind === "setup";
    button.classList.toggle("primary", primaryAction);
    button.classList.toggle("secondary", !primaryAction);
  }

  function currentView(status: UnknownRecord | null = cached) {
    return deriveAppUpdateViewState(status, {
      checking: visibleOperation === "checking",
      starting: visibleOperation === "starting",
      settingUp: visibleOperation === "setting-up"
    });
  }
}

function appUpdateBridge(): VigilAppUpdateBridge | null {
  return (window as VigilAppUpdateWindow).vigilAppUpdate || null;
}

function successfulResult(value: unknown, fallback: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(fallback);
  return value as UnknownRecord;
}

function statusResult(value: unknown, fallback: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(fallback);
  const result = value as UnknownRecord;
  if (result.ok === true) return result;
  const recoveryMessage = (result.recoveryPending === true || result.recoveryBlocked === true)
    && typeof result.message === "string"
    && result.message.trim()
    ? result.message
    : null;
  return {
    ...result,
    checkOk: false,
    message: recoveryMessage || String(result.error || result.message || fallback)
  };
}

function failedStatus(
  message: string,
  previous: UnknownRecord | null = null,
  preserveSelectedUpdate = false
): UnknownRecord {
  return {
    ...(previous || {}),
    ok: false,
    checkOk: preserveSelectedUpdate ? previous?.checkOk !== false : false,
    supported: previous?.supported !== false,
    running: previous?.running === true,
    updateAvailable: preserveSelectedUpdate ? previous?.updateAvailable === true : false,
    updateCandidateAvailable: preserveSelectedUpdate
      ? previous?.updateCandidateAvailable === true || previous?.updateAvailable === true
      : false,
    message
  };
}

function shortCommit(value: unknown): string {
  const text = String(value || "");
  return text ? text.slice(0, 7) : "";
}

function formatDate(value: unknown): string {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
