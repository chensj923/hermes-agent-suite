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
  disconnectAndClearCache: () => invoke('buddy:disconnect-and-clear-cache'),
  profiles: () => invoke('buddy:profiles'),
  activateProfile: (id) => invoke('buddy:profile:activate', id),
  removeProfile: (id) => invoke('buddy:profile:remove', id),
  probeProfile: (profile) => invoke('buddy:profile:probe', profile),
  models: () => invoke('buddy:models'),
  reconcileModel: () => invoke('buddy:model:reconcile'),
  setActiveModel: (model, agentScope) => invoke('buddy:model:set', { model, agentScope }),
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

  // ---- 智能体 ----
  agents: () => invoke('buddy:agents'),
  createAgent: (input) => invoke('buddy:agents:create', input || {}),
  updateAgent: (id, patch) => invoke('buddy:agents:update', { id, patch: patch || {} }),
  removeAgent: (id) => invoke('buddy:agents:remove', id),
  activateAgent: (id) => invoke('buddy:agents:activate', id),

  // ---- 工作区 ----
  workspace: () => invoke('buddy:workspace'),
  setWorkspace: (dir) => invoke('buddy:workspace:set', dir),
  pickWorkspace: () => invoke('buddy:workspace:pick'),
  pickWorkspacePath: () => invoke('buddy:workspace:dialog'),
  openWorkspace: (target) => invoke('buddy:workspace:open', target),

  // ---- 权限 ----
  setPermission: (level) => invoke('buddy:permission:set', level),

  // ---- 角色 / 记忆 / 技能 ----
  persona: () => invoke('buddy:persona'),
  savePersona: (text) => invoke('buddy:persona:save', text),
  memory: (scope) => invoke('buddy:memory', scope),
  saveMemory: (scope, content) => invoke('buddy:memory:save', { scope, content }),
  remember: (scope, line) => invoke('buddy:memory:remember', { scope, line }),
  memoryDiagnostics: () => invoke('buddy:memory:diagnostics'),
  skills: () => invoke('buddy:skills'),
  readSkill: (name) => invoke('buddy:skills:read', name),
  saveSkill: (name, content, description) => invoke('buddy:skills:save', { name, content, description }),
  removeSkill: (name) => invoke('buddy:skills:remove', name),

  // ---- 环境 ----
  toolchain: () => invoke('buddy:toolchain'),
  installTool: (id) => invoke('buddy:toolchain:install', id),

  // ---- 本地媒体引擎（语音/视频本地转写用） ----
  mediaEngineStatus: () => invoke('buddy:media-engines:status'),
  installMediaEngines: (opts) => invoke('buddy:media-engines:install', opts || {}),
  openMediaEngineDir: () => invoke('buddy:media-engines:open-dir'),
  onMediaEngineProgress: (handler) => subscribe('buddy:media-engines:progress', handler),

  // ---- 诊断 + 服务端准备脚本 ----
  diagnose: (options) => invoke('buddy:diagnose', options || {}),
  bootstrapScript: (options) => invoke('buddy:bootstrap-script', options || {}),
  exportBootstrap: (payload) => invoke('buddy:bootstrap-export', payload || {}),

  // ---- 服务端部署压缩包 ----
  deployInit: (opts) => invoke('buddy:deploy-init', opts || {}),
  deployBundlePath: () => invoke('buddy:deploy-bundle-path'),
  exportDeployBundle: () => invoke('buddy:export-deploy-bundle'),
  downloadChannelScript: () => invoke('buddy:download-channel-script'),
  downloadDeploySh: () => invoke('buddy:download-deploy-sh'),
  pickSshKey: () => invoke('buddy:deploy-keypick'),
  deployToServer: (opts) => invoke('buddy:deploy-to-server', opts || {}),
  sshCheck: (opts) => invoke('buddy:ssh-check', opts || {}),
  onDeployProgress: (handler) => subscribe('buddy:deploy:progress', handler),

  // ---- 其它 ----
  update: () => invoke('buddy:update'),
  downloadUpdate: (info) => invoke('buddy:update:download', info || {}),
  installUpdate: () => invoke('buddy:update:install'),
  onUpdateProgress: (handler) => subscribe('buddy:update:progress', handler),
  openExternal: (url) => invoke('buddy:open-external', url),

  // ---- 预测模式（v4.0） ----
  predictStatus: () => invoke('buddy:predict:status'),
  predictEnable: () => invoke('buddy:predict:enable'),
  predictDisable: () => invoke('buddy:predict:disable'),
  predictOneClickOff: () => invoke('buddy:predict:one-click-off'),
  predictSetSensitivity: (s) => invoke('buddy:predict:set-sensitivity', s),
  predictSetAuthorized: (v) => invoke('buddy:predict:set-authorized', v),
  predictCrystallization: () => invoke('buddy:predict:crystallization'),
  experienceSummary: () => invoke('buddy:experience:summary'),
  experienceList: () => invoke('buddy:experience:list'),
  predictTrigger: (rule) => invoke('buddy:predict:trigger', rule),
  predictEngineStatus: () => invoke('buddy:predict:engine-status'),
  predictAv: (opts) => invoke('buddy:predict:av', opts || {}),
  predictInstallEngine: () => invoke('buddy:predict:install-engine'),
  predictModelPick: () => invoke('buddy:predict:model-pick'),
  predictMmprojPick: () => invoke('buddy:predict:mmproj-pick'),
  predictModelReset: () => invoke('buddy:predict:model-reset'),
  onPredictEngineProgress: (handler) => subscribe('buddy:predict:engine-progress', handler),
  predictNow: () => invoke('buddy:predict:now'),
  predictSetPatrol: (minutes) => invoke('buddy:predict:set-patrol', minutes),
  // v4.10.24：场景规则（结晶场景）
  sceneRulesGet: () => invoke('buddy:predict:scene-rules:get'),
  sceneRulesSet: (list) => invoke('buddy:predict:scene-rules:set', list),
  sceneRulesToggle: (on) => invoke('buddy:predict:scene-rules:toggle', on),
  insertModeGet: () => invoke('buddy:predict:insert-mode:get'),
  insertModeSet: (mode) => invoke('buddy:predict:insert-mode:set', mode),
  // v4.10.18：推理记录
  predictLog: () => invoke('buddy:predict:log'),
  predictClearLog: () => invoke('buddy:predict:clear-log'),
  onPredictLogEntry: (handler) => subscribe('buddy:predict:log-entry', handler),

  // ---- 语音（v4.12.14：TTS/STT）----
  voiceStatus: () => invoke('buddy:voice:status'),
  voiceSet: (patch) => invoke('buddy:voice:set', patch || {}),
  voiceGetVoices: () => invoke('buddy:voice:get-voices'),
  voiceEngineStatus: () => invoke('buddy:voice:engine-status'),
  voiceSpeak: (text) => invoke('buddy:voice:speak', text),
  voiceStartListen: () => invoke('buddy:voice:start-listen'),
  voiceStopListen: () => invoke('buddy:voice:stop-listen'),
  voiceListen: (on) => invoke('buddy:voice:listen', typeof on === 'boolean' ? on : undefined),
  voiceProbe: () => invoke('buddy:voice:probe'),
  onVoiceTranscript: (handler) => subscribe('buddy:voice:transcript', handler),
  onVoiceError: (handler) => subscribe('buddy:voice:error', handler),
  // v4.12.18：没有桌宠窗口时，TTS 的 WAV 由主窗口播放（{path, url, speakerId}）
  onVoicePlay: (handler) => subscribe('buddy:voice:play', handler),

  // ---- 桌宠猫咪（v4.1） ----
  petMinimize: () => invoke('buddy:pet:minimize'),
  petRestore: () => invoke('buddy:pet:restore'),
  petHide: () => invoke('buddy:pet:hide'),
  petStatus: () => invoke('buddy:pet:status'),
  petModelPick: () => invoke('buddy:pet:model-pick'),
  petModelReset: () => invoke('buddy:pet:model-reset'),
  petModelStatus: () => invoke('buddy:pet:model-status')
};

contextBridge.exposeInMainWorld('buddyApi', api);
// 兼容旧页面
contextBridge.exposeInMainWorld('hermesBuddy', api);
