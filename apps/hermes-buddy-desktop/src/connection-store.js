'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeGatewayUrl } = require('@hermes/connection');
const { deriveManagementUrl } = require('@hermes/provisioning');
const { defaultRoot } = require('./workspace');
const { deriveLlmEndpoint } = require('./agent/brain');

const FILE_NAME = 'buddy.connection';
const DEFAULT_PROFILE = 'buddy';
const DEFAULT_MODEL = 'hermes-agent';
const SCHEMA_VERSION = 3;
const PERMISSIONS = ['read', 'read-write', 'full'];

/**
 * 校验并规范化用户在连接页填的内容。纯函数，方便单测覆盖各种脏输入。
 *
 * 必填：llmUrl（或能由 Gateway 推导）、apiKey、workspace。
 * Gateway baseUrl 是可选的——本机工具链路不依赖它，留空也能干活；
 * Hermes 服务端默认端口是 22122。推导关系：
 *   baseUrl 留空 → 由 llmUrl 同主机 + 端口 22122 推导
 *   llmUrl 留空 → 由 baseUrl 同主机 + 端口 22122 推导（LLM 与 Gateway 同端口）
 *   managementUrl 留空 → 由 baseUrl 同主机 + 端口 8700 推导
 */
function normalizeConnectionInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  // 粘贴时首尾常带空白，先剪掉；剪完仍有空白说明复制串行了。
  const apiKey = String(source.apiKey || '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  if (/\s/.test(apiKey)) throw new Error('API Key 不能包含空格或换行，请重新复制 ~/.hermes/data/.env 里的 API_SERVER_KEY');
  const profile = String(source.profile || DEFAULT_PROFILE).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(profile)) throw new Error('Profile 名非法（小写字母/数字/-/_）');
  const model = String(source.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const workdir = String(source.workdir || '').trim();
  const workspace = String(source.workspace || workdir || '').trim() || defaultRoot();
  if (!path.isAbsolute(workspace)) throw new Error('工作目录必须是绝对路径');
  const permission = PERMISSIONS.includes(source.permission) ? source.permission : 'read-write';

  // 两种模式：
  //  · local  —— 本地跑 ReAct 循环，需要直连一个原生支持 function calling 的 LLM 端点（llmUrl）。
  //  · channel —— 决策在 Hermes 主机上的外挂通道（hermes-buddy-channel），本地只执行工具。
  //               不需要 llmUrl；channelUrl 默认同主机 :8822 的 WS 通道。
  const mode = source.mode === 'channel' ? 'channel' : source.mode === 'dashboard' ? 'dashboard' : 'local';

  // Gateway 可选：先尝试用用户填的，失败/留空就用 llmUrl 推导。
  let baseUrl = '';
  const rawBase = String(source.baseUrl || '').trim();
  if (rawBase) {
    try { baseUrl = normalizeGatewayUrl(rawBase); } catch (error) {
      throw new Error(`Gateway 地址无效：${error.message}`);
    }
  }

  let llmUrl = '';
  let channelUrl = '';
  const channelPath = String(source.channelPath || '/api/buddy/channel').trim() || '/api/buddy/channel';
  let dashboardUrl = '';
  if (mode === 'dashboard') {
    if (!rawBase) throw new Error('Dashboard 模式需要填写 Hermes 主机地址');
    dashboardUrl = deriveDashboardUrl(rawBase, source.dashboardUrl);
  } else if (mode === 'channel') {
    if (!rawBase) throw new Error('通道模式需要填写 Hermes 主机地址（Gateway 地址）');
    channelUrl = deriveChannelUrl(rawBase, source.channelUrl, channelPath);
  } else {
    // llmUrl 必填（核心决策端点）。这里先解析出来，下面用它推导缺失的 baseUrl。
    llmUrl = deriveLlmEndpoint(baseUrl, source.llmUrl);
    if (!baseUrl) {
      try { baseUrl = deriveGatewayFromLlm(llmUrl); } catch (_) { baseUrl = ''; }
    }
  }
  // managementUrl 是可选能力：当前 Hermes 服务端 8700 跑的是 WorkBuddy 前端代理，
  // 并没有 /api/provisioning/* 端点。因此不再默认推导；只有用户显式填写时才保留。
  const rawManagement = String(source.managementUrl || '').trim();
  let managementUrl = '';
  if (rawManagement) {
    managementUrl = fixManagementPort(normalizeGatewayUrl(rawManagement), baseUrl);
  }

  return { schemaVersion: SCHEMA_VERSION, mode, baseUrl, managementUrl, llmUrl, channelUrl, channelPath, dashboardUrl, apiKey, profile, model, workspace, permission };
}

