'use strict';

/**
 * 渲染层：只做界面。所有网络、文件系统与凭据操作都走 preload 暴露的 buddyApi，
 * 渲染进程拿不到 Node、拿不到 API Key、也拿不到任何凭据明文。
 * 模型输出永远用 textContent 落地，杜绝把它当 HTML 解释。
 */

const api = window.buddyApi || window.hermesBuddy;
const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const el = {
  // 连接向导
  viewConnect: $('view-connect'),
  step0: $('wizard-step-0'),
  step1: $('wizard-step-1'),
  step2: $('wizard-step-2'),
  connectForm: $('connect-form'),
  fieldHost: $('field-host'),
  fieldHostConfirm: $('field-host-confirm'),
  fieldApiKey: $('field-apiKey'),
  fieldSshUser: $('field-ssh-user'),
  fieldSshPort: $('field-ssh-port'),
  fieldSshPassword: $('field-ssh-password'),
  fieldSshKey: $('field-ssh-key'),
  fieldBaseUrl: $('field-baseUrl'),
  fieldProfile: $('field-profile'),
  fieldModel: $('field-model'),
  fieldWorkspace: $('field-workspace'),
  fieldChannelUrl: $('field-channelUrl'),
  btnChoiceExisting: $('btn-choice-existing'),
  btnChoiceNew: $('btn-choice-new'),
  btnChoiceManual: $('btn-choice-manual'),
  manualDeployPanel: $('manual-deploy-panel'),
  btnManualDeploySh: $('btn-manual-deploy-sh'),
  btnManualChannelSh: $('btn-manual-channel-sh'),
  btnManualBundle: $('btn-manual-bundle'),
  manualDeployStatus: $('manual-deploy-status'),
  btnWizardBack: $('btn-wizard-back'),
  btnWizardBack0: $('btn-wizard-back-0'),
  btnWizardBack2: $('btn-wizard-back-2'),
  upstreamForm: $('upstream-form'),
  fieldUpstreamBase: $('field-upstream-base'),
  fieldUpstreamKey: $('field-upstream-key'),
  fieldUpstreamModel: $('field-upstream-model'),
  fieldHermesIndex: $('field-hermes-index'),
  fieldHermesExtraIndex: $('field-hermes-extra-index'),
  btnWizardAction: $('btn-wizard-action'),
  btnPickKey: $('btn-pick-key'),
  btnPickWorkspace: $('btn-pick-workspace'),
  btnConnect: $('btn-connect'),
  wizardLog: $('wizard-log'),
  connectStatus: $('connect-status'),
  connectStatus2: $('connect-status-2'),
  step1Title: $('step1-title'),
  step1Sub: $('step1-sub'),
  diagnoseReport: $('diagnose-report'),

  // 主应用
  app: $('app'),
  gatewayLabel: $('gateway-label'),

  // 左侧边栏
  sidebar: $('sidebar'),
  sessionList: $('session-list'),
  btnNewChat: $('btn-new-chat'),
  btnUpdate: $('btn-update'),
  btnSettings: $('btn-settings'),
  btnDisconnect: $('btn-disconnect'),

  // 聊天区
  chatTitle: $('chat-title'),
  statusDot: $('status-dot'),
  modelSelect: $('model-select'),
  btnReconnect: $('btn-reconnect'),
  btnClearChat: $('btn-clear-chat'),
  chatLog: $('chat-log'),
  toolLog: $('tool-log'),
  toolEmpty: $('tool-empty'),
  btnToolClear: $('btn-tool-clear'),
  composer: $('composer'),
  input: $('input'),
  btnSend: $('btn-send'),
  btnStop: $('btn-stop'),
  workdirTag: $('workdir-tag'),
  permBadge: $('perm-badge'),

  // 多模态附件（图片 / 文件 / 语音 / 视频）
  attachStrip: $('attach-strip'),
  btnAttach: $('btn-attach'),
  btnRecord: $('btn-record'),
  recordTip: $('record-tip'),
  fileInput: $('file-input'),
  attachLimit: $('attach-limit'),

  // 右侧上下文面板（集成设置）
  contextPanel: $('context-panel'),
  contextTitle: $('context-title'),
  contextTabs: $('context-tabs'),
  contextBody: $('context-body'),
  btnContextClose: $('btn-context-close'),

  // 横幅
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  bannerDismiss: $('banner-dismiss'),

  // 权限确认
  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmBody: $('confirm-body'),
  confirmDetail: $('confirm-detail'),
  confirmApprove: $('btn-confirm-approve'),
  confirmDeny: $('btn-confirm-deny'),

  // 服务端脚本弹窗
  bootstrapDialog: $('bootstrap-dialog'),
  bootstrapScript: $('bootstrap-script'),
  bootstrapCopy: $('btn-bootstrap-copy'),
  bootstrapExport: $('btn-bootstrap-export'),
  bootstrapClose: $('btn-bootstrap-close'),
  bootstrapStatus: $('bootstrap-status'),

  // 服务端部署压缩包
  btnExportBundle: $('btn-export-bundle'),
  btnDownloadChannelScript: $('btn-download-channel-script'),
  btnDownloadDeploySh: $('btn-download-deploy-sh'),
  btnDeployInit: $('btn-deploy-init'),
  btnDeployToggle: $('btn-deploy-toggle'),
  deployPanel: $('deploy-panel'),
  deployHost: $('deploy-host'),
  deployUser: $('deploy-user'),
  deployPort: $('deploy-port'),
  deployKey: $('deploy-key'),
  deployPassword: $('deploy-password'),
  btnDeployKeypick: $('btn-deploy-keypick'),
  btnDeployServer: $('btn-deploy-server'),
  deployOutput: $('deploy-output'),

  // 多网关（已保存连接）
  connectProfiles: $('connect-profiles'),
  connectProfilesList: $('connect-profiles-list'),
  btnAddConn: $('btn-add-conn'),
  btnManageConn: $('btn-manage-conn'),

  // 新建智能体弹窗
  agentCreateDialog: $('agent-create-dialog'),
  acName: $('ac-name'),
  acWorkspace: $('ac-workspace'),
  acModel: $('ac-model'),
  acPick: $('ac-pick'),
  acCancel: $('ac-cancel'),
  acSave: $('ac-save'),
  acStatus: $('ac-status'),

  // 通道路径前缀
  fieldChannelPath: $('field-channel-path'),

  // 底部
  foot: $('foot')
};

const state = {
  activeRequestId: null,
  pendingBubble: null,
  pendingTools: new Map(),     // tool_call_id → 卡片 DOM
  currentView: 'connect',
  wizardMode: null,
  wizardStep: 0,
  wizardFromProfiles: false,
  sshHost: '',
  sshResult: null,
  settingsTab: 'persona',
  bannerActionUrl: null,
  bannerActionClick: null,
  updateDownloading: false,
  pendingConfirm: null,         // confirmId

  // ---- 多模态附件 ----
  attachments: [],              // [{ id, kind, name, mime, size, previewUrl, text, data }]
  recording: null,              // { recorder, stream, chunks, startedAt, timer }
  upstream: '',                 // 服务端实际在调的模型地址（连接后上报，出错提示用）
  mediaInstallNode: null,       // 安装本地引擎时的进度气泡（用于就地更新文案）
};

// ============================================================ 顶栏 / 横幅

function setStatusDot(s) { el.statusDot.dataset.state = s; }

function showBanner(text, tone = 'info', action = null) {
  el.bannerText.textContent = text;
  el.banner.dataset.tone = tone;
  el.banner.hidden = false;
  // action 支持 { label, url }（外链）或 { label, onClick }（本地动作，如"立即重启安装"）。
  if (action && action.label && action.onClick) {
    el.bannerAction.textContent = action.label;
    el.bannerAction.hidden = false;
    state.bannerActionUrl = null;
    state.bannerActionClick = action.onClick;
  } else if (action && action.label && action.url) {
    el.bannerAction.textContent = action.label;
    el.bannerAction.hidden = false;
    state.bannerActionUrl = action.url;
    state.bannerActionClick = null;
  } else {
    el.bannerAction.hidden = true;
    state.bannerActionUrl = null;
    state.bannerActionClick = null;
  }
}

function hideBanner() { el.banner.hidden = true; }

// ============================================================ 视图切换

function showView(name) {
  state.currentView = name;
  const isConnect = name === 'connect';
  const isSettings = name === 'settings';
  el.viewConnect.hidden = !isConnect;
  el.app.hidden = isConnect;
  el.contextPanel.hidden = !isSettings;
  el.btnDisconnect.hidden = isConnect;
  el.btnReconnect.hidden = isConnect;
  el.btnClearChat.hidden = isConnect;
  el.btnSettings.classList.toggle('active', isSettings);
  el.modelSelect.disabled = isConnect;
  if (isSettings) renderSettings();
  else if (name === 'chat') el.input.focus();
}

// ============================================================ 连接向导

function setConnectStatus(text, tone = 'info') {
  if (el.connectStatus) { el.connectStatus.textContent = text; el.connectStatus.dataset.tone = tone; }
  if (el.connectStatus2) { el.connectStatus2.textContent = text; el.connectStatus2.dataset.tone = tone; }
}

function setWizardLog(text) {
  if (!el.wizardLog) return;
  el.wizardLog.textContent = (el.wizardLog.textContent || '') + text;
  el.wizardLog.hidden = false;
  el.wizardLog.scrollTop = el.wizardLog.scrollHeight;
}

function clearWizardLog() {
  if (!el.wizardLog) return;
  el.wizardLog.textContent = '';
  el.wizardLog.hidden = true;
}

function showWizardStep(step) {
  state.wizardStep = step;
  el.step0.hidden = step !== 0;
  el.step1.hidden = step !== 1;
  el.step2.hidden = step !== 2;
  clearWizardLog();
}

function deriveBaseUrl(host) {
  const raw = String(host || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return 'http://' + url.hostname + ':' + (url.port || '22122');
  }
  const m = raw.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return '';
  return 'http://' + m[1] + ':' + (m[2] || '22122');
}

function deriveChannelUrl(hostValue, channelPath) {
  const raw = String(hostValue || '').trim();
  if (!raw) return '';
  let host;
  if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  else { const m = raw.match(/^([^:]+)(?::(\d+))?$/); host = m ? m[1] : raw; }
  const path = String(channelPath || '/api/buddy/channel').trim() || '/api/buddy/channel';
  return 'ws://' + host + ':8822' + path;
}

function deriveDashboardUrl(hostValue) {
  const raw = String(hostValue || '').trim();
  if (!raw) return '';
  let host;
  if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  else { const m = raw.match(/^([^:]+)(?::(\d+))?$/); host = m ? m[1] : raw; }
  return 'http://' + host + ':9119';
}

function hostFromConnection(status) {
  const source = (status && (status.baseUrl || status.llmUrl || status.channelUrl)) || '';
  if (!source) return '';
  try { const url = new URL(source); return url.hostname + ':' + (url.port || '22122'); } catch (_) { return source; }
}

// 步骤 0：选择按钮
el.btnChoiceExisting.addEventListener('click', () => {
  state.wizardMode = 'existing';
  el.step1Title.textContent = '检查已部署的 Hermes';
  el.step1Sub.textContent = '填入 SSH 信息，自动检查部署状态并获取 API Key';
  if (el.upstreamForm) el.upstreamForm.hidden = true;
  el.btnWizardAction.textContent = '检查并连接';
  if (el.manualDeployPanel) el.manualDeployPanel.hidden = true;
  showWizardStep(1);
  el.fieldHost.focus();
});

el.btnChoiceNew.addEventListener('click', () => {
  state.wizardMode = 'new';
  el.step1Title.textContent = '完整部署 Hermes（含服务端本体）';
  el.step1Sub.textContent = '填入 SSH 信息和上游模型供应商，一键安装 Hermes 服务端本体 + 部署 WS 通道';
  el.btnWizardAction.textContent = '完整部署并连接';
  if (el.manualDeployPanel) el.manualDeployPanel.hidden = true;
  if (el.upstreamForm) el.upstreamForm.hidden = false;
  showWizardStep(1);
  el.fieldHost.focus();
});

el.btnChoiceManual.addEventListener('click', () => {
  state.wizardMode = 'manual';
  state.sshHost = '';
  el.fieldHostConfirm.value = '';
  el.fieldApiKey.value = '';
  el.fieldBaseUrl.value = '';
  el.fieldChannelUrl.value = '';
  if (el.fieldDashboardUrl) el.fieldDashboardUrl.value = '';
  el.fieldHostConfirm.placeholder = '填入 Hermes 主机 IP 或域名';
  el.fieldHostConfirm.readOnly = false;
  if (el.fieldMode) el.fieldMode.value = 'dashboard';
  el.step1Title.textContent = '手动配置连接';
  el.step1Sub.textContent = '直接填入 Hermes 地址和 API Key（适合 Docker / 已自部署）';
  if (el.manualDeployPanel) el.manualDeployPanel.hidden = false;
  showWizardStep(2);
  el.fieldHostConfirm.focus();
});

