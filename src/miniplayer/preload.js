'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stardust', {
  onNowPlaying: (cb) => ipcRenderer.on('stardust:nowplaying', (_e, np) => cb(np)),
  control: (action) => ipcRenderer.send('stardust:miniplayer-control', action)
});
