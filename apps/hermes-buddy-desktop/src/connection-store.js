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
 *   llmUrl 留空 → 由 baseUrl 同主机 + 端口 8800 推导
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

  // Gateway 可选：先尝试用用户填的，失败/留空就用 llmUrl 推导。
  let baseUrl = '';
  const rawBase = String(source.baseUrl || '').trim();
  if (rawBase) {
    try { baseUrl = normalizeGatewayUrl(rawBase); } catch (error) {
      throw new Error(`Gateway 地址无效：${error.message}`);
    }
  }
  // llmUrl 必填（核心决策端点）。这里先解析出来，下面用它推导缺失的 baseUrl。
  const llmUrl = deriveLlmEndpoint(baseUrl, source.llmUrl);
  if (!baseUrl) {
    try { baseUrl = deriveGatewayFromLlm(llmUrl); } catch (_) { baseUrl = ''; }
  }
  // managementUrl 留空就由 baseUrl 推导；baseUrl 也没有就空串，主流程会跳过 Gateway。
  const rawManagement = String(source.managementUrl || '').trim();
  let managementUrl = '';
  if (rawManagement) managementUrl = normalizeGatewayUrl(rawManagement);
  else if (baseUrl) managementUrl = deriveManagementUrl(baseUrl);

  return { schemaVersion: SCHEMA_VERSION, baseUrl, managementUrl, llmUrl, apiKey, profile, model, workspace, permission };
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
    baseUrl: connection.baseUrl,
    managementUrl: connection.managementUrl,
    llmUrl: connection.llmUrl,
    profile: connection.profile || DEFAULT_PROFILE,
    model: connection.model || DEFAULT_MODEL,
    workdir: connection.workdir || '',
    workspace: connection.workspace || defaultRoot(),
    permission: connection.permission || 'read-write',
    savedAt: connection.savedAt || null
  };
}

/** 老版本（v1，无 schemaVersion）配置的就地升级，避免用户重新填一遍。 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.apiKey) return null;
  if (raw.schemaVersion === SCHEMA_VERSION) return raw;
  // v1/v2 都没有本地工作区与推理端点，补默认值即可，不必让用户重填。
  let llmUrl = raw.llmUrl || '';
  let baseUrl = raw.baseUrl || '';
  if (!llmUrl) {
    try { llmUrl = deriveLlmEndpoint(baseUrl); } catch (_) { llmUrl = ''; }
  }
  if (!baseUrl && llmUrl) {
    try { baseUrl = deriveGatewayFromLlm(llmUrl); } catch (_) { baseUrl = ''; }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    baseUrl,
    managementUrl: raw.managementUrl || (baseUrl ? deriveManagementUrl(baseUrl) : ''),
    llmUrl,
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

  load() {
    if (!this.exists()) return null;
    let decrypted;
    try {
      decrypted = this.safeStorage.decryptString(this.fs.readFileSync(this.filePath));
    } catch (error) {
      // 换机器、换 Windows 账户或文件损坏时 DPAPI 解不开：留证据并要求重新配置。
      this.quarantine('decrypt-failed', error);
      return null;
    }
    let parsed = null;
    try { parsed = JSON.parse(decrypted); } catch (error) { this.quarantine('parse-failed', error); return null; }
    const migrated = migrate(parsed);
    if (!migrated) { this.quarantine('incomplete', new Error('配置缺少必要字段')); return null; }
    if (migrated !== parsed && this.isEncryptionAvailable()) {
      try { this.save(migrated); } catch (_) { /* 升级写回失败不影响本次使用 */ }
    }
    return migrated;
  }

  save(connection) {
    if (!this.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，无法保存 API Key');
    const payload = { ...connection, savedAt: new Date().toISOString() };
    const encrypted = this.safeStorage.encryptString(JSON.stringify(payload));
    const tmp = `${this.filePath}.tmp`;
    // 先写临时文件再 rename：崩溃时不会留下半个配置文件。
    this.fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    this.fs.renameSync(tmp, this.filePath);
    return payload;
  }

  clear(keepConfig = false) {
    try { this.fs.rmSync(this.filePath, { force: true }); } catch (error) {
      if (this.logger) this.logger.warn('clear-connection-failed', { error: error.message });
    }
    if (keepConfig) return true;
    // 彻底清理所有残留缓存文件
    const dirs = ['gateway-cache', 'logs', 'memory', 'persona', 'skills'];
    dirs.forEach((subDir) => {
      const dirPath = path.join(path.dirname(this.filePath), subDir);
      try { this.fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    });
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
  FILE_NAME,
  SCHEMA_VERSION,
  DEFAULT_PROFILE,
  DEFAULT_MODEL,
  PERMISSIONS
};