// SSH 输入实时校验
function validateSshForm() {
  const host = el.fieldHost.value.trim();
  const key = el.fieldSshKey.value.trim();
  const pass = el.fieldSshPassword.value.trim();
  el.btnWizardAction.disabled = !host || (!key && !pass);
}
el.fieldHost.addEventListener('input', validateSshForm);
el.fieldSshKey.addEventListener('input', validateSshForm);
el.fieldSshPassword.addEventListener('input', validateSshForm);

// 模式切换：显示对应的选填地址字段
if (el.fieldMode) {
  el.fieldMode.addEventListener('change', () => {
    const isChannel = el.fieldMode.value === 'channel';
    if (el.fieldChannelWrap) el.fieldChannelWrap.hidden = !isChannel;
    if (el.fieldDashboardWrap) el.fieldDashboardWrap.hidden = isChannel;
  });
}

el.btnPickKey.addEventListener('click', async () => {
  try {
    const result = await api.pickSshKey();
    if (result && result.path) { el.fieldSshKey.value = result.path; validateSshForm(); }
  } catch (e) { setWizardLog('选择私钥失败: ' + e.message + '\n'); }
});

el.btnWizardBack.addEventListener('click', () => showWizardStep(0));

// 步骤 2 的"返回选择部署方式"按钮（手动配置模式）
if (el.btnWizardBack2) {
  el.btnWizardBack2.addEventListener('click', () => {
    if (el.manualDeployPanel) el.manualDeployPanel.hidden = true;
    if (el.btnWizardBack0) el.btnWizardBack0.hidden = !state.wizardFromProfiles;
    showWizardStep(0);
  });
}

let _deploySubscribed = false;
function ensureDeploySubscribed() {
  if (_deploySubscribed) return;
  api.onDeployProgress(({ text }) => setWizardLog(text));
  _deploySubscribed = true;
}

// 步骤 1 -> 2：执行 SSH 检查或部署
el.btnWizardAction.addEventListener('click', async () => {
  const host = el.fieldHost.value.trim();
  const user = el.fieldSshUser.value.trim() || 'root';
  const sshPort = Number(el.fieldSshPort.value.trim()) || 22;
  const keyPath = el.fieldSshKey.value.trim();
  const password = el.fieldSshPassword.value.trim();
  // 全新部署模式的上游参数
  const upstreamBase = el.fieldUpstreamBase ? el.fieldUpstreamBase.value.trim() : '';
  const upstreamKey = el.fieldUpstreamKey ? el.fieldUpstreamKey.value.trim() : '';
  const upstreamModel = el.fieldUpstreamModel ? el.fieldUpstreamModel.value.trim() : '';
  // 完整部署：Hermes 安装源（可选，默认 PyPI）
  const hermesIndexUrl = el.fieldHermesIndex ? el.fieldHermesIndex.value.trim() : '';
  const hermesExtraIndexUrl = el.fieldHermesExtraIndex ? el.fieldHermesExtraIndex.value.trim() : '';
  if (!host) { setWizardLog('请填写服务器地址\n'); return; }
  if (!keyPath && !password) { setWizardLog('请填 SSH 密码或私钥路径\n'); return; }
  // 全新部署时验证上游参数
  if (state.wizardMode === 'new') {
    if (!upstreamBase) { setWizardLog('请填写上游 API 地址\n'); return; }
    if (!upstreamKey) { setWizardLog('请填写上游 API Key\n'); return; }
    if (!upstreamModel) { setWizardLog('请填写模型名称\n'); return; }
  }

  ensureDeploySubscribed();
  el.btnWizardAction.disabled = true;
  el.btnWizardBack.disabled = true;
  clearWizardLog();

  try {
    if (state.wizardMode === 'existing') {
      setWizardLog('正在通过 SSH 检查 Hermes 部署状态…\n');
      let result = await api.sshCheck({ host, user, keyPath, password, sshPort });
      if (!result.ok) { setWizardLog('SSH 连接失败: ' + (result.error || '未知错误') + '\n'); return; }
      if (!result.deployed) { setWizardLog('\n服务器上尚未部署 Hermes，请返回选择全新部署。\n'); return; }
      // 服务端通道过旧：ssh-check 本身不部署，这里自动补一次升级部署。
      // 不带上游参数 —— deploy.sh 检测不到 BUDDY_UPSTREAM_* 就不会动 buddy-proxy.env，
      // 服务端现有的上游配置原样保留。
      if (result.channelOutdated) {
        setWizardLog('\n检测到服务端通道版本过旧（' + (result.channelVersion || '未知') + '，客户端需要 1.1+），正在自动升级部署…\n');
        const initResult = await api.deployInit({});
        if (!initResult.ok) { setWizardLog('初始化部署包失败: ' + (initResult.error || '未知错误') + '\n'); return; }
        const deployResult = await api.deployToServer({ host, user, keyPath, password, sshPort });
        if (!deployResult.ok) { setWizardLog('\n自动升级部署失败（退出码 ' + deployResult.code + '）。请检查上方日志，或返回改用「全新部署」。\n'); return; }
        setWizardLog('\n升级部署完成，重新检查服务端…\n');
        result = await api.sshCheck({ host, user, keyPath, password, sshPort });
        if (!result.ok) { setWizardLog('复查失败: ' + (result.error || '未知错误') + '\n'); return; }
        if (result.channelOutdated) { setWizardLog('\n部署后通道版本仍过旧（' + (result.channelVersion || '未知') + '），请到服务器上手动重跑 deploy.sh。\n'); return; }
      }
      if (!result.apiKey) { setWizardLog('\n已部署但未找到 API Key，请手动检查服务端配置。\n'); return; }
      if (result.proxyEnv === 'no') {
        setWizardLog('\n注意：服务端没有 buddy-proxy.env（上游未配置），对话会报「上游未配置」。如需填写上游，请返回改用「全新部署」。\n');
      }
      state.sshHost = host;
      state.sshResult = result;
      el.fieldHostConfirm.value = host;
      el.fieldApiKey.value = result.apiKey;
      el.fieldBaseUrl.value = deriveBaseUrl(host);
      el.fieldChannelUrl.value = deriveChannelUrl(host, el.fieldChannelPath.value || '/api/buddy/channel');
      if (el.fieldDashboardUrl) el.fieldDashboardUrl.value = deriveDashboardUrl(host);
      // SSH 部署的是 WS 通道（:8822），默认选 channel 模式
      if (el.fieldMode) el.fieldMode.value = 'channel';
      setWizardLog('\n检查完成！API Key: ' + result.apiKey.slice(0,4) + '****\n通道: ' + (result.channelUp ? 'OK' : '未监听') + '\n代理: ' + (result.proxyUp ? 'OK' : '未监听') + '\n');
      showWizardStep(2);
    } else {
      setWizardLog('正在初始化部署包…\n');
      const initResult = await api.deployInit({});
      if (!initResult.ok) { setWizardLog('初始化失败: ' + initResult.error + '\n'); return; }
      setWizardLog('正在通过 SSH 推送并部署…\n');
      const deployResult = await api.deployToServer({ host, user, keyPath, password, sshPort, upstreamBase, upstreamKey, upstreamModel, installHermes: true, hermesIndexUrl, hermesExtraIndexUrl });
      if (!deployResult.ok) { setWizardLog('\n部署失败（退出码 ' + deployResult.code + '）。请检查上方日志。\n'); return; }
      setWizardLog('\n部署完成，正在检查服务状态并获取 API Key…\n');
      const checkResult = await api.sshCheck({ host, user, keyPath, password, sshPort });
      if (!checkResult.ok || !checkResult.apiKey) {
        setWizardLog('\n部署已完成但未能自动获取 API Key，请手动执行 cat ~/.hermes/.api_server_key\n');
        state.sshHost = host;
        el.fieldHostConfirm.value = host;
        el.fieldBaseUrl.value = deriveBaseUrl(host);
        el.fieldChannelUrl.value = deriveChannelUrl(host, el.fieldChannelPath.value || '/api/buddy/channel');
        if (el.fieldDashboardUrl) el.fieldDashboardUrl.value = deriveDashboardUrl(host);
        if (el.fieldMode) el.fieldMode.value = 'channel';
        showWizardStep(2);
        return;
      }
      state.sshHost = host;
      state.sshResult = checkResult;
      el.fieldHostConfirm.value = host;
      el.fieldApiKey.value = checkResult.apiKey;
      el.fieldBaseUrl.value = deriveBaseUrl(host);
      el.fieldChannelUrl.value = deriveChannelUrl(host, el.fieldChannelPath.value || '/api/buddy/channel');
      if (el.fieldDashboardUrl) el.fieldDashboardUrl.value = deriveDashboardUrl(host);
      // SSH 部署的是 WS 通道（:8822），默认选 channel 模式
      if (el.fieldMode) el.fieldMode.value = 'channel';
      setWizardLog('\n部署成功！API Key: ' + checkResult.apiKey.slice(0,4) + '****\n通道: ' + (checkResult.channelUp ? 'OK' : '未监听') + '\n代理: ' + (checkResult.proxyUp ? 'OK' : '未监听') + '\n');
      showWizardStep(2);
    }
  } catch (error) {
    setWizardLog('\n操作失败: ' + error.message + '\n');
  } finally {
    el.btnWizardAction.disabled = false;
    el.btnWizardBack.disabled = false;
    validateSshForm();
  }
});

// 手动配置面板：脚本下载按钮
if (el.btnManualDeploySh) {
  el.btnManualDeploySh.addEventListener('click', async () => {
    try {
      el.btnManualDeploySh.disabled = true;
      const result = await api.downloadDeploySh();
      if (!result || result.error) {
        el.manualDeployStatus.textContent = '下载失败：' + ((result && result.error) || '未知错误');
        el.manualDeployStatus.className = 'status-line error';
        return;
      }
      el.manualDeployStatus.textContent = '已下载 deploy.sh 到：' + result.path + '。传到 Hermes 上执行 sudo bash deploy.sh';
      el.manualDeployStatus.className = 'status-line';
    } catch (e) {
      el.manualDeployStatus.textContent = '下载失败：' + e.message;
      el.manualDeployStatus.className = 'status-line error';
    } finally {
      el.btnManualDeploySh.disabled = false;
    }
  });
}
if (el.btnManualChannelSh) {
  el.btnManualChannelSh.addEventListener('click', async () => {
    try {
      el.btnManualChannelSh.disabled = true;
      const result = await api.downloadChannelScript();
      if (!result || result.error) {
        el.manualDeployStatus.textContent = '下载失败：' + ((result && result.error) || '未知错误');
        el.manualDeployStatus.className = 'status-line error';
        return;
      }
      el.manualDeployStatus.textContent = '已下载 start-channel.sh 到：' + result.path + '。传到 Hermes 上执行 bash start-channel.sh';
      el.manualDeployStatus.className = 'status-line';
    } catch (e) {
      el.manualDeployStatus.textContent = '下载失败：' + e.message;
      el.manualDeployStatus.className = 'status-line error';
    } finally {
      el.btnManualChannelSh.disabled = false;
    }
  });
}
if (el.btnManualBundle) {
  el.btnManualBundle.addEventListener('click', async () => {
    try {
      el.btnManualBundle.disabled = true;
      const result = await api.exportDeployBundle();
      if (!result || result.error) {
        el.manualDeployStatus.textContent = '导出失败：' + ((result && result.error) || '未知错误');
        el.manualDeployStatus.className = 'status-line error';
        return;
      }
      el.manualDeployStatus.textContent = '已导出部署包到：' + result.path + '。解开跑 sudo bash deploy.sh';
      el.manualDeployStatus.className = 'status-line';
    } catch (e) {
      el.manualDeployStatus.textContent = '导出失败：' + e.message;
      el.manualDeployStatus.className = 'status-line error';
    } finally {
      el.btnManualBundle.disabled = false;
    }
  });
}

// 下载独立启动脚本（Docker / 无 systemd 环境用，不依赖 SSH 一键部署）
el.btnDownloadChannelScript.addEventListener('click', async () => {
  try {
    el.btnDownloadChannelScript.disabled = true;
    const result = await api.downloadChannelScript();
    if (!result || result.error) {
      el.bootstrapStatus.textContent = '下载失败：' + ((result && result.error) || '未知错误');
      el.bootstrapStatus.className = 'status-line error';
      return;
    }
    el.bootstrapStatus.textContent = '已保存通道启动脚本到：' + result.path;
    el.bootstrapStatus.className = 'status-line';
  } catch (e) {
    el.bootstrapStatus.textContent = '下载失败：' + e.message;
    el.bootstrapStatus.className = 'status-line error';
  } finally {
    el.btnDownloadChannelScript.disabled = false;
  }
});

el.btnPickWorkspace.addEventListener('click', async () => {
  try {
    const result = await api.pickWorkspace();
    if (result && result.root) el.fieldWorkspace.value = result.root;
  } catch (e) { setConnectStatus('无法选择目录: ' + e.message, 'error'); }
});

