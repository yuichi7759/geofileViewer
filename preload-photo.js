const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("photoApi", {
  onShowPhoto: (cb) => ipcRenderer.on("show-photo", (_, data) => cb(data)),
});
