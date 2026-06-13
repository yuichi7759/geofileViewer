const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadGeoTIFF:     () => ipcRenderer.invoke("load-geotiff"),
  loadPhotos:      () => ipcRenderer.invoke("load-photos"),
  loadVector:      () => ipcRenderer.invoke("load-vector"),
  saveVector:      (text, defaultName) => ipcRenderer.invoke("save-vector", { text, defaultName }),
  openPhotoWindow: (data) => ipcRenderer.invoke("open-photo-window", data),
  onGeotiffProgress: (cb) => {
    ipcRenderer.on("geotiff-progress", (_event, data) => cb(data));
  },
  rlog: (level, ...args) => ipcRenderer.send("renderer-log", { level, args }),
});