el.connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = el.fieldHostConfirm.value.trim() || state.sshHost;
  const apiKey = el.fieldApiKey.value.trim();
  if (!host || !apiKey) { setConnectStatus('缺少主机地址或 API Key', 'error'); return; }
  const mode = el.fieldMode ? el.fieldMode.value : 'channel';
  const channelUrl = el.fieldChannelUrl.value.trim() || deriveChannelUrl(host);
  const dashboardUrl = el.fieldDashboardUrl ? (el.fieldDashboardUrl.value.trim() || deriveDashboardUrl(host)) : '';
  const baseUrl = el.fieldBaseUrl.value.trim() || deriveBaseUrl(host);
  const payload = {
    mode,
    llmUrl: '',
    channelUrl,
    dashboardUrl: dashboardUrl || undefined,
    baseUrl,
    managementUrl: '',
    apiKey,
    profile: el.fieldProfile.value.trim() || 'buddy',
    model: el.fieldModel.value.trim() || 'hermes-agent',
    workspace: el.fieldWorkspace.value.trim(),
    channelPath: el.fieldChannelPath.value.trim() || '/api/buddy/channel',
    permission: el.connectForm.querySelector('input[name="permission"]:checked').value
  };
  el.btnConnect.disabled = true;
  setConnectStatus('正在连接 Hermes…');
  try {
    const result = await api.connect(payload);
    setConnectStatus('连接成功，正在进入主界面…', 'ok');
    el.fieldApiKey.value = '';
    const status = await api.status().catch(() => ({ ...(result.connection || {}), ready: true, connected: Boolean(result.session), workspace: payload.workspace }));
    await enterChat(status);
    if (result.endpointNotice) renderNotice({ message: result.endpointNotice });
    if (result.gatewayWarning) renderNotice({ message: 'Gateway 未就绪（' + result.gatewayWarning + '），聊天和本机工具不受影响。' });
  } catch (error) {
    setConnectStatus(error.message || '连接失败', 'error');
    setStatusDot('error');
  } finally {
    el.btnConnect.disabled = false;
  }
});
// ============================================================ 聊天渲染

function scrollToEnd() { el.chatLog.scrollTop = el.chatLog.scrollHeight; }
function scrollTools() { el.toolLog.scrollTop = el.toolLog.scrollHeight; }

function hideToolEmpty() {
  if (el.toolEmpty) el.toolEmpty.hidden = true;
}

function clearToolLog() {
  el.toolLog.textContent = '';
  if (el.toolEmpty) {
    el.toolEmpty.hidden = false;
    el.toolLog.appendChild(el.toolEmpty);
  }
}

function clearPlaceholder() {
  const placeholder = el.chatLog.querySelector('.empty');
  if (placeholder) placeholder.remove();
}

function addMessage(role, text) {
  clearPlaceholder();
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.textContent = text;
  el.chatLog.appendChild(node);
  scrollToEnd();
  return node;
}

function showPlaceholder(text) {
  el.chatLog.textContent = '';
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = text;
  el.chatLog.appendChild(node);
}

function ensureToolTrack() {
  // 工具卡片统一挂在右侧"执行记录"栏里，按时间顺序排列，与左侧对话互不干扰。
  let track = el.toolLog.querySelector('.tool-track');
  if (!track) {
    track = document.createElement('div');
    track.className = 'tool-track';
    el.toolLog.appendChild(track);
  }
  return track;
}

function toolDisplayName(name) {
  const map = {
    run_command: '运行命令',
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    find_files: '查找文件',
    search_content: '搜索内容',
    system_info: '系统信息'
  };
  return map[name] || name;
}

function shortArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const cmd = args.command || args.path || args.pattern || args.query || args.glob || '';
  return String(cmd).slice(0, 120);
}

function renderToolStart({ id, name, args }) {
  const track = ensureToolTrack();
  let card = track.querySelector(`[data-tool-id="${id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolId = id;
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-name"></span>
        <span class="tool-status">执行中</span>
        <span class="tool-dur"></span>
      </div>
      <div class="tool-args"></div>
      <pre class="tool-output" hidden></pre>
    `;
    track.appendChild(card);
    state.pendingTools.set(id, { card, startedAt: Date.now() });
  }
  card.querySelector('.tool-name').textContent = toolDisplayName(name);
  card.querySelector('.tool-status').textContent = '执行中…';
  card.querySelector('.tool-status').dataset.tone = 'running';
  card.querySelector('.tool-dur').textContent = '';
  card.querySelector('.tool-args').textContent = shortArgs(args);
  card.querySelector('.tool-output').hidden = true;
  card.dataset.status = 'running';
  hideToolEmpty();
  scrollTools();
}

function renderToolResult({ id, ok, durationMs, text, name }) {
  const entry = state.pendingTools.get(id);
  if (!entry) return;
  const card = entry.card;
  card.dataset.status = ok ? 'done' : 'failed';
  card.querySelector('.tool-status').textContent = ok ? '完成' : '失败';
  card.querySelector('.tool-status').dataset.tone = ok ? 'ok' : 'error';
  const seconds = (durationMs / 1000).toFixed(secondsPrecision(durationMs));
  card.querySelector('.tool-dur').textContent = `${seconds}s`;
  const out = card.querySelector('.tool-output');
  // 输出给模型看的就是给用户看的；文本上限由工具层控好了。
  out.textContent = (text || '').slice(0, 8000);
  out.hidden = false;
  scrollTools();
  state.pendingTools.delete(id);
}

// 命令在执行过程中实时吐出的片段：直接追加到卡片输出区，让用户看到进度。
function renderToolOutput({ id, chunk }) {
  const entry = state.pendingTools.get(id);
  if (!entry) return;
  const card = entry.card;
  const out = card.querySelector('.tool-output');
  out.hidden = false;
  // 流式片段累加；最终 tool_result 会用完整文本重置一次，这里只负责"边跑边显"。
  out.textContent = (out.textContent || '') + chunk;
  // 执行中的卡片标个"流式"语气，结果回来后再改回 完成/失败。
  if (card.dataset.status === 'running') {
    card.querySelector('.tool-status').dataset.tone = 'running';
  }
  scrollTools();
}

function secondsPrecision(ms) {
  if (ms < 200) return 2;
  if (ms < 2000) return 1;
  return 0;
}

function renderNotice(event) {
  const { message, action, missing } = event || {};
  const track = ensureToolTrack();
  const node = document.createElement('div');
  node.className = 'notice';
  node.textContent = message || '';
  if (action === 'install-media-engines') {
    node.appendChild(makeInstallButton(missing || []));
  }
  track.appendChild(node);
  hideToolEmpty();
  scrollTools();
  // 缺引擎这种事用户多半只盯着左侧对话看，所以在聊天区也补一条带按钮的提示。
  if (action === 'install-media-engines') addEnginePrompt(message || '', missing || []);
}

/** 生成「安装本地转写引擎」按钮，点一次就禁用，避免重复触发。 */
function makeInstallButton(missing) {
  const btn = document.createElement('button');
  btn.className = 'ghost notice-action';
  btn.type = 'button';
  btn.textContent = '安装本地转写引擎';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    installMediaEngines(missing);
  });
  return btn;
}

function addEnginePrompt(message, missing) {
  const node = addMessage('system', message);
  node.appendChild(makeInstallButton(missing));
  return node;
}

/**
 * 一键安装本地转写引擎（Whisper + 模型 + ffmpeg）。
 * 装在 userData/media，不需要管理员权限；装完重新发一次语音/视频即可。
 */
async function installMediaEngines(missing, progressNode) {
  const list = Array.isArray(missing) ? missing : [];
  const pick = (c) => !list.length || list.indexOf(c) !== -1;
  const components = [];
  if (pick('whisper')) components.push('whisper');
  if (pick('model')) components.push('model');
  if (pick('ffmpeg')) components.push('ffmpeg');
  if (!components.length) components.push('whisper', 'model', 'ffmpeg');

  const node = progressNode || addMessage('system', '');
  state.mediaInstallNode = node;
  node.textContent = '正在准备安装本地转写引擎…';
  scrollToEnd();
  try {
    const res = await api.installMediaEngines({ components, model: 'base' });
    if (res && res.error) {
      node.textContent = `安装失败：${res.error}`;
      node.appendChild(makeOpenDirButton());
      return;
    }
    const names = (res && res.installed || []).join('、');
    node.textContent = `本地转写引擎已就绪（${names || '已安装'}）。重新发送一次语音/视频就会在本机转写后再发给 AI。`;
  } catch (error) {
    node.textContent = `安装失败：${cleanIpcError(error && error.message) || error}`;
    node.appendChild(makeOpenDirButton());
  } finally {
    state.mediaInstallNode = null;
    scrollToEnd();
  }
}

/** 一键安装失败时的兜底：打开引擎目录，让用户自己把文件放进去。 */
function makeOpenDirButton() {
  const btn = document.createElement('button');
  btn.className = 'ghost notice-action';
  btn.type = 'button';
  btn.textContent = '打开引擎目录（手动放置）';
  btn.addEventListener('click', () => { api.openMediaEngineDir(); });
  return btn;
}

api.onMediaEngineProgress((progress) => {
  if (!state.mediaInstallNode || !progress) return;
  state.mediaInstallNode.textContent = progress.message || '安装中…';
  scrollToEnd();
});

function beginAssistantBubble() {
  state.pendingTools = new Map();
  const bubble = addMessage('assistant pending', '');
  state.pendingBubble = bubble;
  return bubble;
}

function finishAssistantBubble(fallbackText) {
  const bubble = state.pendingBubble;
  state.pendingBubble = null;
  if (!bubble) return;
  bubble.classList.remove('pending');
  if (!bubble.textContent) bubble.textContent = fallbackText || '（本次没有返回文本内容）';
}

// ============================================================ 流式事件

api.onChatEvent((event) => {
  if (!event || event.requestId !== state.activeRequestId) return;
  switch (event.type) {
    case 'text':
      if (state.pendingBubble) {
        state.pendingBubble.textContent += event.text || '';
        scrollToEnd();
      }
      break;
    case 'status':
      if (state.pendingBubble) {
        state.pendingBubble.dataset.thinking = 'true';
        state.pendingBubble.textContent = event.text || '思考中…';
        scrollToEnd();
      }
      break;
    case 'tool_start':
      renderToolStart(event);
      break;
    case 'tool_result':
      renderToolResult(event);
      break;
    case 'tool_output':
      renderToolOutput(event);
      break;
    case 'notice':
      renderNotice(event);
      break;
    case 'upstream':
      // 记下服务端实际在调的模型地址，出错时提示里能用上
      if (event.url) state.upstream = String(event.url);
      break;
    case 'error':
      finishAssistantBubble('');
      addMessage('error', cleanIpcError(event.text || event.message) || '本地 Agent 出错');
      break;
    case 'done':
      // 由 send() 的 Promise resolve 处理；这里只清掉 thinking 标记。
      if (state.pendingBubble) state.pendingBubble.dataset.thinking = 'false';
      break;
    default:
      break;
  }
});

// ============================================================ 权限确认弹窗

api.onConfirmRequest((payload) => {
  if (!payload || !payload.id) return;
  state.pendingConfirm = payload.id;
  el.confirmTitle.textContent = payload.title || '需要你确认一个危险操作';
  el.confirmBody.textContent = payload.message || 'Hermes 想执行一个被标记为危险的操作，是否允许？';
  el.confirmDetail.textContent = payload.command || payload.detail || '';
  if (payload.reason) {
    const reason = document.createElement('div');
    reason.className = 'confirm-reason';
    reason.textContent = `原因：${payload.reason}`;
    el.confirmDetail.after(reason);
  }
  el.confirmDialog.hidden = false;
});

el.confirmApprove.addEventListener('click', () => replyConfirm(true));
el.confirmDeny.addEventListener('click', () => replyConfirm(false));

async function replyConfirm(approved) {
  if (!state.pendingConfirm) return;
  const id = state.pendingConfirm;
  state.pendingConfirm = null;
  el.confirmDialog.hidden = true;
  // 清掉上次可能遗留的 reason
  el.confirmDialog.querySelectorAll('.confirm-reason').forEach((n) => n.remove());
  try { await api.replyConfirm(id, approved); } catch (_) {}
}

// ============================================================ 会话动作

function setBusy(busy) {
  el.btnSend.disabled = busy;
  el.btnStop.hidden = !busy;
  el.input.disabled = busy;
  el.btnAttach.disabled = busy;
  el.btnRecord.disabled = busy && !state.recording;
  setStatusDot(busy ? 'busy' : 'online');
  if (!busy) el.input.focus();
}

// Electron 给主进程抛出的错误加了一层壳：
// "Error invoking remote method 'buddy:chat': Error: <真正的信息>"
// 直接显示会盖住真正的原因，这里剥掉。
function cleanIpcError(raw) {
  return String(raw || '').replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim();
}

/**
 * 给上游错误补排查方向。不同错误的成因完全不同，提示必须分开：
 *   Connection refused = 那个地址上没服务在听（跟体积毫无关系）
 *   Remote end closed  = 连上了但被对方掐断（常见是请求体过大）
 * 混成一句"附件太大"会把人带到完全错误的方向上去。
 */
