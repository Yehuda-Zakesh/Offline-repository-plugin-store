const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getPlugins: () => ipcRenderer.invoke('get-plugins'),
  getPlugin: (id) => ipcRenderer.invoke('get-plugin', id),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  getInstalledPlugins: () => ipcRenderer.invoke('get-installed-plugins'),
  downloadPlugin: (id) => ipcRenderer.invoke('download-plugin', id),
  directInstallPlugin: (id) => ipcRenderer.invoke('direct-install-plugin', id),
  openInstallUrl: (url) => ipcRenderer.invoke('open-install-url', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onSyncProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sync-progress', listener)
    return () => ipcRenderer.removeListener('sync-progress', listener)
  }
})
