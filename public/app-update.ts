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
      cached = await get<UnknownRecord>(checkRemote ? "/api/app-update/status?check=1" : "/api/app-update/status");
      renderStatus(cached);
    } catch (error) {
      $("#appUpdateStatus").textContent = errorMessage(error);
      $("#appUpdateMeta").textContent = "Unavailable";
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
      cached = await post<UnknownRecord>("/api/app-update/start", {});
      renderStatus(cached);
      toast("Sentinel update started");
    } catch (error) {
      $("#appUpdateStatus").textContent = errorMessage(error);
      toast(errorMessage(error));
      renderStatus(cached);
    }
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
  if (!status || status.supported === false || status.running) return false;
  return Boolean(status.updateAvailable || status.appBundleOutdated || Number(status.behind || 0) > 0);
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
