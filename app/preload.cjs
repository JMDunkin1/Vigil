const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
});

contextBridge.exposeInMainWorld("sentinelJournal", {
  promptTouchId: () => ipcRenderer.invoke("sentinel:journal-touch-id")
});

contextBridge.exposeInMainWorld("sentinelAppUpdate", {
  status: (options = {}) => ipcRenderer.invoke("sentinel:app-update-status", {
    checkRemote: options?.checkRemote === true
  }),
  start: () => ipcRenderer.invoke("sentinel:app-update-start")
});
