'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytmplus', {
  onNowPlaying: (cb) => ipcRenderer.on('ytmplus:nowplaying', (_e, np) => cb(np)),
  control: (action) => ipcRenderer.send('ytmplus:miniplayer-control', action)
});
