'use strict';

/**
 * 渲染层：只做界面。所有网络、文件系统与凭据操作都走 preload 暴露的 buddyApi，
 * 渲染进程拿不到 Node、拿不到 API Key、也拿不到任何凭据明文。
 * 模型输出永远用 textContent 落地，杜绝把它当 HTML 解释。
 */

const api = window.buddyApi || window.hermesBuddy;
const $ = (id) => document.getElementById(id);

const el = {
  // 顶栏
  gatewayLabel: $('gateway-label'),
  statusDot: $('status-dot'),
  modelSelect: $('model-select'),
  btnReconnect: $('btn-reconnect'),
  btnUpdate: $('btn-update'),
  btnDisconnect: $('btn-disconnect'),
  btnSettings: $('btn-settings'),

  // 横幅
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  bannerDismiss: $('banner-dismiss'),

  // 视图
  viewConnect: $('view-connect'),
  viewChat: $('view-chat'),
  viewSettings: $('view-settings'),

  // 连接表单
  connectForm: $('connect-form'),
  fieldHost: $('field-host'),
  fieldBaseUrl: $('field-baseUrl'),
  fieldManagementUrl: $('field-managementUrl'),
  fieldLlmUrl: $('field-llmUrl'),
  fieldApiKey: $('field-apiKey'),
  fieldProfile: $('field-profile'),
  fieldModel: $('field-model'),
  fieldWorkspace: $('field-workspace'),
  btnPickWorkspace: $('btn-pick-workspace'),
  btnConnect: $('btn-connect'),
  connectStatus: $('connect-status'),

  // 诊断 + 服务端脚本
  btnDiagnose: $('btn-diagnose'),
  btnBootstrap: $('btn-bootstrap'),
  diagnoseReport: $('diagnose-report'),

  // 聊天页
  chatLog: $('chat-log'),
  composer: $('composer'),
  input: $('input'),
  btnSend: $('btn-send'),
  btnStop: $('btn-stop'),
  workdirTag: $('workdir-tag'),
  permBadge: $('perm-badge'),

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

  // 设置
  settingsTabs: $('settings-tabs'),
  settingsBody: $('settings-body'),
  btnSettingsClose: $('btn-settings-close'),

  // 底部
  foot: $('foot')
};

const state = {
  activeRequestId: null,
  pendingBubble: null,
  pendingTools: new Map(),     // tool_call_id → 卡片 DOM
  currentView: 'connect',
  settingsTab: 'persona',
  bannerActionUrl: null,
  pendingConfirm: null         // confirmId
};

// ============================================================ 顶栏 / 横幅

function setStatusDot(s) { el.statusDot.dataset.state = s; }

function showBanner(text, tone = 'info', action = null) {
  el.bannerText.textContent = text;
  el.banner.dataset.tone = tone;
  el.banner.hidden = false;
  if (action && action.label && action.url) {
    el.bannerAction.textContent = action.label;
    el.bannerAction.hidden = false;
    state.bannerActionUrl = action.url;
  } else {
    el.bannerAction.hidden = true;
    state.bannerActionUrl = null;
  }
}

function hideBanner() { el.banner.hidden = true; }

// ============================================================ 视图切换

function showView(name) {
  state.currentView = name;
  const isConnect = name === 'connect';
  const isChat = name === 'chat';
  const isSettings = name === 'settings';
  el.viewConnect.hidden = !isConnect;
  el.viewChat.hidden = !isChat;
  el.viewSettings.hidden = !isSettings;
  el.btnDisconnect.hidden = !isChat;
  el.btnReconnect.hidden = !isChat;
  el.btnSettings.hidden = !(isChat || isSettings);
  el.modelSelect.disabled = !isChat;
  el.btnSettings.textContent = isSettings ? '回到对话' : '设置';
  if (isChat) el.input.focus();
}

// ============================================================ 连接流程

function setConnectStatus(text, tone = 'info') {
  el.connectStatus.textContent = text;
  el.connectStatus.dataset.tone = tone;
}

/** 从「主机」输入自动推导三个端点，支持 IP、域名、host:port 或完整 URL。 */
function deriveEndpoints(hostValue) {
  const raw = String(hostValue || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const host = url.hostname;
    const port = url.port || '8800';
    return {
      host,
      llmUrl: raw,
      baseUrl: `http://${host}:22122`,
      managementUrl: `http://${host}:8700`
    };
  }

  const m = raw.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const host = m[1];
  const port = m[2] || '8800';
  return {
    host,
    llmUrl: `http://${host}:${port}/v1/chat/completions`,
    baseUrl: `http://${host}:22122`,
    managementUrl: `http://${host}:8700`
  };
}

