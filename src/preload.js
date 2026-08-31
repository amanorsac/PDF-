const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('dialog:openPdf'),
  openMultiplePdfs: () => ipcRenderer.invoke('dialog:openMultiplePdfs'),
  savePdfAs: (suggestedName, bytes) =>
    ipcRenderer.invoke('dialog:savePdf', { suggestedName, bytes }),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('file:write', { filePath, bytes }),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  statFile: (filePath) => ipcRenderer.invoke('file:stat', filePath),
  onMenu: (channel, cb) => {
    const valid = ['menu:open', 'menu:save', 'menu:saveas', 'menu:merge'];
    if (valid.includes(channel)) ipcRenderer.on(channel, cb);
  },
  onOpenPath: (cb) => ipcRenderer.on('file:openpath', (_evt, payload) => cb(payload))
});
