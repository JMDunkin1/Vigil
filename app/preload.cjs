const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
});

contextBridge.exposeInMainWorld("vigilJournal", {
  promptTouchId: () => ipcRenderer.invoke("vigil:journal-touch-id")
});

contextBridge.exposeInMainWorld("vigilAppUpdate", {
  status: (options = {}) => ipcRenderer.invoke("vigil:app-update-status", {
    checkRemote: options?.checkRemote === true
  }),
  start: () => ipcRenderer.invoke("vigil:app-update-start")
});

contextBridge.exposeInMainWorld("vigilAppearance", {
  getIconTheme: () => ipcRenderer.invoke("vigil:icon-theme-get"),
  setIconTheme: (theme) => ipcRenderer.invoke("vigil:icon-theme-set", theme)
});
