'use strict';

/**
 * 渲染层：只做界面。所有网络、文件系统与凭据操作都走 preload 暴露的 buddyApi，
 * 渲染进程拿不到 Node、拿不到 API Key、也拿不到任何凭据明文。
 * 模型输出永远用 textContent 落地，杜绝把它当 HTML 解释。
 */

const api = window.buddyApi || window.hermesBuddy;
const $ = (id) => document.getElementById(id);

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
  pendingConfirm: null         // confirmId
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
  el.step1Title.textContent = '部署 Hermes 外挂组件';
  el.step1Sub.textContent = '填入 SSH 信息和上游模型供应商，一键部署';
  el.btnWizardAction.textContent = '部署并连接';
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
      const deployResult = await api.deployToServer({ host, user, keyPath, password, sshPort, upstreamBase, upstreamKey, upstreamModel });
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

function renderNotice({ message }) {
  const track = ensureToolTrack();
  const node = document.createElement('div');
  node.className = 'notice';
  node.textContent = message;
  track.appendChild(node);
  hideToolEmpty();
  scrollTools();
}

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
  setStatusDot(busy ? 'busy' : 'online');
  if (!busy) el.input.focus();
}

// Electron 给主进程抛出的错误加了一层壳：
// "Error invoking remote method 'buddy:chat': Error: <真正的信息>"
// 直接显示会盖住真正的原因，这里剥掉。
function cleanIpcError(raw) {
  return String(raw || '').replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim();
}

async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || state.activeRequestId) return;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.activeRequestId = requestId;
  addMessage('user', text);
  el.input.value = '';
  beginAssistantBubble();
  setBusy(true);
  try {
    const result = await api.chat({ requestId, text, model: el.modelSelect.value || undefined });
    finishAssistantBubble(result && result.text);
  } catch (error) {
    finishAssistantBubble('');
    const message = cleanIpcError(error && error.message) || '本地 Agent 调用失败';
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
  const [globalResult, projectResult] = await Promise.all([
    api.memory('global').catch(() => ({ content: '' })),
    api.memory('project').catch(() => ({ content: '' }))
  ]);
  el.contextBody.innerHTML = `
    <h2>记忆</h2>
    <p class="hint">Buddy 会自动把每天的工作摘要写进日志。这里集中管理"长期记忆"和"当前项目记忆"。</p>
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