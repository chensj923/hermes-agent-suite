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
  // v4.10.40：主进程推送一条步骤（追加/更新）
  onStep: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:step', (_event, data) => callback(data));
  },
  // v4.10.40：清空步骤列表
  onClear: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:clear', () => callback());
  },
  // v4.10.40：收起「思考中」横幅（窗口保留）
  onThinkingStop: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:thinking-stop', () => callback());
  },
  // v4.10.40：收起确认卡片（用户已决策）
  onCardHide: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:card-hide', () => callback());
  },
  // v4.10.40：主进程请求关闭窗口
  onClose: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('predict-panel:close', () => callback());
  },
  // 用户点击决策（generate / later / never / behavior）
  // v4.10.27：带主题输入框时，把用户输入一起回传（topic 可为空串）
  // v4.11.0：behaviorId —— 用户点了应用画像里的某个具体行为
  decide: (choice, topic, behaviorId) => {
    ipcRenderer.send('predict-panel:decision', {
      choice,
      topic: String(topic || '').trim(),
      behaviorId: String(behaviorId || '').trim(),
    });
  },
  // v4.10.40：用户点 × 主动关闭浮窗
  close: () => {
    ipcRenderer.send('predict-panel:close');
  },
};

contextBridge.exposeInMainWorld('predictPanelApi', api);
