// What the /companion page is allowed to ask the desktop app for. Nothing
// else from the computer is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmer3Desktop', {
  isDesktop: true,
  platform: process.platform,
  capture: () => ipcRenderer.invoke('capture'),
  getIdle: () => ipcRenderer.invoke('idle'),
  getWifiName: () => ipcRenderer.invoke('wifi'),
  getWifi: () => ipcRenderer.invoke('wifi-info'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  permissions: () => ipcRenderer.invoke('permissions'),
  openPrivacySettings: () => ipcRenderer.invoke('open-privacy-settings'),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setStatus: (status) => ipcRenderer.invoke('set-status', status),
  onPower: (callback) => {
    const listener = (_e, evt) => callback(evt);
    ipcRenderer.on('power', listener);
    return () => ipcRenderer.removeListener('power', listener);
  }
});