function hostFromConnection(status) {
  if (!status || !status.llmUrl) return '';
  try {
    const url = new URL(status.llmUrl);
    const port = url.port || '8800';
    return `${url.hostname}:${port}`;
  } catch (_) {
    return status.llmUrl;
  }
}

// ============================================================ 聊天渲染

function scrollToEnd() { el.chatLog.scrollTop = el.chatLog.scrollHeight; }

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
  // 工具卡片挂在最后一个 assistant 气泡后面，按时间顺序排列。
  const lastMsg = [...el.chatLog.querySelectorAll('.msg.assistant')].pop();
  let track;
  if (lastMsg) {
    track = lastMsg.nextElementSibling;
    if (!track || !track.classList.contains('tool-track')) {
      track = document.createElement('div');
      track.className = 'tool-track';
      lastMsg.after(track);
    }
  } else {
    track = el.chatLog.querySelector('.tool-track');
    if (!track) {
      track = document.createElement('div');
      track.className = 'tool-track';
      el.chatLog.appendChild(track);
    }
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
  scrollToEnd();
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
  scrollToEnd();
  state.pendingTools.delete(id);
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
  scrollToEnd();
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
    case 'notice':
      renderNotice(event);
      break;
    case 'error':
      finishAssistantBubble('');
      addMessage('error', event.text || event.message || '本地 Agent 出错');
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
    addMessage('error', (error && error.message) || '本地 Agent 调用失败');
    setStatusDot('error');
  } finally {
    state.activeRequestId = null;
    setBusy(false);
  }
}

async function loadModels(preferred) {
  let models = ['hermes-agent'];
  try { models = await api.models(); } catch (_) {}
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
  const target = status.llmUrl || status.baseUrl || '未连接';
  el.gatewayLabel.textContent = status.connected
    ? `${target} · ${status.profile || 'buddy'}`
    : (status.configured ? `${target}（未就绪）` : '未连接');
  el.workdirTag.hidden = !status.workspace;
  el.workdirTag.textContent = status.workspace ? `工作目录：${status.workspace}` : '';
  el.permBadge.dataset.level = status.permission || 'read-write';
  el.permBadge.textContent = permLabel(status.permission || 'read-write');
  setStatusDot(status.busy ? 'busy' : (status.connected ? 'online' : (status.configured ? 'error' : 'offline')));
}

function permLabel(level) {
  return ({
    read: '只读',
    'read-write': '读 + 写',
    full: '完全控制'
  })[level] || level;
}

async function enterChat(status) {
  applyStatus(status);
  showView('chat');
  await loadModels(status && status.model);
  const history = await api.history().catch(() => []);
  el.chatLog.textContent = '';
  if (Array.isArray(history) && history.length) {
    for (const entry of history) addMessage(entry.role === 'user' ? 'user' : 'assistant', entry.text || '');
  } else {
    showPlaceholder('会话已就绪。Hermes 在远端做决策，工具在本机执行。提问前请确认顶部的工作目录与权限档位。');
  }
  el.input.focus();
}

// ============================================================ 连接表单提交

el.connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = el.fieldHost.value.trim();
  const derived = deriveEndpoints(host);
  if (!derived) {
    setConnectStatus('请输入有效的 Hermes 主机地址（IP、域名或 http://...）', 'error');
    el.fieldHost.focus();
    return;
  }

  const payload = {
    llmUrl: el.fieldLlmUrl.value.trim() || derived.llmUrl,
    baseUrl: el.fieldBaseUrl.value.trim() || derived.baseUrl,
    managementUrl: el.fieldManagementUrl.value.trim() || derived.managementUrl,
    apiKey: el.fieldApiKey.value,
    profile: el.fieldProfile.value.trim() || 'buddy',
    model: el.fieldModel.value.trim() || 'hermes-agent',
    workspace: el.fieldWorkspace.value.trim(),
    permission: el.connectForm.querySelector('input[name="permission"]:checked').value
  };

  el.btnConnect.disabled = true;
  setConnectStatus('正在连接 Hermes…');
  try {
    const result = await api.connect(payload);
    if (result.gatewayWarning) showBanner(`Gateway 未连通（${result.gatewayWarning}），不影响本机工具链路，可在「设置」中重试。`, 'warn');
    setConnectStatus('连接成功，正在进入主界面…', 'ok');
    el.fieldApiKey.value = '';
    await enterChat({ ...(result.connection || {}), connected: true, workspace: payload.workspace });
  } catch (error) {
    setConnectStatus(error.message || '连接失败', 'error');
    setStatusDot('error');
  } finally {
    el.btnConnect.disabled = false;
  }
});

el.btnPickWorkspace.addEventListener('click', async () => {
  try {
    const result = await api.pickWorkspace();
    if (result && result.root) {
      el.fieldWorkspace.value = result.root;
      setConnectStatus(`已选择工作目录：${result.root}`);
    }
  } catch (error) {
    setConnectStatus(`无法选择目录：${error.message}`, 'error');
  }
});