function withUpstreamHint(message) {
  const m = String(message || '');
  if (/Connection refused|Errno 111|ECONNREFUSED/i.test(m)) {
    const inline = (m.match(/https?:\/\/[^\s，,）)"']+/) || [])[0] || '';
    const addr = inline || state.upstream;
    return `${m}\n\n这是「连不上」，不是附件太大——服务端配置的模型地址上现在没有服务在监听。`
      + (addr ? `\n上游地址：${addr}` : '')
      + '\n请到服务器上确认这个地址的服务在跑（推理服务 / 8811 直通代理），'
      + '或核对 Hermes config.yaml 里的 model.base_url；改完在 Buddy 里重连一次。';
  }
  if (/timed out|请求超时/i.test(m)) {
    return `${m}\n\n上游连上了但没在超时时间内返回，通常是模型仍在加载或推理很慢。`
      + '可以稍后重试，或到「设置 → 智能体」换一个响应更快的模型。';
  }
  if (/Remote end closed|上游不可达|Connection aborted|Connection reset|Broken pipe/i.test(m)) {
    return `${m}\n\n常见原因：附件体积过大，或当前模型不支持图片输入。`
      + '可以试试只发文字、换小一点的图，或到「设置 → 智能体」换一个支持视觉的模型。';
  }
  return m;
}

// ============================================================ 多模态附件（图片 / 文件 / 语音 / 视频）
//
// 语义约定（与 main 进程 session-manager 的 _buildUserContent 对应）：
//   image → base64，直接作为多模态图片发给模型
//   file  → 文本文件内联内容；读不出的二进制只附一行说明
//   audio → 原始字节，由主进程本地 Whisper 转写（不上传原始音频）
//   video → 原始字节，由主进程本地转写 + ffmpeg 抽关键帧（不上传原始视频）
// 即：语音/视频"在 win 端本地处理完"再发，原始媒体不出本机。

const TEXT_EXT = /\.(txt|md|json|csv|log|yaml|yml|toml|ini|xml|js|ts|jsx|tsx|py|java|go|rb|rs|sh|sql|html|css)$/i;
const MAX_FILE_TEXT = 200 * 1024;   // 单个文本文件内联上限，避免把超大文件塞进上下文
// 图片发送前先压缩：原图动辄好几 MB，base64 之后还要再涨 1/3，
// 直接发会让上游因请求体过大而断开（表现为"上游不可达"）。
const MAX_IMAGE_EDGE = 1600;        // 长边上限像素
const TARGET_IMAGE_BYTES = 1024 * 1024;  // 单图压缩目标：不超过 1 MB
const MAX_SINGLE_FILE = 50 * 1024 * 1024;   // 单个附件原始上限，超过直接拒收（读进内存也没意义）
const MAX_TOTAL_SEND = 3 * 1024 * 1024;     // 本次发送总量预算；超了会被上游掐断，所以在本地就拦下

/** 附件限额说明（composer 常驻显示，让用户发送前就知道边界）。 */
function attachLimitText() {
  return `图片在本机压缩至 ≤${formatSize(TARGET_IMAGE_BYTES)} 后发送 · 文本 ≤${formatSize(MAX_FILE_TEXT)} · 单文件 ≤${formatSize(MAX_SINGLE_FILE)}`;
}

const _encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

/** 本次实际会发出去的字节数（图片算压缩后，文本算 UTF-8 字节；音视频本地转写后不算）。 */
function outgoingBytes(atts) {
  let n = 0;
  for (const a of (atts || [])) {
    if (a.kind === 'image') {
      n += Number(a.compressedSize || 0) || base64Bytes(a.data || '');
    } else if (a.text) {
      n += _encoder ? _encoder.encode(String(a.text)).length : String(a.text).length;
    }
  }
  return n;
}

function kindOfFile(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function isTextFile(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (/json|xml|javascript|csv/.test(mime)) return true;
  return TEXT_EXT.test(file.name || '');
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readWith(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    if (how === 'text') r.readAsText(file);
    else if (how === 'buffer') r.readAsArrayBuffer(file);
    else r.readAsDataURL(file);
  });
}

/** 图片芯片副标题：压缩过就把"发出去多大"也标出来，方便判断是不是体积惹的祸。 */
function imageSub(att) {
  const before = formatSize(att.size);
  const d = att.dims;
  const dim = (d && d.outWidth && (d.outWidth !== d.srcWidth || d.outHeight !== d.srcHeight))
    ? ` · ${d.srcWidth}×${d.srcHeight} → ${d.outWidth}×${d.outHeight}`
    : '';
  if (att.compressedSize && att.compressedSize < att.size) {
    // 说清楚是本机压的、原图不上传——和语音/视频一个口径
    return `图片 · 本机处理 ${before} → ${formatSize(att.compressedSize)}${dim}（仅发送处理后的图，原图不出本机）`;
  }
  return `图片 · ${before}${dim}（本机处理后发送）`;
}

/** data URL 里的 base64 折算成字节数。 */
function base64Bytes(dataUrl) {
  const i = String(dataUrl || '').indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : String(dataUrl || '');
  return Math.floor(b64.length * 3 / 4);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/** 等比缩放后转 JPEG（垫白底，避免 PNG 透明通道变黑）。 */
function drawToJpeg(img, maxEdge, quality) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 压缩图片到 1MB 以内（先降质量，再缩尺寸）。
 * 失败就原样返回——宁可发大图，也绝不因为压缩出错让用户发不出东西。
 */
async function shrinkImage(dataUrl, info) {
  const setInfo = (sw, sh, ow, oh) => {
    if (!info) return;
    info.srcWidth = sw; info.srcHeight = sh; info.outWidth = ow; info.outHeight = oh;
  };
  try {
    const before = base64Bytes(dataUrl);
    const img = await loadImage(dataUrl);
    const sw = img.naturalWidth || img.width || 0;
    const sh = img.naturalHeight || img.height || 0;
    const dimsFor = (edge) => {
      const s = Math.min(1, edge / Math.max(sw, sh || 1));
      return [Math.round(sw * s), Math.round(sh * s)];
    };
    const tooBig = before > TARGET_IMAGE_BYTES;
    const tooWide = Math.max(sw, sh) > MAX_IMAGE_EDGE;
    if (!tooBig && !tooWide) { setInfo(sw, sh, sw, sh); return dataUrl; }
    // 体积达标但尺寸过大（比如 6000px 长图）：只降采样保质量，压完反而更大就别动
    if (!tooBig) {
      const cand = drawToJpeg(img, MAX_IMAGE_EDGE, 0.9);
      if (base64Bytes(cand) < before) { setInfo(sw, sh, ...dimsFor(MAX_IMAGE_EDGE)); return cand; }
      setInfo(sw, sh, sw, sh);
      return dataUrl;
    }
    let quality = 0.82;
    let edge = Math.min(MAX_IMAGE_EDGE, Math.max(sw, sh) || MAX_IMAGE_EDGE);
    let best = dataUrl;
    for (let i = 0; i < 6; i++) {
      best = drawToJpeg(img, edge, quality);
      if (base64Bytes(best) <= TARGET_IMAGE_BYTES) { setInfo(sw, sh, ...dimsFor(edge)); return best; }
      if (quality > 0.55) quality -= 0.12;
      else edge = Math.round(edge * 0.7);
    }
    setInfo(sw, sh, ...dimsFor(edge));
    return best;
  } catch (_) {
    return dataUrl;      // 压缩失败就发原图，绝不因为压缩出错而阻断发送
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    const size = Number(file.size || 0);
    if (size > MAX_SINGLE_FILE) {
      addMessage('error', `附件「${file.name || '未命名'}」${formatSize(size)} 超过单文件上限 ${formatSize(MAX_SINGLE_FILE)}，已跳过。`);
      continue;
    }
    const kind = kindOfFile(file);
    const att = {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      name: file.name || '未命名',
      mime: file.type || '',
      size,
      previewUrl: '',
      text: '',
      data: null
    };
    try {
      if (kind === 'image') {
        // 全流程在本机：FileReader 读字节 → canvas 解码 → 缩放重编码 → 只把产物发走。
        // 原图字节不出本机，所以原始照片/截图不会被上传到任何地方。
        const raw = String(await readWith(file, 'dataurl') || '');
        const info = {};
        const url = await shrinkImage(raw, info);
        att.previewUrl = url;
        att.mime = url.indexOf('data:image/png') === 0 ? 'image/png' : 'image/jpeg';
        att.data = url.includes(',') ? url.slice(url.indexOf(',') + 1) : url;   // 纯 base64
        att.compressedSize = base64Bytes(url);   // 实际会发出去的体积，UI 上要让用户看见
        if (info.srcWidth) att.dims = info;      // 处理前后尺寸，芯片上展示
      } else if (kind === 'audio' || kind === 'video') {
        att.data = await readWith(file, 'buffer');
      } else if (isTextFile(file)) {
        let text = String(await readWith(file, 'text') || '');
        if (text.length > MAX_FILE_TEXT) {
          text = `${text.slice(0, MAX_FILE_TEXT)}\n…（文件过长，已截断为前 ${MAX_FILE_TEXT} 字符）`;
        }
        att.text = text;
      }
      // 其余二进制文件：读不出文本，发送时只附文件名说明
    } catch (error) {
      addMessage('error', `读取附件「${att.name}」失败：${error.message || error}`);
      continue;
    }
    state.attachments.push(att);
  }
  renderAttachments();
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

/** 生成一个附件芯片；removable=true 时带移除按钮（预览条用），气泡里不带。 */
function buildAttachmentChip(att, removable) {
  const chip = document.createElement('div');
  chip.className = `attach-chip kind-${att.kind}`;
  if (att.kind === 'image' && att.previewUrl) {
    const img = document.createElement('img');
    img.src = att.previewUrl;      // data: URL，CSP img-src 'self' data: 已放行
    img.alt = att.name;
    chip.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.textContent = att.kind === 'audio' ? '🎤'
      : att.kind === 'video' ? '🎬'
        : (att.text ? '📄' : '📦');
    chip.appendChild(icon);
  }
  const meta = document.createElement('div');
  meta.className = 'attach-meta';
  const title = document.createElement('div');
  title.className = 'attach-name';
  title.textContent = att.name;
  const sub = document.createElement('div');
  sub.className = 'attach-sub';
  sub.textContent = att.kind === 'audio' ? `语音 · ${formatSize(att.size)} · 本机转写后只发文字`
    : att.kind === 'video' ? `视频 · ${formatSize(att.size)} · 本机转写 + 抽帧后发送`
      : att.kind === 'image' ? imageSub(att)
        : (att.text ? `文本 · ${formatSize(att.size)}` : `文件 · ${formatSize(att.size)}（无法直接读取，仅附文件名）`);
  sub.title = sub.textContent;   // 芯片窄，截断时悬停看完整说明
  meta.appendChild(title);
  meta.appendChild(sub);
  chip.appendChild(meta);
  if (removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.title = '移除该附件';
    rm.addEventListener('click', () => removeAttachment(att.id));
    chip.appendChild(rm);
  }
  return chip;
}

function renderAttachments() {
  const strip = el.attachStrip;
  if (!strip) return;
  strip.textContent = '';
  if (!state.attachments.length) { strip.hidden = true; return; }
  strip.hidden = false;
  for (const att of state.attachments) strip.appendChild(buildAttachmentChip(att, true));

  // 汇总行：说清楚本次实际会发出去多少、超没超预算
  const out = outgoingBytes(state.attachments);
  // 音视频本地转写后只发文字，原始文件不上传，所以不算进"原始体积"对比
  const raw = state.attachments.reduce(
    (n, a) => n + ((a.kind === 'image' || a.text) ? (Number(a.size) || 0) : 0), 0);
  const sum = document.createElement('div');
  const saved = raw > out ? `（原始 ${formatSize(raw)}，已在本机精简）` : '';
  if (out > MAX_TOTAL_SEND) {
    sum.className = 'attach-total over';
    sum.textContent = `本次将发送 ${formatSize(out)}${saved}，超过 ${formatSize(MAX_TOTAL_SEND)} 上限——` +
      '请移除部分附件或分批发送，否则上游可能因请求体过大断开。';
  } else {
    sum.className = 'attach-total';
    sum.textContent = `本次将发送 ${formatSize(out)}${saved}`;
  }
  strip.appendChild(sum);
}

/** 把附件转成要发给主进程的 parts（不含文本，文本由 sendMessage 单独加）。 */
function attachmentParts(atts) {
  return (atts || []).map((a) => {
    if (a.kind === 'image') return { type: 'image', mime: a.mime, data: a.data };
    if (a.kind === 'audio') return { type: 'audio', name: a.name, mime: a.mime, data: a.data };
    if (a.kind === 'video') return { type: 'video', name: a.name, mime: a.mime, data: a.data };
    return { type: 'file', name: a.name, mime: a.mime, text: a.text };
  });
}

/** 用户气泡：文本 + 附件缩略图/芯片（全程 textContent / createElement，不拼 HTML）。 */
function addUserMessage(text, atts) {
  clearPlaceholder();
  const node = document.createElement('div');
  node.className = 'msg user';
  if (text) {
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = text;
    node.appendChild(p);
  }
  const list = (atts || []).filter(Boolean);
  if (list.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachments';
    for (const att of list) wrap.appendChild(buildAttachmentChip(att, false));
    node.appendChild(wrap);
  }
  el.chatLog.appendChild(node);
  scrollToEnd();
  return node;
}

// ---- 录音（MediaRecorder，纯本地；产物交给主进程转写） ----

async function toggleRecord() {
  if (state.recording) { stopRecording(); return; }
  await startRecording();
}

/**
 * 把录音产物转成 whisper.cpp 唯一认的格式：16kHz / 单声道 / 16bit PCM WAV。
 *
 * 为什么必须这步：MediaRecorder 默认产出 webm(opus) 或 mp4(aac)，而 whisper.cpp
 * 内部只用 miniaudio 解 PCM WAV，喂 webm 会直接 "failed to open / decode" 失败。
 * 以前靠 ffmpeg 转，但 ffmpeg 是可选组件（用户常常没装），这里用浏览器自带的
 * decodeAudioData + OfflineAudioContext 重采样，零外部依赖即可产出合规 WAV。
 */
function pcmToWav(samples, sampleRate) {
  const len = samples.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = rate * channels * bytesPerSample
  view.setUint16(32, 2, true);           // blockAlign
  view.setUint16(34, 16, true);          // bitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

/** 解码任意浏览器能放的音频 Blob，重采样到 16k 单声道，返回 WAV ArrayBuffer。失败返回 null。 */
async function toWav16k(blob) {
  const raw = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC && !OAC) return null;

  // decodeAudioData 需要挂在某个 context 上；优先普通 AudioContext，没有就用离线上下文
  let ctx = null;
  try { ctx = AC ? new AC() : new OAC(1, 1, 16000); } catch (_) {
    try { ctx = OAC ? new OAC(1, 1, 16000) : null; } catch (_e) { ctx = null; }
  }
  if (!ctx) return null;

  try {
    // 注意：decodeAudioData 会 detach 传入的 buffer，所以给副本
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    const targetRate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OAC(1, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;               // 采样率不同时，WebAudio 会自动重采样到上下文采样率
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return pcmToWav(rendered.getChannelData(0), targetRate);
  } finally {
    try { if (ctx.close) ctx.close(); } catch (_) {}
  }
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    addMessage('error', '当前环境不支持录音（缺少 navigator.mediaDevices.getUserMedia）');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    let recorder = null;
    for (const mimeType of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']) {
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        break;
      } catch (_) { /* 换下一个候选 */ }
    }
    if (!recorder) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      addMessage('error', '无法创建录音器（MediaRecorder 不可用）');
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'm4a' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
      try {
        // 录音原始是 webm/mp4，先本地转成 16k 单声道 WAV（whisper.cpp 只认这个）
        let wavBuf = null;
        try { wavBuf = await toWav16k(blob); } catch (_) { wavBuf = null; }
        if (wavBuf) {
          state.attachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'audio',
            name: `录音-${stamp}.wav`,
            mime: 'audio/wav',
            size: wavBuf.byteLength,
            previewUrl: '',
            text: '',
            data: wavBuf
          });
        } else {
          // 解码失败（极老环境/无音频子系统）：保留原始格式，让主进程用 ffmpeg 兜底转
          const buf = await blob.arrayBuffer();
          state.attachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'audio',
            name: `录音-${stamp}.${ext}`,
            mime: type.split(';')[0],
            size: blob.size,
            previewUrl: '',
            text: '',
            data: buf
          });
        }
        renderAttachments();
      } catch (error) {
        addMessage('error', `录音结果处理失败：${error.message || error}`);
      } finally {
        // 放行可能正在等这段录音的 sendMessage
        if (stopResolve) { const r = stopResolve; stopResolve = null; r(); }
      }
    };
    recorder.start();
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      el.recordTip.textContent = `录音中 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · 点击结束`;
    }, 200);
    state.recording = { recorder, stream, chunks, startedAt, timer };
    el.btnRecord.classList.add('recording');
    el.recordTip.hidden = false;
    el.recordTip.textContent = '录音中 0:00 · 点击结束';
  } catch (error) {
    addMessage('error', `无法开始录音：${error.message || error}（请检查麦克风权限）`);
  }
}

