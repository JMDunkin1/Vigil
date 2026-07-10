const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
});

contextBridge.exposeInMainWorld("vigilJournal", {
  promptTouchId: () => ipcRenderer.invoke("vigil:journal-touch-id")
});
