'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hermesBuddy', {
  connection: () => ipcRenderer.invoke('buddy:connection'),
  connect: (connection) => ipcRenderer.invoke('buddy:connect', connection)
});
