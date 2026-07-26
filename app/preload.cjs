const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
});

contextBridge.exposeInMainWorld("vigilJournal", {
  promptTouchId: () => ipcRenderer.invoke("vigil:journal-touch-id")
});

contextBridge.exposeInMainWorld("vigilApi", {
  request: (path, options = {}) => ipcRenderer.invoke("vigil:api-request", {
    path: String(path || ""),
    method: String(options?.method || "GET"),
    headers: options?.headers && typeof options.headers === "object" ? options.headers : {},
    body: typeof options?.body === "string" ? options.body : ""
  })
});

contextBridge.exposeInMainWorld("vigilAppUpdate", {
  status: (options = {}) => ipcRenderer.invoke("vigil:app-update-status", {
    checkRemote: options?.checkRemote === true
  }),
  start: () => ipcRenderer.invoke("vigil:app-update-start"),
  relaunch: () => ipcRenderer.invoke("vigil:app-relaunch"),
  subscribe: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handleUpdateState = (_event, status) => listener(status);
    ipcRenderer.on("vigil:app-update-state", handleUpdateState);
    return () => ipcRenderer.removeListener("vigil:app-update-state", handleUpdateState);
  },
  subscribeDetails: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handleShowDetails = () => listener();
    ipcRenderer.on("vigil:show-app-update-details", handleShowDetails);
    return () => ipcRenderer.removeListener("vigil:show-app-update-details", handleShowDetails);
  }
});

contextBridge.exposeInMainWorld("vigilAppearance", {
  getIconTheme: () => ipcRenderer.invoke("vigil:icon-theme-get"),
  setIconTheme: (theme) => ipcRenderer.invoke("vigil:icon-theme-set", theme)
});

contextBridge.exposeInMainWorld("vigilSetup", {
  open: (destination) => ipcRenderer.invoke("vigil:setup-open", String(destination || ""))
});

contextBridge.exposeInMainWorld("vigilWindowResize", {
  begin: (edge, screenX, screenY) => ipcRenderer.send("vigil:window-resize-begin", { edge, screenX, screenY }),
  move: (screenX, screenY) => ipcRenderer.send("vigil:window-resize-move", { screenX, screenY }),
  end: () => ipcRenderer.send("vigil:window-resize-end")
});

contextBridge.exposeInMainWorld("vigilWindowActivity", {
  subscribe: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handleActivity = (_event, active) => listener(active === true);
    ipcRenderer.on("vigil:window-activity", handleActivity);
    return () => ipcRenderer.removeListener("vigil:window-activity", handleActivity);
  }
});
