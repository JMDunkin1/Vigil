import type { ControlElement, UnknownRecord } from "./app-model.js";

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
}

interface VigilAppUpdateWindow extends Window {
  vigilAppUpdate?: VigilAppUpdateBridge;
}

export function createAppUpdatePanel({ $, get, post, toast, errorMessage }: AppUpdatePanelContext) {
  let cached: UnknownRecord | null = null;
  let checking = false;

  return {
    bind() {
      $("#checkAppUpdate").addEventListener("click", () => {
        if (canInstall(cached)) {
          void startUpdate();
          return;
        }
        void refreshStatus(true);
      });
    },
    refreshStatus,
    render() {
      renderStatus(cached);
    }
  };

  async function refreshStatus(checkRemote = false): Promise<void> {
    if (checking) return;
    checking = true;
    const button = $("#checkAppUpdate");
    button.disabled = true;
    button.textContent = "Checking...";
    $("#appUpdateStatus").textContent = "Checking...";
    try {
      cached = await requestStatus(checkRemote);
      renderStatus(cached);
    } catch (error) {
      cached = failedStatus(errorMessage(error));
    } finally {
      checking = false;
      renderStatus(cached);
    }
  }

  async function startUpdate(): Promise<void> {
    const button = $("#checkAppUpdate");
    button.disabled = true;
    button.textContent = "Starting Update...";
    $("#appUpdateStatus").textContent = "Starting update...";
    try {
      cached = await requestStart();
      renderStatus(cached);
      toast("Vigil update started");
    } catch (error) {
      const message = errorMessage(error);
      cached = failedStatus(message, cached);
      toast(message);
      renderStatus(cached);
    }
  }

  async function requestStatus(checkRemote: boolean): Promise<UnknownRecord> {
    const bridge = appUpdateBridge();
    const result = bridge
      ? await bridge.status({ checkRemote })
      : await get<UnknownRecord>(checkRemote ? "/api/app-update/status?check=1" : "/api/app-update/status");
    return successfulResult(result, "Update check failed.");
  }

  async function requestStart(): Promise<UnknownRecord> {
    const bridge = appUpdateBridge();
    const result = bridge
      ? await bridge.start()
      : await post<UnknownRecord>("/api/app-update/start", {});
    return successfulResult(result, "Update could not start.");
  }

  function renderStatus(status: UnknownRecord | null): void {
    const button = $("#checkAppUpdate");
    if (!status) {
      $("#appUpdateStatus").textContent = "Not checked";
      $("#appUpdateMeta").textContent = "--";
      button.textContent = "Check for Updates";
      button.disabled = false;
      button.classList.remove("primary");
      button.classList.add("secondary");
      return;
    }
    const supported = status.supported !== false;
    const running = Boolean(status.running);
    const dirty = Boolean(status.dirty);
    const behind = Number(status.behind || 0);
    const appBundleOutdated = Boolean(status.appBundleOutdated);
    const currentCommit = shortCommit(status.currentCommit);
    const branch = String(status.branch || "");
    $("#appUpdateStatus").textContent = String(status.message || (supported ? "Ready" : "Unavailable"));
    $("#appUpdateMeta").textContent = [
      branch,
      currentCommit,
      behind ? `${behind} behind` : "",
      appBundleOutdated ? "app stale" : "",
      dirty ? "local edits" : "",
      status.appBuiltAt ? `built ${formatDate(status.appBuiltAt)}` : ""
    ].filter(Boolean).join(" | ") || "--";
    const installable = canInstall(status);
    button.textContent = installable ? "Install Update" : "Check for Updates";
    button.disabled = !supported || running;
    button.classList.toggle("primary", installable);
    button.classList.toggle("secondary", !installable);
  }
}

function canInstall(status: UnknownRecord | null): boolean {
  if (!status || status.ok !== true || status.supported === false || status.running || status.dirty || status.remoteCheckOk === false) return false;
  return Boolean(status.updateAvailable || status.appBundleOutdated || Number(status.behind || 0) > 0);
}

function appUpdateBridge(): VigilAppUpdateBridge | null {
  return (window as VigilAppUpdateWindow).vigilAppUpdate || null;
}

function successfulResult(value: unknown, fallback: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(fallback);
  const result = value as UnknownRecord;
  if (result.ok !== true) throw new Error(String(result.error || result.message || fallback));
  return result;
}

function failedStatus(message: string, previous: UnknownRecord | null = null): UnknownRecord {
  return {
    ...(previous || {}),
    ok: false,
    supported: previous?.supported !== false,
    running: false,
    updateAvailable: false,
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
