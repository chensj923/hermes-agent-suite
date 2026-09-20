'use strict';

/**
 * 浮窗专用 preload：只暴露「接收建议 + 回传决策」两个能力，不暴露 Node / 任意 IPC。
 * 浮窗永远不直连远端、不持有 API Key。
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 主进程推送建议内容
  onSuggestion: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:suggestion', (_event, data) => callback(data));
  },
  // v4.4：主进程通知进入「思考中」加载态
  onThinking: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:thinking', (_event, data) => callback(data));
  },
  // 用户点击决策（generate / later / never）
  // v4.10.27：带主题输入框时，把用户输入一起回传（topic 可为空串）
  decide: (choice, topic) => {
    ipcRenderer.send('predict-panel:decision', { choice, topic: String(topic || '').trim() });
  },
};

contextBridge.exposeInMainWorld('predictPanelApi', api);
