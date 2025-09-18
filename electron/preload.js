const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startSession: (config) => ipcRenderer.invoke('start-session', config),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  sendAudioChunk: (chunk) => ipcRenderer.send('audio-chunk', chunk),
  onTranscript: (callback) => ipcRenderer.on('transcript-update', (_event, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('status-update', (_event, message) => callback(message)),
  onNotes: (callback) => ipcRenderer.on('notes-update', (_event, data) => callback(data)),
  onNotesStatus: (callback) => ipcRenderer.on('notes-status', (_event, status) => callback(status)),
  onceNotesAvailability: (callback) => ipcRenderer.once('notes-availability', (_event, available) => callback(available)),
});