// ============================================================ 诊断 + 服务端脚本

function diagnosePayload() {
  // 提取用户在表单里填的三个端点。诊断时 Key 不下发，所以不传。
  const derived = deriveEndpoints(el.fieldHost.value);
  return {
    llmUrl: el.fieldLlmUrl.value.trim() || (derived && derived.llmUrl),
    gatewayBaseUrl: el.fieldBaseUrl.value.trim() || (derived && derived.baseUrl),
    managementUrl: el.fieldManagementUrl.value.trim() || (derived && derived.managementUrl)
  };
}

function renderDiagnose(report) {
  if (!report || !Array.isArray(report.results)) {
    el.diagnoseReport.hidden = true;
    return;
  }
  el.diagnoseReport.hidden = false;
  el.diagnoseReport.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'dr-title';
  title.textContent = report.ok
    ? '探测通过：Hermes 推理端点可达，可以连接。'
    : '探测失败：推理端点（LLM）不可达，Buddy 无法工作。';
  el.diagnoseReport.appendChild(title);

  const list = document.createElement('ul');
  for (const r of report.results) {
    const li = document.createElement('li');
    li.dataset.state = r.reason;
    const key = document.createElement('div');
    key.className = 'dr-key';
    key.textContent = r.label;
    const detail = document.createElement('div');
    const reason = document.createElement('div');
    reason.className = 'dr-reason';
    reason.textContent = `${r.userMessage}${r.value ? ' · ' + r.value : ''}`;
    detail.appendChild(reason);
    li.appendChild(key);
    li.appendChild(detail);
    list.appendChild(li);
  }
  el.diagnoseReport.appendChild(list);

  if (report.blocking && report.blocking.actionHint === 'bootstrap_server') {
    const hint = document.createElement('div');
    hint.className = 'dr-summary';
    hint.textContent = '提示：点「生成服务端准备脚本」，复制到 Hermes 主机执行后再试。';
    el.diagnoseReport.appendChild(hint);
  } else if (report.blocking && report.blocking.actionHint === 'verify_key') {
    const hint = document.createElement('div');
    hint.className = 'dr-summary';
    hint.textContent = '提示：去服务端跑 `cat /root/.hermes/.api_server_key` 取真实 Key 再回来填。';
    el.diagnoseReport.appendChild(hint);
  }
}

el.btnDiagnose.addEventListener('click', async () => {
  el.diagnoseReport.hidden = true;
  setConnectStatus('正在探测 Hermes 三个端点…');
  try {
    const report = await api.diagnose(diagnosePayload());
    renderDiagnose(report);
    setConnectStatus(report.ok ? '诊断通过，可以进入连接步骤。' : '诊断发现阻塞项，先修服务端再连接。', report.ok ? 'ok' : 'warn');
  } catch (error) {
    setConnectStatus(`诊断失败：${error.message}`, 'error');
  }
});

let lastBootstrapScript = '';
let lastBootstrapHost = '';

el.btnBootstrap.addEventListener('click', async () => {
  const derived = deriveEndpoints(el.fieldHost.value);
  if (!derived) {
    setConnectStatus('先填 Hermes 主机，我才知道服务端脚本该监听哪个地址。', 'warn');
    el.fieldHost.focus();
    return;
  }
  const llmPort = portOf(derived.llmUrl) || 8800;
  const gatewayPort = portOf(el.fieldBaseUrl.value.trim()) || 22122;
  const managementPort = portOf(el.fieldManagementUrl.value.trim()) || 8700;
  el.bootstrapStatus.textContent = '生成中…';
  el.bootstrapDialog.hidden = false;
  try {
    const result = await api.bootstrapScript({ host: derived.host, llmPort, gatewayPort, managementPort });
    lastBootstrapScript = result.script;
    lastBootstrapHost = derived.host;
    el.bootstrapScript.textContent = result.script;
    el.bootstrapStatus.textContent = '脚本就绪。建议 SSH 到 Hermes 主机粘贴执行。';
  } catch (error) {
    el.bootstrapScript.textContent = '';
    el.bootstrapStatus.textContent = `生成失败：${error.message}`;
  }
});

function portOf(url) {
  const m = String(url || '').match(/:(\d{1,5})(?:\/|$)/);
  return m ? Number(m[1]) : 0;
}

el.bootstrapCopy.addEventListener('click', async () => {
  if (!lastBootstrapScript) return;
  try {
    await navigator.clipboard.writeText(lastBootstrapScript);
    el.bootstrapStatus.textContent = '已复制到剪贴板。';
  } catch (error) {
    el.bootstrapStatus.textContent = `复制失败：${error.message}`;
  }
});

