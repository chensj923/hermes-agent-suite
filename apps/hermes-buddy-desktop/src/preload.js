'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHAT_EVENT = 'buddy:chat:event';

/**
 * 渲染层只拿到这一层能力：能发指令、能收事件，但拿不到 Node、拿不到 API Key。
 * API Key 全程留在主进程，任何 get* 接口都不会把它带出来。
 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 事件订阅统一返回取消函数，避免渲染层自己管理 removeListener 出错。 */
function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // ---- 连接 ----
  // 保留早期渲染层用过的别名，避免旧页面直接白屏。
  connection: () => invoke('buddy:connection'),
  send: (request) => invoke('buddy:chat', request),
  checkUpdate: () => invoke('buddy:update'),

  status: () => invoke('buddy:status'),
  connect: (connection) => invoke('buddy:connect', connection),
  resume: () => invoke('buddy:resume'),
  disconnect: () => invoke('buddy:disconnect'),
  models: () => invoke('buddy:models'),
  history: () => invoke('buddy:history'),
  clearHistory: () => invoke('buddy:clear-history'),
  provisioningStatus: () => invoke('buddy:provisioning-status'),
  appInfo: () => invoke('buddy:app-info'),

  // ---- 对话 ----
  chat: (request) => invoke('buddy:chat', request),
  abort: (requestId) => invoke('buddy:chat:abort', requestId),
  onChatEvent: (handler) => subscribe(CHAT_EVENT, handler),
  onConfirmRequest: (handler) => subscribe('buddy:confirm:request', handler),
  replyConfirm: (id, approved) => invoke('buddy:confirm:reply', { id, approved }),

  // ---- 工作区 ----
  workspace: () => invoke('buddy:workspace'),
  setWorkspace: (dir) => invoke('buddy:workspace:set', dir),
  pickWorkspace: () => invoke('buddy:workspace:pick'),
  openWorkspace: (target) => invoke('buddy:workspace:open', target),

  // ---- 权限 ----
  setPermission: (level) => invoke('buddy:permission:set', level),

  // ---- 角色 / 记忆 / 技能 ----
  persona: () => invoke('buddy:persona'),
  savePersona: (text) => invoke('buddy:persona:save', text),
  memory: (scope) => invoke('buddy:memory', scope),
  saveMemory: (scope, content) => invoke('buddy:memory:save', { scope, content }),
  remember: (scope, line) => invoke('buddy:memory:remember', { scope, line }),
  skills: () => invoke('buddy:skills'),
  readSkill: (name) => invoke('buddy:skills:read', name),
  saveSkill: (name, content, description) => invoke('buddy:skills:save', { name, content, description }),
  removeSkill: (name) => invoke('buddy:skills:remove', name),

  // ---- 环境 ----
  toolchain: () => invoke('buddy:toolchain'),
  installTool: (id) => invoke('buddy:toolchain:install', id),

  // ---- 其它 ----
  update: () => invoke('buddy:update'),
  openExternal: (url) => invoke('buddy:open-external', url)
};

contextBridge.exposeInMainWorld('buddyApi', api);
// 兼容旧页面
contextBridge.exposeInMainWorld('hermesBuddy', api);