/**
 * 通道模式：WS 端点默认同主机 :8822，scheme 跟随 Gateway（https→wss）。
 * 借用 Hermes Desktop 的"路径前缀"能力：channelPath 支持反代后带前缀（默认 /api/buddy/channel）。
 * 显式填了完整通道地址则直接使用，不再套前缀。
 */
function deriveChannelUrl(rawBase, explicit, channelPath) {
  const raw = String(explicit || '').trim();
  if (raw) {
    if (!/^wss?:\/\//i.test(raw)) throw new Error('通道地址必须是 ws:// 或 wss:// 开头');
    return raw;
  }
  const path = String(channelPath || '/api/buddy/channel').trim() || '/api/buddy/channel';
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(/^https?:\/\//i.test(rawBase) ? rawBase : `http://${rawBase}`);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = '8822';
  url.pathname = safePath;
  url.search = '';
  url.hash = '';
  return `${scheme}//${url.host}${safePath}`;
}

/**
 * Dashboard 模式：HTTP 端点默认同主机 :9119，scheme 跟随 Gateway（https->wss/https）。
 * 与官方 Hermes Desktop 连 Dashboard 后端的方式一致：HTTP REST，不走 WS。
 */
function deriveDashboardUrl(rawBase, explicit) {
  const raw = String(explicit || '').trim();
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) throw new Error('Dashboard 地址必须是 http:// 或 https:// 开头');
    return raw.replace(/\/$/, '');
  }
  const url = new URL(/^https?:\/\//i.test(rawBase) ? rawBase : `http://${rawBase}`);
  url.port = '9119';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** 从连接里取一个稳定的主机标识，用作多连接 profile 的 id 组成部分。 */
function hostKeyOf(connection) {
  const candidates = [connection.baseUrl, connection.channelUrl, connection.llmUrl].filter(Boolean);
  for (const c of candidates) {
    try {
      const u = new URL(/^wss?:\/\//i.test(c) ? c : (String(c).includes('://') ? c : `http://${c}`));
      if (u.host) return u.host;
    } catch (_) { /* 下一个 */ }
  }
  const fallback = String(connection.baseUrl || connection.channelUrl || connection.llmUrl || '');
  return fallback.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'host';
}

/** 当用户没填 Gateway 时，按 LLM 端点同主机 + Hermes 默认 22122 推导。 */
function deriveGatewayFromLlm(llmUrl) {
  const url = new URL(/^https?:\/\//i.test(llmUrl) ? llmUrl : `http://${llmUrl}`);
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  url.port = '22122';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** 渲染进程能看到的视图：只有连接元信息，永远不含 API Key 或其片段。 */
function publicView(connection) {
  if (!connection) return { configured: false };
  return {
    configured: true,
    mode: connection.mode || 'local',
    baseUrl: connection.baseUrl,
    managementUrl: connection.managementUrl,
    llmUrl: connection.llmUrl,
    channelUrl: connection.channelUrl || '',
    profile: connection.profile || DEFAULT_PROFILE,
    model: connection.model || DEFAULT_MODEL,
    workdir: connection.workdir || '',
    workspace: connection.workspace || defaultRoot(),
    channelPath: connection.channelPath || '/api/buddy/channel',
    dashboardUrl: connection.dashboardUrl || '',
    permission: connection.permission || 'read-write',
    savedAt: connection.savedAt || null
  };
}

/** 已知会冒充 Hermes Gateway 的非 Gateway 端口（含 8811 推理直通代理、8645 hermes proxy）。 */
const NON_GATEWAY_PORTS = new Set(['22121', '22123', '22124', '22125', '8811', '8645']);

/** 用户容易把推理端点（8811 直通代理 / 8800）或 Gateway（22122）端口填进部署管理地址里，纠正为 8700。 */
const MANAGEMENT_PORT = '8700';
const NON_MANAGEMENT_PORTS = new Set(['8811', '8800', '8645', '22122', '22121', '22123', '22124', '22125']);

/** 把用户错填的 openclaw / 旧 Gateway 端口纠正为 22122。 */
function fixGatewayPort(urlString, defaultPort = '22122') {
  if (!urlString) return urlString;
  try {
    const url = new URL(/^https?:\/\//i.test(urlString) ? urlString : `http://${urlString}`);
    if (NON_GATEWAY_PORTS.has(url.port)) {
      url.port = defaultPort;
      return url.toString().replace(/\/$/, '');
    }
  } catch (_) {}
  return urlString;
}

/** 把用户错填的 LLM / Gateway / openclaw 端口纠正为管理端口 8700。 */
function fixManagementPort(urlString, baseUrl) {
  if (!urlString) return urlString;
  try {
    const url = new URL(/^https?:\/\//i.test(urlString) ? urlString : `http://${urlString}`);
    if (NON_MANAGEMENT_PORTS.has(url.port)) {
      url.port = MANAGEMENT_PORT;
      // 管理地址只接受根路径；若用户把 LLM 端点（如 /v1/chat/completions）错贴进来，清掉路径。
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch (_) {
    // 解析失败时，如果有 baseUrl，按 baseUrl 重新推导。
  }
  if (!urlString && baseUrl) {
    try { return deriveManagementUrl(baseUrl); } catch (_) {}
  }
  return urlString;
}

/** 配置迁移/清洗：补全缺失字段，并把错填的 Gateway 端口纠正为 22122。 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.apiKey) return null;
  // 旧配置没有 mode/channelUrl：默认 local，通道模式需用户重新在向导里选。
  const mode = raw.mode === 'channel' ? 'channel' : 'local';
  // 不管 schemaVersion 是多少，都做一次端口纠错：用户可能在当前版本里把 openclaw
  //（22121/22123）、旧 Gateway（22124）或管理端口（8700）错存成 Gateway。
  let baseUrl = raw.baseUrl || '';
  baseUrl = fixGatewayPort(baseUrl);
  // 通道模式不依赖本地 LLM 端点，不要从 baseUrl 反推 llmUrl（否则会污染通道配置）。
  let llmUrl = raw.llmUrl || '';
  if (mode !== 'channel' && !llmUrl) {
    try { llmUrl = deriveLlmEndpoint(baseUrl); } catch (_) { llmUrl = ''; }
  }
  if (!baseUrl && llmUrl) {
    try { baseUrl = deriveGatewayFromLlm(llmUrl); } catch (_) { baseUrl = ''; }
  }
  // 旧版本可能把 LLM(8800)/Gateway(22122) 端口错存成 Management 地址；
  // 服务端当前没有 Management 服务，历史残留一律清空，需要时用户在向导里重新填。
  const managementUrl = '';
  const channelPath = String(raw.channelPath || '/api/buddy/channel').trim() || '/api/buddy/channel';
  const channelUrl = raw.channelUrl || (mode === 'channel' ? deriveChannelUrl(baseUrl, '', channelPath) : '');
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    baseUrl,
    managementUrl,
    llmUrl,
    channelUrl,
    channelPath,
    apiKey: raw.apiKey,
    profile: raw.profile || DEFAULT_PROFILE,
    model: raw.model || DEFAULT_MODEL,
    workdir: raw.workdir || '',
    workspace: raw.workspace || raw.workdir || defaultRoot(),
    permission: PERMISSIONS.includes(raw.permission) ? raw.permission : 'read-write',
    savedAt: raw.savedAt || null,
    migratedFrom: raw.schemaVersion || 1
  };
}

/**
 * 用 Windows DPAPI（Electron safeStorage）加密保存连接信息。
 * 明文降级是不允许的：加密不可用时直接拒绝保存，宁可让用户每次手填。
 */
class ConnectionStore {
  constructor({ dir, safeStorage, fsImpl = fs, logger = null }) {
    if (!dir) throw new Error('缺少配置目录');
    if (!safeStorage) throw new Error('缺少 safeStorage');
    this.filePath = path.join(dir, FILE_NAME);
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.logger = logger;
  }

  isEncryptionAvailable() {
    try { return Boolean(this.safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
  }

  exists() {
    try { return this.fs.existsSync(this.filePath); } catch (_) { return false; }
  }

  /** 读密文并解析为容器对象；解密或 JSON 失败都归档并返回 null。 */
  _readContainer() {
    if (!this.exists()) return null;
    let decrypted;
    try {
      decrypted = this.safeStorage.decryptString(this.fs.readFileSync(this.filePath));
    } catch (error) {
      this.quarantine('decrypt-failed', error);
      return null;
    }
    let parsed = null;
    try { parsed = JSON.parse(decrypted); } catch (error) { this.quarantine('parse-failed', error); return null; }
    return parsed;
  }

  _writeContainer(data) {
    if (!this.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，无法保存 API Key');
    const encrypted = this.safeStorage.encryptString(JSON.stringify(data));
    const tmp = `${this.filePath}.tmp`;
    this.fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    this.fs.renameSync(tmp, this.filePath);
  }

  /** 把任意格式（旧单条 / 新容器）统一成 { activeId, profiles }。 */
  _asContainer(raw) {
    if (raw && raw.profiles && typeof raw.profiles === 'object') {
      const activeId = (raw.activeId && raw.profiles[raw.activeId]) ? raw.activeId : Object.keys(raw.profiles)[0] || null;
      return { schemaVersion: raw.schemaVersion || SCHEMA_VERSION, activeId, profiles: raw.profiles };
    }
    const migrated = migrate(raw);
    if (!migrated) return null;
    const id = this._idFor(migrated);
    return { schemaVersion: SCHEMA_VERSION, activeId: id, profiles: { [id]: migrated } };
  }

  /** 由连接内容推导一个稳定的 profile id（主机 + profile 名，同一主机复用）。 */
  _idFor(connection) {
    const host = hostKeyOf(connection);
    const profile = (connection && connection.profile) || 'buddy';
    return `${profile}@${host}`.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 120);
  }

  /** 单连接语义：返回当前激活的 profile（含密钥），没有则返回 null。 */
  load() {
    const raw = this._readContainer();
    if (!raw) return null;
    const container = this._asContainer(raw);
    if (!container || !container.activeId || !container.profiles[container.activeId]) return null;
    const migrated = migrate(container.profiles[container.activeId]);
    if (!migrated) { this.quarantine('incomplete', new Error('配置缺少必要字段')); return null; }
    return migrated;
  }

  /** 单连接语义：upsert 到激活 profile 并写回；返回保存后的连接（含 savedAt）。 */
  save(connection) {
    if (!this.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，无法保存 API Key');
    const raw = this._readContainer();
    const container = (raw && raw.profiles) ? this._asContainer(raw) : { schemaVersion: SCHEMA_VERSION, activeId: null, profiles: {} };
    const id = this._idFor(connection);
    const payload = { ...connection, savedAt: new Date().toISOString() };
    container.profiles[id] = payload;
    container.activeId = id;
    container.schemaVersion = SCHEMA_VERSION;
    this._writeContainer(container);
    return payload;
  }

  // ---- 多连接（多网关）能力 ----

  /** 列出所有已保存连接（不含密钥），标出当前激活项。 */
  listProfiles() {
    const raw = this._readContainer();
    if (!raw) return { activeId: null, profiles: [] };
    const container = this._asContainer(raw);
    if (!container || !container.profiles) return { activeId: null, profiles: [] };
    const activeId = container.activeId && container.profiles[container.activeId]
      ? container.activeId
      : Object.keys(container.profiles)[0] || null;
    const profiles = Object.entries(container.profiles).map(([id, conn]) => ({
      id,
      ...publicView(migrate(conn) || conn),
      active: id === activeId
    }));
    return { activeId, profiles };
  }

  /** 取某个 profile 的完整连接（含密钥），用于激活后直连。 */
  getProfile(id) {
    const raw = this._readContainer();
    if (!raw || !raw.profiles || !raw.profiles[id]) return null;
    const conn = migrate(raw.profiles[id]);
    return conn || null;
  }

  setActive(id) {
    const raw = this._readContainer();
    if (!raw || !raw.profiles || !raw.profiles[id]) throw new Error('该连接不存在');
    if (raw.activeId === id) return;
    raw.activeId = id;
    this._writeContainer(raw);
  }

  removeProfile(id) {
    const raw = this._readContainer();
    if (!raw || !raw.profiles || !raw.profiles[id]) return false;
    delete raw.profiles[id];
    if (raw.activeId === id) raw.activeId = Object.keys(raw.profiles)[0] || null;
    if (Object.keys(raw.profiles).length === 0) {
      try { this.fs.rmSync(this.filePath, { force: true }); } catch (_) {}
      return true;
    }
    this._writeContainer(raw);
    return true;
  }

  clear(keepConfig = false) {
    const dirs = ['gateway-cache', 'logs', 'memory', 'persona', 'skills'];
    dirs.forEach((subDir) => {
      const dirPath = path.join(path.dirname(this.filePath), subDir);
      try { this.fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    });
    if (keepConfig) return true;
    try { this.fs.rmSync(this.filePath, { force: true }); } catch (error) {
      if (this.logger) this.logger.warn('clear-connection-failed', { error: error.message });
    }
    return true;
  }

  quarantine(reason, error) {
    if (this.logger) this.logger.warn('connection-unreadable', { reason, error: error && error.message });
    try { this.fs.renameSync(this.filePath, `${this.filePath}.${reason}`); } catch (_) {
      try { this.fs.rmSync(this.filePath, { force: true }); } catch (_) {}
    }
  }
}

module.exports = {
  ConnectionStore,
  normalizeConnectionInput,
  publicView,
  migrate,
  deriveChannelUrl,
  hostKeyOf,
  FILE_NAME,
  SCHEMA_VERSION,
  DEFAULT_PROFILE,
  DEFAULT_MODEL,
  PERMISSIONS
};
