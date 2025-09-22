const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startSession: (config) => ipcRenderer.invoke('start-session', config),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  sendAudioChunk: (chunk) => ipcRenderer.send('audio-chunk', chunk),
  onTranscript: (callback) => ipcRenderer.on('transcript-update', (_event, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('status-update', (_event, message) => callback(message)),
  onPaneUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pane-update', handler);
    return () => ipcRenderer.removeListener('pane-update', handler);
  },
  onPaneRemoved: (callback) => {
    const handler = (_event, paneId) => callback(paneId);
    ipcRenderer.on('pane-removed', handler);
    return () => ipcRenderer.removeListener('pane-removed', handler);
  },
  getPaneTemplates: () => ipcRenderer.invoke('pane:get-templates'),
  setPaneConfigs: (configs) => ipcRenderer.invoke('pane:set-configs', configs),
  requestPaneRefresh: (paneId) => ipcRenderer.invoke('pane:refresh', paneId),
  oncePaneAvailability: (callback) =>
    ipcRenderer.once('pane-llm-availability', (_event, available) => callback(available)),
});