el.bootstrapExport.addEventListener('click', async () => {
  if (!lastBootstrapScript) return;
  try {
    const result = await api.exportBootstrap({ script: lastBootstrapScript, host: lastBootstrapHost });
    el.bootstrapStatus.textContent = `已导出到：${result.path}`;
  } catch (error) {
    el.bootstrapStatus.textContent = `导出失败：${error.message}`;
  }
});

el.bootstrapClose.addEventListener('click', () => {
  el.bootstrapDialog.hidden = true;
});

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
  await api.disconnect().catch(() => {});
  state.activeRequestId = null;
  el.chatLog.textContent = '';
  hideBanner();
  setConnectStatus('本机凭据已清除，可重新配置。');
  applyStatus({ configured: false });
  showView('connect');
});

// ============================================================ 设置面板

el.btnSettings.addEventListener('click', () => {
  if (state.currentView === 'settings') showView('chat');
  else openSettings();
});
el.btnSettingsClose.addEventListener('click', () => showView('chat'));

el.settingsTabs.addEventListener('click', (event) => {
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
  el.settingsTabs.querySelectorAll('[data-tab]').forEach((node) => {
    node.dataset.active = node.dataset.tab === state.settingsTab ? 'true' : 'false';
  });
  el.settingsBody.textContent = '加载中…';
  try {
    if (state.settingsTab === 'persona') await renderPersonaTab();
    else if (state.settingsTab === 'memory') await renderMemoryTab();
    else if (state.settingsTab === 'skills') await renderSkillsTab();
    else if (state.settingsTab === 'toolchain') await renderToolchainTab();
    else if (state.settingsTab === 'workspace') await renderWorkspaceTab();
  } catch (error) {
    el.settingsBody.textContent = `加载失败：${error.message}`;
  }
}

async function renderPersonaTab() {
  const result = await api.persona();
  const text = (result && result.persona) || '';
  el.settingsBody.innerHTML = `
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
  el.settingsBody.innerHTML = `
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
  el.settingsBody.innerHTML = `
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
  el.settingsBody.innerHTML = `
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
  el.settingsBody.innerHTML = `
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
  el.settingsBody.querySelectorAll('.v')[0].textContent = ws.root || '未设置';
  el.settingsBody.querySelectorAll('.v')[1].textContent = ws.exists ? '是' : '否（首次使用会创建）';
  el.settingsBody.querySelectorAll('.v')[2].textContent = ws.hasAgents ? ws.agentsFile : '未生成';
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
  if (!state.bannerActionUrl) return;
  await api.openExternal(state.bannerActionUrl).catch((error) => showBanner(error.message || '无法打开链接', 'error'));
});
el.bannerDismiss.addEventListener('click', hideBanner);

el.btnUpdate.addEventListener('click', async () => {
  showBanner('正在检查更新…');
  const result = await api.update().catch(() => ({ ok: false, reason: 'error' }));
  if (!result.ok) { showBanner(`无法检查更新（${result.reason || '未知原因'}），可稍后重试或用镜像地址手动下载`, 'warn'); return; }
  if (!result.updateAvailable) { showBanner(`已是最新版本（${result.current}）`); return; }
  const url = result.mirrorUrl || result.downloadUrl || result.releasePage;
  showBanner(`发现新版本 ${result.latest}（当前 ${result.current}）`, 'info', url ? { label: '打开下载页', url } : null);
});

el.modelSelect.addEventListener('change', () => {
  // 模型切换后下一次 send 会带入；不立即生效是符合预期的。
});

// ============================================================ 启动

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
    showView('connect');
    setConnectStatus('填写 Hermes 主机地址与 API Key 完成首次配置。');
    return;
  }

  // 已配置：回填字段
  if (status.llmUrl) el.fieldHost.value = hostFromConnection(status);
  if (status.baseUrl) el.fieldBaseUrl.value = status.baseUrl;
  if (status.managementUrl) el.fieldManagementUrl.value = status.managementUrl;
  if (status.profile) el.fieldProfile.value = status.profile;
  if (status.model) el.fieldModel.value = status.model;
  if (status.workspace) el.fieldWorkspace.value = status.workspace;
  const permRadio = el.connectForm.querySelector(`input[name="permission"][value="${status.permission || 'read-write'}"]`);
  if (permRadio) permRadio.checked = true;

  setStatusDot('busy');
  const resumed = await api.resume().catch((error) => ({ ok: false, message: error.message }));
  if (resumed.ok) {
    status = await api.status().catch(() => status);
    await enterChat(status);
  } else {
    showView('connect');
    setConnectStatus(`已有 Hermes 配置，但会话没能恢复：${resumed.message || '未知原因'}`, 'error');
    setStatusDot('error');
  }
})();