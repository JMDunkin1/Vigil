const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
});

contextBridge.exposeInMainWorld("sentinelJournal", {
  promptTouchId: () => ipcRenderer.invoke("sentinel:journal-touch-id")
});
