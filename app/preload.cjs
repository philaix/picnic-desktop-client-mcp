const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picnic", {
  call: (method, ...args) => ipcRenderer.invoke("picnic", method, args),
  onCartChanged: (callback) => ipcRenderer.on("cart-changed", () => callback()),
  onDishesChanged: (callback) => ipcRenderer.on("dishes-changed", () => callback()),
});