let stopResolve = null;   // 等待 onstop 把录音变成附件的 resolver

function stopRecording() {
  const rec = state.recording;
  if (!rec) return Promise.resolve();
  return new Promise((resolve) => {
    stopResolve = resolve;
    state.recording = null;
    clearInterval(rec.timer);
    el.recordTip.hidden = true;
    el.btnRecord.classList.remove('recording');
    try { rec.recorder.stop(); } catch (_) {}
    rec.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    // 兜底：极端情况下 onstop 没触发也要放行，别把发送卡死
    setTimeout(() => { if (stopResolve) { const r = stopResolve; stopResolve = null; r(); } }, 1500);
  });
}

async function sendMessage() {
  const text = el.input.value.trim();
  if (state.activeRequestId) return;
  // 还在录音就先收尾：等 onstop 把录音变成附件，再一起发出去
  if (state.recording) await stopRecording();
  const atts = state.attachments.slice();
  if (!text && !atts.length) return;          // 没有文本也没有附件就别发
  // 总量兜底：超过预算基本必被上游掐断，与其发过去失败，不如在本地拦下并说明
  const outBytes = outgoingBytes(atts);
  if (outBytes > MAX_TOTAL_SEND) {
    addMessage('error', `本次附件合计 ${formatSize(outBytes)}，超过单次上限 ${formatSize(MAX_TOTAL_SEND)}。` +
      '请移除部分附件或分批发送——超量发送会让上游因请求体过大直接断开。');
    return;
  }
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const part of attachmentParts(atts)) parts.push(part);

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.activeRequestId = requestId;
  addUserMessage(text, atts);
  el.input.value = '';
  clearAttachments();
  beginAssistantBubble();
  setBusy(true);
  try {
    const result = await api.chat({ requestId, parts, model: el.modelSelect.value || undefined });
    finishAssistantBubble(result && result.text);
  } catch (error) {
    finishAssistantBubble('');
    const message = withUpstreamHint(cleanIpcError(error && error.message) || '本地 Agent 调用失败');
    addMessage('error', message);
    setStatusDot('error');
    // 模型被上游打回：服务端已把它从可用列表移除，这里刷新下拉让用户别再选到它。
    if (/不被上游支持|UnsupportedModel|model_unsupported/i.test(message)) loadModels();
  } finally {
    state.activeRequestId = null;
    setBusy(false);
  }
}

async function loadModels(preferred) {
  let models = ['hermes-agent'];
  try {
    const list = await api.models();
    // 空清单不覆盖兜底值，否则下拉会变成空白
    if (Array.isArray(list) && list.length) models = list;
  } catch (_) {}
  el.modelSelect.textContent = '';
  for (const id of models) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    el.modelSelect.appendChild(option);
  }
  if (preferred && models.includes(preferred)) el.modelSelect.value = preferred;
}

function applyStatus(status) {
  if (!status) return;
  const target = status.channelUrl || status.llmUrl || status.baseUrl || '未连接';
  // ready = 本机工作区 + LLM 推理端点都已就绪，这才是用户能聊天的真实状态；
  // connected 仅表示 Gateway 会话已登记，降级场景下可能为 false。
  const online = status.ready || status.connected;
  let label = '未连接';
  if (online) {
    const profile = status.profile || 'buddy';
    if (status.connected) {
      label = `${target} · ${profile}`;
    } else {
      // 有诊断信息就展示，没有就只说 Gateway 未就绪
      if (status.gatewayError && status.gatewayError.message) {
        label = `${target} · LLM已连 / Gateway诊断：${status.gatewayError.message}`;
      } else {
        label = `${target} · LLM已连 / Gateway未就绪`;
      }
    }
  } else if (status.configured) {
    label = `${target}（未就绪）`;
  }
  el.gatewayLabel.textContent = label;
  const wsDisplay = status.workspace || '';
  el.workdirTag.hidden = !wsDisplay;
  const wsNote = status.workspaceSource === 'agent' ? '（来自智能体配置）' : (wsDisplay ? '（连接默认）' : '');
  el.workdirTag.textContent = wsDisplay ? `工作目录：${wsDisplay}${wsNote}` : '';
  el.permBadge.dataset.level = status.permission || 'read-write';
  el.permBadge.textContent = permLabel(status.permission || 'read-write');
  setStatusDot(status.busy ? 'busy' : (online ? 'online' : (status.configured ? 'error' : 'offline')));
}

function permLabel(level) {
  return ({
    read: '只读',
    'read-write': '读 + 写',
    full: '完全控制'
  })[level] || level;
}

function modelsInclude(select, value) {
  return Array.from(select.options || []).some((option) => option.value === value);
}

// ---- 智能体列表：左侧栏。点击切换智能体（切工作区/权限/模型/上下文），齿轮打开配置 ----

async function renderSessionList() {
  const data = await api.agents().catch(() => ({ agents: [], activeId: null }));
  el.sessionList.innerHTML = '';
  if (!data.agents.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '暂无智能体';
    el.sessionList.appendChild(empty);
    return;
  }
  for (const agent of data.agents) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.active = String(agent.id === data.activeId);

    const name = document.createElement('div');
    name.className = 'agent-name';
    name.textContent = agent.name;

    const sub = document.createElement('div');
    sub.className = 'agent-sub';
    sub.textContent = agent.workspace
      ? agent.workspace.split('\\').pop().split('/').pop() || agent.workspace
      : '默认工作区';

    const gear = document.createElement('button');
    gear.className = 'agent-config';
    gear.type = 'button';
    gear.title = '配置这个智能体';
    gear.textContent = '⚙';
    gear.addEventListener('click', (event) => {
      event.stopPropagation();
      state.settingsTab = 'agent';
      showView('settings');
    });

    item.append(name, sub, gear);
    item.addEventListener('click', () => activateAgentById(agent.id));
    el.sessionList.appendChild(item);
  }
}

async function activateAgentById(id) {
  try {
    await api.activateAgent(id);
    await refreshChatForAgent();
  } catch (error) {
    showBanner('切换智能体失败：' + (error.message || id), 'error');
  }
}

/** 切换智能体后刷新整个聊天视图：历史、工作目录、权限徽标、模型下拉。 */
async function refreshChatForAgent() {
  const history = await api.history().catch(() => []);
  el.chatLog.textContent = '';
  clearToolLog();
  if (Array.isArray(history) && history.length) {
    for (const entry of history) addMessage(entry.role === 'user' ? 'user' : 'assistant', entry.text || '');
  } else {
    showPlaceholder('会话已就绪。Hermes 在远端做决策，工具在本机执行。提问前请确认顶部的工作目录与权限档位。');
  }
  const status = await api.status().catch(() => null);
  if (status) {
    applyStatus(status);
    const agents = await api.agents().catch(() => null);
    const active = agents && agents.agents.find((a) => a.id === agents.activeId);
    await loadModels((active && active.model) || (status && status.model));
    await renderSessionList();
  }
  el.input.focus();
}

async function enterChat(status) {
  applyStatus(status);
  showView('chat');
  await loadModels(status && status.model);
  // 模型下拉优先反映当前智能体的默认模型。
  const agents = await api.agents().catch(() => null);
  const active = agents && agents.agents.find((a) => a.id === agents.activeId);
  if (active && active.model && modelsInclude(el.modelSelect, active.model)) el.modelSelect.value = active.model;
  await renderSessionList();
  const history = await api.history().catch(() => []);
  el.chatLog.textContent = '';
  clearToolLog();
  if (Array.isArray(history) && history.length) {
    for (const entry of history) addMessage(entry.role === 'user' ? 'user' : 'assistant', entry.text || '');
  } else {
    showPlaceholder('会话已就绪。Hermes 在远端做决策，工具在本机执行。提问前请确认顶部的工作目录与权限档位。');
  }
  el.input.focus();
  // 启动 8 秒后静默探测一次更新；有新版本会自动后台下载，不打断当前使用。
  setTimeout(() => { autoCheckUpdate(); }, 8000);
}

// ============================================================ 聊天交互

el.composer.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(); });
el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});

// ---- 多模态：附件选择 / 录音 / 拖拽 ----
// 常驻限额说明：让用户点发送前就看到边界，而不是等发出去被上游拒了才知道
if (el.attachLimit) {
  el.attachLimit.textContent = attachLimitText();
  el.btnAttach.title = `添加图片 / 文件 / 视频 · ${attachLimitText()}`;
}
el.btnAttach.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = '';   // 清空后才能重复选同一个文件
});
el.btnRecord.addEventListener('click', () => { toggleRecord(); });

['dragenter', 'dragover'].forEach((type) => {
  el.composer.addEventListener(type, (event) => {
    event.preventDefault();
    el.composer.classList.add('dragover');
  });
});
['dragleave', 'dragend'].forEach((type) => {
  el.composer.addEventListener(type, () => el.composer.classList.remove('dragover'));
});
el.composer.addEventListener('drop', (event) => {
  event.preventDefault();
  el.composer.classList.remove('dragover');
  if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
    addFiles(event.dataTransfer.files);
  }
});

