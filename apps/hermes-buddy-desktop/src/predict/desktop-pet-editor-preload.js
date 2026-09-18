'use strict';

/** 桌宠文案编辑窗口 preload：只暴露读/存台词两个能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editorApi', {
  getLines: () => ipcRenderer.invoke('pet-lines:get'),
  saveLines: (text) => ipcRenderer.invoke('pet-lines:save', text),
});
