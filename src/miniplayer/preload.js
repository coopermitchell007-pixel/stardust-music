'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stardust', {
  onNowPlaying: (cb) => ipcRenderer.on('stardust:nowplaying', (_e, np) => cb(np)),
  onSpectrum: (cb) => ipcRenderer.on('stardust:spectrum', (_e, bars) => cb(bars)),
  control: (action) => ipcRenderer.send('stardust:miniplayer-control', action)
});