el.btnStop.addEventListener('click', async () => {
  if (!state.activeRequestId) return;
  await api.abort(state.activeRequestId).catch(() => {});
});

el.btnReconnect.addEventListener('click', async () => {
  setStatusDot('busy');
  const result = await api.resume().catch((error) => ({ ok: false, message: error.message }));
  if (result.ok) {
    hideBanner();
    applyStatus(await api.status());
    addMessage('system', '已重新建立会话。');
  } else {
    setStatusDot('error');
    showBanner(result.message || '重连失败', 'error');
  }
});

el.btnClearChat.addEventListener('click', async () => {
  if (!confirm('清空当前智能体的对话历史？\n\n该操作不可撤销，已保存的记忆和日志不受影响。')) return;
  await api.clearHistory();
  el.chatLog.textContent = '';
  clearToolLog();
  showPlaceholder('对话已清空。');
});

el.btnDisconnect.addEventListener('click', async () => {
  const confirmed = confirm('断开与当前 Hermes 主机的连接？\n\n仅断开会话，已保存的连接配置会保留，可在"管理连接"里重新切换或连接。');
  if (!confirmed) return;
  try { await api.disconnect(); } catch (_) {}
  state.activeRequestId = null;
  el.chatLog.textContent = '';
  clearToolLog();
  hideBanner();
  // 回到连接页并显示已保存的连接列表（多网关管理）
  await showConnectWithProfiles();
});

el.btnNewChat.addEventListener('click', () => openAgentCreateDialog());

// 新建智能体：专用弹窗，与"配置现有智能体"严格区分，避免混淆。
function openAgentCreateDialog() {
  el.acName.value = '';
  el.acWorkspace.value = '';
  el.acStatus.textContent = '';
  el.acStatus.dataset.tone = '';
  api.status().then((st) => { if (st && st.workspace && !el.acWorkspace.value) el.acWorkspace.placeholder = st.workspace; }).catch(() => {});
  api.models().then((models) => {
    el.acModel.textContent = '';
    for (const id of (models && models.length ? models : ['hermes-agent'])) {
      const option = document.createElement('option');
      option.value = id; option.textContent = id;
      el.acModel.appendChild(option);
    }
  }).catch(() => {});
  el.agentCreateDialog.hidden = false;
  el.acName.focus();
}

el.acCancel.addEventListener('click', () => { el.agentCreateDialog.hidden = true; });

el.acPick.addEventListener('click', async () => {
  try {
    const result = await api.pickWorkspacePath();
    if (result && !result.canceled && result.path) el.acWorkspace.value = result.path;
  } catch (e) { el.acStatus.textContent = '选择目录失败: ' + e.message; }
});

el.acSave.addEventListener('click', async () => {
  const name = el.acName.value.trim();
  if (!name) { el.acStatus.textContent = '请填写智能体名称'; el.acStatus.dataset.tone = 'error'; return; }
  el.acSave.disabled = true;
  try {
    await api.createAgent({
      name,
      workspace: el.acWorkspace.value.trim(),
      model: el.acModel.value,
      permission: (el.agentCreateDialog.querySelector('input[name="ac-perm"]:checked') || {}).value || 'read-write'
    });
    el.agentCreateDialog.hidden = true;
    await refreshChatForAgent();
    // 创建后即打开该智能体的配置面板，明确"新建"与"配置"是两个步骤
    state.settingsTab = 'agent';
    showView('settings');
  } catch (error) {
    el.acStatus.textContent = '创建失败：' + error.message;
    el.acStatus.dataset.tone = 'error';
  } finally {
    el.acSave.disabled = false;
  }
});

el.btnToolClear.addEventListener('click', () => {
  clearToolLog();
});

// ============================================================ 设置面板

el.btnSettings.addEventListener('click', () => {
  if (state.currentView === 'settings') showView('chat');
  else showView('settings');
});
el.btnContextClose.addEventListener('click', () => showView('chat'));

el.contextTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.settingsTab = tab.dataset.tab;
  renderSettings();
});

async function openSettings() {
  showView('settings');
  await renderSettings();
}

async function renderSettings() {
  // 高亮当前 tab
  el.contextTabs.querySelectorAll('[data-tab]').forEach((node) => {
    node.dataset.active = node.dataset.tab === state.settingsTab ? 'true' : 'false';
  });
  const titles = {
    agent: '智能体配置',
    persona: '角色设定',
    memory: '记忆',
    skills: '技能',
    toolchain: '本机工具',
    media: '本地媒体引擎',
    workspace: '工作区',
    'gateway-diag': 'Gateway 诊断'
  };
  el.contextTitle.textContent = titles[state.settingsTab] || '设置';
  el.contextBody.textContent = '加载中…';
  try {
    if (state.settingsTab === 'agent') await renderAgentTab();
    else if (state.settingsTab === 'persona') await renderPersonaTab();
    else if (state.settingsTab === 'memory') await renderMemoryTab();
    else if (state.settingsTab === 'skills') await renderSkillsTab();
    else if (state.settingsTab === 'toolchain') await renderToolchainTab();
    else if (state.settingsTab === 'media') await renderMediaTab();
    else if (state.settingsTab === 'workspace') await renderWorkspaceTab();
    else if (state.settingsTab === 'gateway-diag') await renderGatewayDiagTab();
  } catch (error) {
    el.contextBody.textContent = `加载失败：${error.message}`;
  }
}

// ---- 智能体配置面板：每个智能体独立的工作区 / 权限 / 模型 ----

async function renderAgentTab() {
  const agents = await api.agents().catch(() => ({ agents: [], activeId: null }));
  const agent = agents.agents.find((a) => a.id === agents.activeId) || agents.agents[0];
  if (!agent) { el.contextBody.textContent = '暂无智能体'; return; }
  const modelList = await api.models().catch(() => null);
  const models = (Array.isArray(modelList) && modelList.length) ? modelList : ['hermes-agent'];
  el.contextBody.innerHTML = `
    <h2>智能体配置</h2>
    <p class="hint">每个智能体都有独立的工作目录、权限档位和默认模型；角色、技能、记忆跟随各自的工作区。点击左侧列表可切换。</p>

    <label class="settings-field">名称
      <input id="agent-name" value=""></label>
    <label class="settings-field">工作目录（留空 = 默认工作区）
      <div class="workspace-row">
        <input id="agent-workspace" spellcheck="false" placeholder="D:\\work\\buddy">
        <button class="ghost" id="agent-pick" type="button">浏览…</button>
      </div>
    </label>
    <label class="settings-field">默认模型
      <select id="agent-model"></select>
    </label>
    <fieldset class="perm-fieldset">
      <legend>工具权限档位</legend>
      <label class="perm-option"><input type="radio" name="agent-perm" value="read"><span><strong>只读</strong></span></label>
      <label class="perm-option"><input type="radio" name="agent-perm" value="read-write"><span><strong>读 + 写</strong></span></label>
      <label class="perm-option"><input type="radio" name="agent-perm" value="full"><span><strong>完全控制</strong></span></label>
    </fieldset>
    <div class="settings-actions">
      <button class="primary" id="agent-save" type="button">保存并生效</button>
      <button class="ghost danger" id="agent-delete" type="button" ${agents.agents.length <= 1 ? 'disabled title="至少保留一个智能体"' : ''}>删除此智能体</button>
    </div>
    <div class="settings-status" id="agent-status" role="status"></div>
  `;
  $('agent-name').value = agent.name;
  $('agent-workspace').value = agent.workspace || '';
  const modelSelect = $('agent-model');
  for (const id of models) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    modelSelect.appendChild(option);
  }
  if (models.includes(agent.model)) modelSelect.value = agent.model;
  const permInput = el.contextBody.querySelector(`input[name="agent-perm"][value="${agent.permission}"]`);
  if (permInput) permInput.checked = true;

  $('agent-pick').addEventListener('click', async () => {
    const result = await api.pickWorkspacePath().catch(() => null);
    if (result && !result.canceled && result.path) $('agent-workspace').value = result.path;
  });

  $('agent-save').addEventListener('click', async () => {
    const patch = {
      name: $('agent-name').value.trim(),
      workspace: $('agent-workspace').value.trim(),
      model: modelSelect.value,
      permission: (el.contextBody.querySelector('input[name="agent-perm"]:checked') || {}).value
    };
    try {
      const result = await api.updateAgent(agent.id, patch);
      $('agent-status').textContent = (result && result.warning)
        ? `已保存，但${result.warning}`
        : '已保存并生效（工作区、权限、模型都已切换）。';
      $('agent-status').dataset.tone = (result && result.warning) ? 'warn' : 'ok';
      await refreshChatForAgent();
    } catch (error) {
      $('agent-status').textContent = `保存失败：${error.message}`;
      $('agent-status').dataset.tone = 'error';
    }
  });

  $('agent-delete').addEventListener('click', async () => {
    if (!confirm(`删除智能体「${agent.name}」？其工作目录内的文件不会被删除。`)) return;
    try {
      await api.removeAgent(agent.id);
      await refreshChatForAgent();
      renderAgentTab();
    } catch (error) {
      $('agent-status').textContent = `删除失败：${error.message}`;
      $('agent-status').dataset.tone = 'error';
    }
  });
}

async function renderPersonaTab() {
  const result = await api.persona();
  const text = (result && result.persona) || '';
  el.contextBody.innerHTML = `
    <h2>角色设定（System Prompt 开头）</h2>
    <p class="hint">告诉 Hermes 怎么称呼你、希望它用哪种语气、是否要在每轮回答前先复述目标。这是 Hermes Buddy 的核心"性格"文件。</p>
    <textarea id="persona-text" rows="14"></textarea>
    <div class="settings-actions">
      <button class="primary" id="save-persona">保存</button>
    </div>
    <div class="settings-status" id="persona-status" role="status"></div>
  `;
  $('persona-text').value = text;
  $('save-persona').addEventListener('click', async () => {
    const value = $('persona-text').value;
    try {
      await api.savePersona(value);
      $('persona-status').textContent = '已保存，下次对话生效。';
      $('persona-status').dataset.tone = 'ok';
    } catch (error) {
      $('persona-status').textContent = error.message;
      $('persona-status').dataset.tone = 'error';
    }
  });
}

async function renderMemoryTab() {
  const [globalResult, projectResult, diag] = await Promise.all([
    api.memory('global').catch(() => ({ content: '' })),
    api.memory('project').catch(() => ({ content: '' })),
    api.memoryDiagnostics().catch(() => ({ ready: false }))
  ]);
  const fmtTime = (ts) => {
    if (!ts) return '从未';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN', { hour12: false });
  };
  const crystallizeStatus = (() => {
    if (!diag.ready) return '工作区未就绪，无法同步。';
    const { lastCrystallize } = diag;
    if (!lastCrystallize || !lastCrystallize.at) return '尚未同步到服务端（连接后会自动同步）。';
    if (lastCrystallize.error) return `上次同步失败：${lastCrystallize.error}`;
    return `上次同步成功（${fmtTime(lastCrystallize.at)}），范围：${lastCrystallize.scopes.join(' / ') || '无内容'}。`;
  })();
  el.contextBody.innerHTML = `
    <h2>记忆</h2>
    <p class="hint">Buddy 会自动把每天的工作摘要写进日志。这里集中管理"长期记忆"和"当前项目记忆"。模型也会在对话中自动调用 remember 工具记录重要事实。</p>
    <section>
      <h3>项目记忆（仅本工作区可见）</h3>
      <textarea id="memory-project" rows="8"></textarea>
    </section>
    <section>
      <h3>全局记忆（跨工作区生效）</h3>
      <textarea id="memory-global" rows="6"></textarea>
    </section>
    <div class="settings-actions">
      <button class="primary" id="save-memory-project">保存项目记忆</button>
      <button class="ghost" id="save-memory-global">保存全局记忆</button>
    </div>
    <div class="settings-status" id="memory-status" role="status"></div>
    <details class="memory-diagnostics">
      <summary>记忆诊断信息</summary>
      <dl>
        <dt>工作区</dt><dd>${diag.ready ? escapeHtml(diag.workspace) : '未就绪'}</dd>
        <dt>项目记忆文件</dt><dd>${diag.ready ? escapeHtml(diag.projectPath) : '-'}</dd>
        <dt>全局记忆文件</dt><dd>${diag.ready ? escapeHtml(diag.globalPath) : '-'}</dd>
        <dt>项目记忆字符数</dt><dd>${diag.projectChars || 0}</dd>
        <dt>全局记忆字符数</dt><dd>${diag.globalChars || 0}</dd>
        <dt>服务端结晶同步</dt><dd>${escapeHtml(crystallizeStatus)}</dd>
      </dl>
      <p class="hint">如果这里长期为空，但对话里已经让模型"记住"过东西，说明模型没有调用 remember 工具。可以提醒它："请用 remember 工具记下来"。</p>
    </details>
  `;
  $('memory-project').value = projectResult.content || '';
  $('memory-global').value = globalResult.content || '';
  $('save-memory-project').addEventListener('click', async () => {
    try {
      await api.saveMemory('project', $('memory-project').value);
      $('memory-status').textContent = '项目记忆已保存。';
      $('memory-status').dataset.tone = 'ok';
    } catch (error) {
      $('memory-status').textContent = error.message;
      $('memory-status').dataset.tone = 'error';
    }
  });
  $('save-memory-global').addEventListener('click', async () => {
    try {
      await api.saveMemory('global', $('memory-global').value);
      $('memory-status').textContent = '全局记忆已保存。';
      $('memory-status').dataset.tone = 'ok';
    } catch (error) {
      $('memory-status').textContent = error.message;
      $('memory-status').dataset.tone = 'error';
    }
  });
}

async function renderSkillsTab() {
  const result = await api.skills();
  const skills = (result && result.skills) || [];
  el.contextBody.innerHTML = `
    <h2>技能（Skills）</h2>
    <p class="hint">技能是 Markdown 写成的"操作手册"，会作为上下文拼进系统提示词。Buddy 自带 windows-shell / file-editing / git-workflow 三个基础技能，你也可以写自己的。</p>
    <ul class="skill-list" id="skill-list"></ul>
    <details class="skill-add">
      <summary>新增 / 覆盖技能</summary>
      <label>名称（英文短词）<input id="skill-name"></label>
      <label>简介<input id="skill-desc"></label>
      <label>Markdown 内容<textarea id="skill-content" rows="6"></textarea></label>
      <div class="settings-actions">
        <button class="primary" id="save-skill">保存技能</button>
      </div>
      <div class="settings-status" id="skill-status" role="status"></div>
    </details>
  `;
  const list = $('skill-list');
  for (const skill of skills) {
    const li = document.createElement('li');
    li.className = 'skill-item';
    li.dataset.builtin = skill.builtin ? 'true' : 'false';
    li.innerHTML = `
      <div class="skill-item-head">
        <span class="skill-name">${skill.name}</span>
        <span class="skill-source">${skill.builtin ? '内置' : '工作区'}</span>
        <button class="link" data-action="read">查看</button>
        ${skill.builtin ? '' : '<button class="link danger" data-action="remove">删除</button>'}
      </div>
      <div class="skill-desc"></div>
      <pre class="skill-body" hidden></pre>
    `;
    li.querySelector('.skill-desc').textContent = skill.description || '（无简介）';
    li.querySelector('[data-action="read"]').addEventListener('click', async () => {
      const detail = await api.readSkill(skill.name).catch(() => ({ skill: null }));
      const body = li.querySelector('.skill-body');
      if (detail.skill && detail.skill.content) {
        body.textContent = detail.skill.content;
        body.hidden = !body.hidden;
      }
    });
    if (!skill.builtin) {
      li.querySelector('[data-action="remove"]').addEventListener('click', async () => {
        if (!confirm(`删除技能「${skill.name}」？`)) return;
        try {
          await api.removeSkill(skill.name);
          renderSkillsTab();
        } catch (error) {
          alert(error.message);
        }
      });
    }
    list.appendChild(li);
  }
  $('save-skill').addEventListener('click', async () => {
    const name = $('skill-name').value.trim();
    const description = $('skill-desc').value.trim();
    const content = $('skill-content').value;
    if (!name || !content) {
      $('skill-status').textContent = '名称与内容必填';
      $('skill-status').dataset.tone = 'error';
      return;
    }
    try {
      await api.saveSkill(name, content, description);
      $('skill-status').textContent = '已保存。';
      $('skill-status').dataset.tone = 'ok';
      renderSkillsTab();
    } catch (error) {
      $('skill-status').textContent = error.message;
      $('skill-status').dataset.tone = 'error';
    }
  });
}

async function renderToolchainTab() {
  const result = await api.toolchain();
  const tools = (result && result.tools) || [];
  el.contextBody.innerHTML = `
    <h2>本机工具</h2>
    <p class="hint">Buddy 完全靠这些工具干活：缺哪个就装哪个；带"一键安装"的会用 PowerShell 包管理器装到系统里。</p>
    <div id="toolchain-list"></div>
  `;
  const list = $('toolchain-list');
  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool-item';
    card.dataset.ok = tool.available ? 'true' : 'false';
    card.innerHTML = `
      <div class="tool-item-head">
        <span class="tool-item-name">${tool.label}</span>
        <span class="tool-item-status">${tool.available ? '✓ 已就绪' : '✗ 缺失'}</span>
      </div>
      <div class="tool-item-path"></div>
      <div class="tool-item-note"></div>
    `;
    card.querySelector('.tool-item-path').textContent = tool.path || '未检测到路径';
    card.querySelector('.tool-item-note').textContent = tool.note || '';
    if (!tool.available && tool.installable) {
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = '一键安装';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '安装中…';
        try {
          await api.installTool(tool.id);
          await renderToolchainTab();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = '重试安装';
          alert(error.message);
        }
      });
      card.appendChild(btn);
    }
    list.appendChild(card);
  }
}

// ---- 本地媒体引擎：语音/视频本地转写所需（Whisper + 模型 + ffmpeg） ----

async function renderMediaTab() {
  el.contextBody.innerHTML = `
    <h2>本地媒体引擎</h2>
    <p class="hint">发语音或视频时，Buddy 会先在本机把它转成文字、抽出关键帧，只把文字和图片发给 AI——原始音视频不出本机。这需要本机的 Whisper 与 ffmpeg，点一下就能装好（装在应用数据目录，不写 PATH、不需要管理员权限）。</p>
    <div id="media-engine-list"></div>
    <label class="settings-field">语音模型
      <select id="media-engine-model">
        <option value="tiny">tiny（约 78 MB，最快、精度一般）</option>
        <option value="base" selected>base（约 148 MB，推荐）</option>
        <option value="small">small（约 488 MB，更准但更慢）</option>
      </select>
    </label>
    <div class="settings-actions">
      <button class="primary" id="media-engine-install" type="button">一键安装</button>
      <button class="ghost" id="media-engine-opendir" type="button">打开引擎目录</button>
    </div>
    <p class="hint" id="media-engine-tip"></p>
  `;

  const list = $('media-engine-list');
  const tip = $('media-engine-tip');
  const btn = $('media-engine-install');
  const sel = $('media-engine-model');

  const status = await api.mediaEngineStatus().catch(() => null);
  const items = [
    { key: 'whisper', label: 'Whisper（语音转写）', info: status && status.whisper },
    { key: 'model', label: '语音模型（ggml-*.bin）', info: status && status.model },
    // ffmpeg 现在只是「可选」：新录音直接产出 WAV，只有视频抽帧/抽音轨、以及导入的
    // mp3/m4a/webm 等压缩音频才需要它转码。所以单独标成"可选"，别让用户以为缺了就不能用。
    { key: 'ffmpeg', label: 'ffmpeg（可选：视频抽帧 / 导入音频转码）', info: status && status.ffmpeg, optional: true }
  ];
  const missing = [];
  const optionalMissing = [];
  for (const it of items) {
    const ok = !!(it.info && it.info.ok);
    if (!ok) (it.optional ? optionalMissing : missing).push(it.key);
    const card = document.createElement('div');
    card.className = 'tool-item';
    card.dataset.ok = ok ? 'true' : 'false';
    card.innerHTML = `
      <div class="tool-item-head">
        <span class="tool-item-name"></span>
        <span class="tool-item-status">${ok ? '✓ 已就绪' : (it.optional ? '○ 可选，未安装' : '✗ 缺失')}</span>
      </div>
      <div class="tool-item-path"></div>
    `;
    card.querySelector('.tool-item-name').textContent = it.label;
    card.querySelector('.tool-item-path').textContent = (it.info && it.info.path) || '未检测到';
    list.appendChild(card);
  }
  if (status && status.dir) {
    const dir = document.createElement('p');
    dir.className = 'hint';
    dir.textContent = `引擎目录：${status.dir}`;
    list.appendChild(dir);
  }

  if (optionalMissing.length) {
    const opt = document.createElement('p');
    opt.className = 'hint';
    opt.textContent = 'ffmpeg 未安装也不影响录音转写（新录音已在本地直接转成 Whisper 可用的 WAV）；'
      + '只有视频抽帧/抽音轨，或导入 mp3、m4a、webm 等压缩音频时才需要它。';
    list.appendChild(opt);
  }
  btn.textContent = missing.length ? '一键安装缺失组件'
    : (optionalMissing.length ? '安装可选组件（ffmpeg）' : '重新安装 / 更新');
  btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '安装中…';
    tip.textContent = '正在准备…';
    const off = api.onMediaEngineProgress((p) => {
      tip.textContent = (p && p.message) ? p.message : '安装中…';
    });
    try {
      // 必装缺失优先；全都齐了就按用户点"重新安装"处理，把可选组件一起补上
      const comps = missing.length ? missing : (optionalMissing.length ? optionalMissing : ['whisper', 'model', 'ffmpeg']);
      const res = await api.installMediaEngines({
        components: comps,
        model: sel.value || 'base'
      });
      if (res && res.error) throw new Error(res.error);
      await renderMediaTab();
    } catch (error) {
      tip.textContent = `安装失败：${cleanIpcError(error && error.message) || error}。`
        + '你也可以手动把 whisper-cli.exe / ffmpeg.exe / ggml-*.bin 放进引擎目录。';
      btn.disabled = false;
      btn.textContent = label;
    } finally {
      if (typeof off === 'function') off();
    }
  });

  $('media-engine-opendir').addEventListener('click', () => { api.openMediaEngineDir(); });
}

async function renderWorkspaceTab() {
  const ws = await api.workspace();
  el.contextBody.innerHTML = `
    <h2>工作区</h2>
    <p class="hint">所有工具调用都限制在这个目录之下。Hermes 看不到工作区外的文件，也执行不了工作区外的命令。</p>
    <div class="kv">
      <div class="k">根目录</div><div class="v"></div>
      <div class="k">存在</div><div class="v"></div>
      <div class="k">AGENTS.md</div><div class="v"></div>
    </div>
    <div class="workspace-actions">
      <button class="primary" id="change-workspace">切换目录</button>
      <button class="ghost" id="open-workspace">在资源管理器中打开</button>
    </div>
    <h3>目录摘要</h3>
    <pre class="tree" id="tree"></pre>
  `;
  el.contextBody.querySelectorAll('.v')[0].textContent = ws.root || '未设置';
  el.contextBody.querySelectorAll('.v')[1].textContent = ws.exists ? '是' : '否（首次使用会创建）';
  el.contextBody.querySelectorAll('.v')[2].textContent = ws.hasAgents ? ws.agentsFile : '未生成';
  $('tree').textContent = ws.tree || '（空目录）';
  $('change-workspace').addEventListener('click', async () => {
    try {
      const result = await api.pickWorkspace();
      if (result && result.root) renderWorkspaceTab();
    } catch (error) {
      alert(error.message);
    }
  });
  $('open-workspace').addEventListener('click', async () => {
    try { await api.openWorkspace(); }
    catch (error) { alert(error.message); }
  });
}

// ============================================================ 横幅与外部链接

el.bannerAction.addEventListener('click', async () => {
  if (!state.bannerActionUrl && !state.bannerActionClick) return;
  if (state.bannerActionClick) { state.bannerActionClick(); return; }
  await api.openExternal(state.bannerActionUrl).catch((error) => showBanner(error.message || '无法打开链接', 'error'));
});
// 关闭按钮同时响应 click 与 pointerdown，并阻止冒泡，避免被横幅其他区域吞掉事件。
function dismissBanner(event) {
  if (event) event.stopPropagation();
  hideBanner();
}
el.bannerDismiss.addEventListener('click', dismissBanner);
el.bannerDismiss.addEventListener('pointerdown', dismissBanner);

// ---- 自动更新：探测 → 后台下载（聊天不受影响）→ 一键重启静默安装 ----

async function autoCheckUpdate() {
  if (state.updateDownloading) return;
  const result = await api.update().catch(() => null);
  if (!result || !result.ok || !result.updateAvailable) return;
  if (result.readyToInstall) {
    showBanner(`新版本 ${result.latest} 已下载完成，重启即可完成更新`, 'info', { label: '立即重启安装', onClick: installNow });
    return;
  }
  startDownload(result);
}

function installNow() {
  showBanner('正在退出并安装新版本…');
  api.installUpdate().catch((error) => showBanner(`安装失败：${error.message}`, 'error'));
}

api.onUpdateProgress((progress) => {
  if (progress && typeof progress.percent === 'number') {
    showBanner(`新版本正在后台下载… ${progress.percent}%（不影响当前使用）`);
    state.updateDownloading = true;
  }
});

async function startDownload(result) {
  state.updateDownloading = true;
  showBanner(`发现新版本 ${result.latest}（当前 ${result.current}），正在后台下载…`);
  try {
    await api.downloadUpdate({
      downloadUrl: result.downloadUrl,
      mirrorUrl: result.mirrorUrl,
      size: result.assetSize || 0
    });
    state.updateDownloading = false;
    showBanner(`新版本 ${result.latest} 已就绪，重启即可完成更新`, 'info', { label: '立即重启安装', onClick: installNow });
  } catch (error) {
    state.updateDownloading = false;
    const url = result.mirrorUrl || result.downloadUrl || result.releasePage;
    showBanner(`自动下载失败（${error.message || '网络原因'}）`, 'warn', url ? { label: '手动下载', url } : null);
  }
}

el.btnUpdate.addEventListener('click', async () => {
  if (state.updateDownloading) { showBanner('更新正在下载中，请稍候…'); return; }
  showBanner('正在检查更新…');
  const result = await api.update().catch(() => ({ ok: false, reason: 'error' }));
  if (!result.ok) { showBanner(`无法检查更新（${result.reason || '未知原因'}），可稍后重试或用镜像地址手动下载`, 'warn'); return; }
  if (!result.updateAvailable) { showBanner(`已是最新版本（${result.current}）`); return; }
  if (result.readyToInstall) {
    showBanner(`新版本 ${result.latest} 已下载完成，重启即可完成更新`, 'info', { label: '立即重启安装', onClick: installNow });
    return;
  }
  startDownload(result);
});

async function renderGatewayDiagTab() {
  const status = await api.status().catch(() => ({}));
  const gwError = status.gatewayError || null;
  el.contextBody.innerHTML = `
    <h2>Gateway 诊断</h2>
    <p class="hint">Gateway 负责会话登记与部署清单，不影响聊天与本机工具。如果 Key 不对或端口不通，这里会显示具体原因。</p>
    <div class="kv" id="gw-diag-kv">
      <div class="k">状态</div><div class="v" id="gw-diag-status"></div>
      <div class="k">错误码</div><div class="v" id="gw-diag-code"></div>
      <div class="k">诊断信息</div><div class="v" id="gw-diag-msg"></div>
      <div class="k">LLM 端点</div><div class="v" id="gw-diag-llm"></div>
      <div class="k">Gateway 地址</div><div class="v" id="gw-diag-gw"></div>
    </div>
    <div class="settings-actions" id="gw-diag-actions" hidden>
      <button class="ghost" id="gw-diag-copy-cmd">复制 Key 确认命令</button>
      <button class="ghost" id="gw-diag-retry">重试连接 Gateway</button>
    </div>
    <div class="settings-status" id="gw-diag-status" role="status"></div>
  `;
  $('gw-diag-status').textContent = gwError ? '异常' : '未配置或从未失败';
  $('gw-diag-status').dataset.tone = gwError ? 'error' : 'ok';
  $('gw-diag-code').textContent = gwError ? gwError.code : (status.configured ? '无' : '未配置');
  $('gw-diag-msg').textContent = gwError ? gwError.message : '当前无错误信息';
  $('gw-diag-llm').textContent = status.llmUrl || '未配置';
  $('gw-diag-gw').textContent = status.baseUrl || '未配置';
  
  if (gwError) $('gw-diag-actions').hidden = false;
  
  // 复制 Key 确认命令
  $('gw-diag-copy-cmd').addEventListener('click', async () => {
    const cmd = `cat /root/.hermes/.api_server_key 2>/dev/null || grep API_SERVER_KEY /root/.hermes/data/.env 2>/dev/null || echo "请在 ~/.hermes/ 目录下查找"`;
    try {
      await navigator.clipboard.writeText(cmd);
      $('gw-diag-status').textContent = '已复制到剪贴板';
      $('gw-diag-status').dataset.tone = 'ok';
    } catch (e) {
      $('gw-diag-status').textContent = `复制失败：${e.message}`;
      $('gw-diag-status').dataset.tone = 'error';
    }
  });
  
  // 重试连接 Gateway
  $('gw-diag-retry').addEventListener('click', async () => {
    $('gw-diag-status').textContent = '正在重试…';
    $('gw-diag-status').dataset.tone = 'info';
    try {
      // 重新触发一次 Gateway 连接尝试（用已保存的凭据）
      const result = await api.resume().catch(() => ({ ok: false, message: '重试失败' }));
      if (result.ok && result.status && result.status.connected) {
        $('gw-diag-status').textContent = 'Gateway 连接成功！';
        $('gw-diag-status').dataset.tone = 'ok';
        applyStatus(result.status);
      } else if (result.gatewayWarning) {
        $('gw-diag-status').textContent = `重试失败：${result.gatewayWarning}`;
        $('gw-diag-status').dataset.tone = 'error';
      } else {
        $('gw-diag-status').textContent = `重试失败：Gateway 仍不可达。请确认服务端 Key 和端口。`;
        $('gw-diag-status').dataset.tone = 'error';
      }
    } catch (e) {
      $('gw-diag-status').textContent = `重试异常：${e.message}`;
      $('gw-diag-status').dataset.tone = 'error';
    }
  });
}

el.modelSelect.addEventListener('change', () => {
  // 模型切换后下一次 send 会带入；不立即生效是符合预期的。
});

// ============================================================ 启动



// ============================================================ 多网关（已保存连接）

async function showConnectWithProfiles() {
  showView('connect');
  state.wizardFromProfiles = false;
  if (el.btnWizardBack0) el.btnWizardBack0.hidden = true;
  const hasProfiles = await renderProfiles();
  if (hasProfiles) {
    el.connectProfiles.hidden = false;
    el.step0.hidden = true;
    el.step1.hidden = true;
    el.step2.hidden = true;
  } else {
    el.connectProfiles.hidden = true;
    showWizardStep(0);
  }
}

async function renderProfiles() {
  let data = { activeId: null, profiles: [] };
  try { data = await api.profiles(); } catch (_) {}
  const list = el.connectProfilesList;
  list.textContent = '';
  if (!data.profiles || !data.profiles.length) {
    list.innerHTML = '<div class="profile-empty">还没有保存的连接，点下方"＋ 新建连接"。</div>';
    el.connectProfiles.hidden = false;
    return false;
  }
  for (const p of data.profiles) {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.active = String(p.id === data.activeId);
    const host = p.baseUrl ? p.baseUrl.replace(/^https?:\/\//, '') : (p.channelUrl || p.host || '');
    const sub = [];
    if (p.profile) sub.push('profile: ' + p.profile);
    if (p.model) sub.push('model: ' + p.model);
    card.innerHTML = `
      <div class="profile-main">
        <div class="profile-host"></div>
        <div class="profile-sub"></div>
        <div class="profile-version" data-state="probing">正在探测服务端版本…</div>
      </div>
      <div class="profile-actions">
        <button class="ghost profile-use" type="button">连接</button>
        <button class="link danger profile-del" type="button">删除</button>
      </div>
    `;
    card.querySelector('.profile-host').textContent = host || '未命名连接';
    card.querySelector('.profile-sub').textContent = sub.join(' · ') || '无额外配置';
    if (p.id === data.activeId) {
      const badge = document.createElement('span');
      badge.className = 'profile-current';
      badge.textContent = '当前';
      card.querySelector('.profile-main').appendChild(badge);
    }
    card.querySelector('.profile-use').addEventListener('click', () => activateProfileFlow(p.id));
    card.querySelector('.profile-del').addEventListener('click', () => removeProfileFlow(p.id, host));
    list.appendChild(card);
    // 异步嗅探服务端版本，不阻塞列表渲染
    api.probeProfile(p).then((probe) => {
      const verEl = card.querySelector('.profile-version');
      if (!verEl) return;
      if (probe.error) {
        verEl.dataset.state = 'unknown';
        verEl.textContent = '版本探测失败：' + probe.error;
      } else if (probe.needsRedeploy) {
        verEl.dataset.state = 'outdated';
        verEl.textContent = `服务端版本 ${probe.version} 过旧，需重新部署（要求 ${probe.required}+）`;
      } else if (probe.ok) {
        verEl.dataset.state = 'ok';
        verEl.textContent = `服务端版本 ${probe.version} ✓`;
      } else {
        verEl.dataset.state = 'unknown';
        verEl.textContent = '版本状态未知';
      }
    }).catch(() => {
      const verEl = card.querySelector('.profile-version');
      if (verEl) { verEl.dataset.state = 'unknown'; verEl.textContent = '版本探测失败'; }
    });
  }
  return true;
}

async function activateProfileFlow(id) {
  setConnectStatus('正在切换到所选连接…');
  try {
    // buddy:profile:activate 内部已经做了 setActiveProfile + resume（含 WS 通道连接）。
    // 不要再单独调一次 api.resume()：那样会开第二条通道，server 单会话下第二次握手会失败，
    // 于是代码掉进手动表单分支，用户看到的就是"点连接连不上"。
    const result = await api.activateProfile(id);
    if (!result || result.ok === false) throw new Error((result && result.message) || '切换失败');
    setStatusDot('busy');
    const st = result.status || (await api.status().catch(() => ({ configured: true })));
    await enterChat(st);
    if (result.gatewayWarning) renderNotice({ message: 'Gateway 未就绪（' + result.gatewayWarning + '），聊天和本机工具不受影响。' });
  } catch (error) {
    // 自动连接失败：把已保存的参数回填到向导第 2 步，方便手动微调后重连
    el.connectProfiles.hidden = true;
    showWizardStep(2);
    const s2 = await api.status().catch(() => ({}));
    if (s2.baseUrl) el.fieldHostConfirm.value = hostFromConnection(s2);
    if (s2.baseUrl) el.fieldBaseUrl.value = s2.baseUrl;
    if (s2.channelUrl) el.fieldChannelUrl.value = s2.channelUrl;
    if (s2.channelPath) el.fieldChannelPath.value = s2.channelPath;
    if (s2.profile) el.fieldProfile.value = s2.profile;
    if (s2.model) el.fieldModel.value = s2.model;
    if (s2.workspace) el.fieldWorkspace.value = s2.workspace;
    setConnectStatus('切换到该连接失败：' + (error.message || '未知原因') + '。可在此手动调整后重新连接。', 'warn');
  }
}

async function removeProfileFlow(id, host) {
  if (!confirm(`删除已保存的连接「${host || id}」？\n该操作只移除本地保存的配置，不会卸载 Hermes 服务端。`)) return;
  try {
    const result = await api.removeProfile(id);
    const activeNow = result && result.activeId;
    await renderProfiles();
    if (!activeNow) {
      el.connectProfiles.hidden = false;
      el.step0.hidden = true;
    }
    setConnectStatus('已删除连接。');
  } catch (error) {
    setConnectStatus('删除失败：' + error.message, 'error');
  }
}

el.btnAddConn.addEventListener('click', () => {
  el.connectProfiles.hidden = true;
  state.wizardFromProfiles = true;
  if (el.btnWizardBack0) el.btnWizardBack0.hidden = false;
  showWizardStep(0);
});

// 步骤 0 的"返回已保存连接"：从管理连接里点新建进来的，给一条回去的路
el.btnWizardBack0.addEventListener('click', () => {
  showConnectWithProfiles();
});

el.btnManageConn.addEventListener('click', () => {
  showConnectWithProfiles();
});

(async function boot() {
  try {
    const info = await api.appInfo();
    el.foot.textContent = `v${info.version} · Electron ${info.electron} · ${info.platform} · ${info.encryptionAvailable ? '凭据加密可用' : '凭据加密不可用'}`;
    if (!info.encryptionAvailable) showBanner('Windows 凭据加密不可用，连接信息将无法保存。请确认在 Windows 用户会话中运行。', 'warn');
  } catch (_) {
    el.foot.textContent = 'Hermes Buddy';
  }

  let status = await api.status().catch(() => ({ configured: false }));
  applyStatus(status);
  if (!status.configured) {
    await showConnectWithProfiles();
    return;
  }

  // 已配置：尝试恢复连接
  setStatusDot('busy');
  const resumed = await api.resume().catch((error) => ({ ok: false, message: error.message }));
  if (resumed.ok) {
    status = await api.status().catch(() => status);
    await enterChat(status);
    if (resumed.endpointNotice) {
      renderNotice({ message: resumed.endpointNotice });
    }
    if (resumed.gatewayWarning) {
      renderNotice({ message: 'Gateway 未就绪（' + resumed.gatewayWarning + '），聊天和本机工具不受影响。' });
    }
  } else {
    // 恢复失败：直接跳到步骤 2 让用户确认参数
    showView('connect');
    showWizardStep(2);
    if (status.baseUrl) el.fieldBaseUrl.value = status.baseUrl;
    if (status.channelUrl) el.fieldChannelUrl.value = status.channelUrl;
    if (status.channelPath) el.fieldChannelPath.value = status.channelPath;
    if (status.profile) el.fieldProfile.value = status.profile;
    if (status.model) el.fieldModel.value = status.model;
    if (status.workspace) el.fieldWorkspace.value = status.workspace;
    const permRadio = el.connectForm.querySelector('input[name="permission"][value="' + (status.permission || 'read-write') + '"]');
    if (permRadio) permRadio.checked = true;
    setConnectStatus('已有 Hermes 配置，但会话没能恢复：' + (resumed.message || '未知原因') + '。请确认参数后重新连接。', 'warn');
    setStatusDot('error');
  }
})();