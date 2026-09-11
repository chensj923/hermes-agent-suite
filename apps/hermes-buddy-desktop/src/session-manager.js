'use strict';

const path = require('path');
const fs = require('fs');
const { describeGatewayError } = require('@hermes/connection');
const { publicView } = require('./connection-store');
const { Workspace } = require('./workspace');
const { ToolRegistry } = require('./tools');
const { Brain, describeBrainError } = require('./agent/brain');
const { AgentLoop } = require('./agent/loop');
const { buildSystemPrompt, DEFAULT_PERSONA } = require('./agent/prompts');
const { MemoryStore, rememberLine } = require('./memory');
const { SkillStore } = require('./skills');
const { detectTooling, renderToolchainForPrompt } = require('./toolchain');

const MAX_HISTORY_MESSAGES = 30;
const PERSONA_FILE = 'persona.md';

/**
 * 主进程编排器。
 *
 * 职责边界：API Key 只在本对象内出现；渲染进程拿到的永远是 publicView。
 * 大脑在 Hermes 上，手在本机——所有工具调用都落在 Windows 工作区里。
 */
class SessionManager {
  constructor({
    store,
    provisioning = null,
    logger,
    registry = null,
    product = 'buddy',
    deployment = 'windows',
    appDir,
    builtinSkillsDir = null,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (!store) throw new Error('缺少 ConnectionStore');
    if (!appDir) throw new Error('缺少应用数据目录');
    this.store = store;
    this.provisioning = provisioning;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.registry = registry;
    this.product = product;
    this.deployment = deployment;
    this.appDir = appDir;
    this.builtinSkillsDir = builtinSkillsDir;
    this.fetchImpl = fetchImpl;

    this.connection = null;   // 含密钥，禁止外传
    this.gateway = null;
    this.brain = null;
    this.session = null;
    this.messages = [];       // OpenAI 格式历史（不含 system）
    this.controllers = new Map();
    this.lastGatewayError = null; // { code, message, at }，仅用于 UI 诊断，不含密钥

    this.workspace = null;
    this.tools = null;
    this.memory = null;
    this.skills = null;
    this.loop = null;
  }

  // ---------------------------------------------------------------- 状态

  status() {
    if (!this.connection) this.connection = this.store.load();
    const view = publicView(this.connection);
    return {
      ...view,
      configured: Boolean(this.connection),
      ready: Boolean(this.brain && this.workspace),
      connected: Boolean(this.session),
      workspaceReady: Boolean(this.workspace && this.workspace.exists()),
      workspaceExists: this.workspace ? this.workspace.exists() : null,
      encryptionAvailable: this.store.isEncryptionAvailable(),
      busy: this.controllers.size > 0,
      permission: this.tools ? this.tools.permission : (this.connection && this.connection.permission) || 'read-write',
      gatewayError: this.lastGatewayError ? {
        code: this.lastGatewayError.code || this.lastGatewayError.status,
        message: describeGatewayError(this.lastGatewayError)
      } : null
    };
  }

  // ---------------------------------------------------------------- 初始化

  /** 按当前连接装配本地运行时；工作目录切换后需要重建。 */
  ensureRuntime(connection) {
    const workspaceDir = (connection && connection.workspace) || '';
    if (!this.workspace || this.workspace.dir !== path.resolve(workspaceDir)) {
      this.workspace = new Workspace({ root: workspaceDir, logger: this.logger });
      this.workspace.ensure();
      this.memory = new MemoryStore({ workspace: this.workspace, appDir: this.appDir, logger: this.logger });
      this.memory.ensure();
      this.skills = new SkillStore({ builtinDir: this.builtinSkillsDir, workspace: this.workspace, logger: this.logger });
      this.tools = new ToolRegistry({
        workspace: this.workspace,
        logger: this.logger,
        permission: (connection && connection.permission) || 'read-write'
      });
      this.logger.info('workspace-ready', { workspace: this.workspace.dir });
    }
    if (!this.brain && connection) {
      this.brain = new Brain({
        endpoint: connection.llmUrl,
        model: connection.model,
        apiKey: connection.apiKey,
        fetchImpl: this.fetchImpl
      });
      this.loop = new AgentLoop({ brain: this.brain, tools: this.tools, workspace: this.workspace, logger: this.logger });
    }
    return { workspace: this.workspace, tools: this.tools, brain: this.brain };
  }

  // ---------------------------------------------------------------- 连接

  /**
   * 连接 Hermes。LLM 推理端点必须通；Gateway 只用于会话与部署登记，
   * 不通也不影响本机干活，降级继续。
   */
  async connect(input) {
    const normalized = this.store.normalize
      ? this.store.normalize(input)
      : require('./connection-store').normalizeConnectionInput(input);

    // 先建本地运行时：工作目录不存在就现在建好，后面所有操作才有落点。
    this.ensureRuntime(normalized);

    const brain = new Brain({
      endpoint: normalized.llmUrl,
      model: normalized.model,
      apiKey: normalized.apiKey,
      fetchImpl: this.fetchImpl
    });

    let models = [];
    try {
      // 用严格探测：拿不到模型清单就说明这台 Hermes 用不了，别让用户白填。
      models = await brain.assertReachable();
    } catch (error) {
      this.logger.warn('llm-unreachable', { endpoint: normalized.llmUrl, error: error.message });
      throw new Error(`Hermes 推理服务不可用（${normalized.llmUrl}）：${describeBrainError(error)}`);
    }

    let health = null;
    let session = null;
    let deployment = null;
    let gatewayWarning = null;
    if (this.provisioning && normalized.baseUrl) {
      try {
        const gateway = this.provisioning.createGateway({ baseUrl: normalized.baseUrl, apiKey: normalized.apiKey });
        health = await gateway.health();
        session = await gateway.createSession(normalized.profile);
        if (normalized.managementUrl) {
          const managementGateway = this.provisioning.createGateway({ baseUrl: normalized.managementUrl, apiKey: normalized.apiKey });
          deployment = await this.provisioning.provision({
            gateway: managementGateway,
            product: this.product,
            deployment: this.deployment,
            registry: this.registry
          });
        }
      } catch (error) {
        // Gateway 不通只降级：本机工具链路不依赖它。
        gatewayWarning = describeGatewayError(error);
        this.lastGatewayError = error;
        this.logger.warn('gateway-unreachable', { baseUrl: normalized.baseUrl, error: error.message });
      }
    } else if (!normalized.baseUrl) {
      gatewayWarning = '未配置 Gateway，跳过会话登记与部署清单。';
      this.logger.info('gateway-skipped', { reason: 'no_base_url' });
    }

    const saved = this.store.save(normalized);
    this.connection = saved;
    this.brain = brain;
    this.gateway = health ? this.provisioning.createGateway({ baseUrl: normalized.baseUrl, apiKey: normalized.apiKey }) : null;
    this.session = session;
    this.messages = [];
    this.loop = new AgentLoop({ brain, tools: this.tools, workspace: this.workspace, logger: this.logger });
    this.logger.info('connected', {
      baseUrl: normalized.baseUrl,
      llmUrl: normalized.llmUrl,
      workspace: normalized.workspace,
      gateway: health ? 'ok' : 'degraded'
    });
    return {
      connection: publicView(saved),
      session,
      deployment,
      health,
      models,
      workspace: this.describeWorkspace(),
      gatewayWarning
    };
  }

  /** 用已保存凭据恢复。找不到配置或推理端点不通都算失败。 */
  async resume() {
    const stored = this.connection || this.store.load();
    if (!stored) return { ok: false, reason: 'not_configured', message: '还没有配置 Hermes 连接' };
    try {
      this.ensureRuntime(stored);
      const brain = new Brain({
        endpoint: stored.llmUrl,
        model: stored.model,
        apiKey: stored.apiKey,
        fetchImpl: this.fetchImpl
      });
      await brain.assertReachable();

      // 恢复时也尝试连 Gateway（和 connect 一样降级），这样重启后会话登记与部署清单能恢复，
      // 不再每次重启都掉 Gateway。Key 不对或服务端没对外暴露就降级，不阻塞 LLM 链路。
      let session = null;
      let gateway = null;
      if (this.provisioning && stored.baseUrl) {
        try {
          const gw = this.provisioning.createGateway({ baseUrl: stored.baseUrl, apiKey: stored.apiKey });
          await gw.health();
          session = await gw.createSession(stored.profile);
          gateway = gw;
        } catch (error) {
          this.lastGatewayError = error;
          this.logger.warn('resume-gateway-degraded', { baseUrl: stored.baseUrl, error: error.message });
        }
      }

      this.connection = stored;
      this.brain = brain;
      this.gateway = gateway;
      this.session = session;
      this.loop = new AgentLoop({ brain, tools: this.tools, workspace: this.workspace, logger: this.logger });
      this.logger.info('resumed', { llmUrl: stored.llmUrl, gateway: session ? 'ok' : 'degraded' });
      let gatewayWarning = null;
      if (!session && stored.baseUrl) {
        // resume 时只记录 warn，不返回 gatewayWarning——因为用户看不到。
        // 这里从 this.lastGatewayError 取（如果有的话），否则给一个通用提示。
        gatewayWarning = this.lastGatewayError
          ? describeGatewayError(this.lastGatewayError)
          : 'Gateway 未连通（重启时鉴权失败或不可达），聊天和本机工具不受影响。';
      }
      return { ok: true, connection: publicView(stored), workspace: this.describeWorkspace(), gatewayWarning };
    } catch (error) {
      this.logger.warn('resume-failed', { error: error.message, code: error.code });
      return { ok: false, reason: error.code || 'error', message: describeBrainError(error) };
    }
  }

  async ensureReady() {
    if (this.brain && this.workspace) return;
    const result = await this.resume();
    if (!result.ok) {
      const error = new Error(result.message || '尚未配置 Hermes 连接');
      error.code = result.reason;
      throw error;
    }
  }

  // ---------------------------------------------------------------- 对话

  async send({ requestId, text, onConfirm }, onEvent) {
    await this.ensureReady();
    const id = String(requestId || `req-${Date.now()}`);
    if (this.controllers.has(id)) throw new Error('该请求已在进行中');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const emit = (event) => { if (typeof onEvent === 'function') onEvent({ requestId: id, ...event }); };

    try {
      const systemPrompt = this.buildPrompt();
      const history = this.messages.slice(-MAX_HISTORY_MESSAGES);
      const result = await this.loop.run({
        systemPrompt,
        history,
        userMessage: text,
        signal: controller.signal,
        onEvent: emit,
        onConfirm
      });

      this.messages.push({ role: 'user', content: String(text || '') });
      if (result.text) this.messages.push({ role: 'assistant', content: result.text });
      this.trimHistory();
      this.remember({ role: 'user', text: String(text || ''), at: Date.now() });
      this.maybeJournal(result);
      return { requestId: id, text: result.text, turns: result.turns, toolCalls: result.toolCalls.length, stopped: result.stopped };
    } catch (error) {
      const message = describeBrainError(error);
      this.logger.warn('chat-failed', { requestId: id, code: error.code, error: error.message });
      emit({ kind: 'error', type: 'error', message, text: message });
      const wrapped = new Error(message);
      wrapped.code = error.code;
      throw wrapped;
    } finally {
      this.controllers.delete(id);
    }
  }

  /** 自动记一笔流水，方便用户事后看"今天让它干了啥"。 */
  maybeJournal(result) {
    try {
      if (!result || !result.toolCalls || !result.toolCalls.length) return;
      const summary = result.toolCalls
        .slice(0, 6)
        .map((call) => `${call.name}(${summarizeArgs(call.args)})`)
        .join(' → ');
      this.memory.appendDaily(`执行了 ${result.toolCalls.length} 个操作：${summary}`);
    } catch (error) {
      this.logger.warn('journal-failed', { error: error.message });
    }
  }

  abort(requestId) {
    if (requestId) {
      const controller = this.controllers.get(String(requestId));
      if (!controller) return false;
      controller.abort();
      return true;
    }
    if (!this.controllers.size) return false;
    for (const controller of this.controllers.values()) controller.abort();
    return true;
  }

  clearHistory() {
    this.messages = [];
    return { cleared: true };
  }

  trimHistory() {
    if (this.messages.length > MAX_HISTORY_MESSAGES * 2) {
      this.messages = this.messages.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  remember(entry) {
    if (!this.transcript) this.transcript = [];
    this.transcript.push(entry);
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
  }

  history() { return (this.transcript || []).slice(); }

  /** 系统提示词：身份 + 环境 + 约定 + 记忆 + 技能 + 工具链现状。 */
  buildPrompt() {
    const tree = this.workspace ? this.workspace.describe({ maxEntries: 50, maxDepth: 2 }) : null;
    return buildSystemPrompt({
      persona: this.getPersona(),
      workspace: this.workspace,
      permission: this.tools ? this.tools.permission : 'read-write',
      memory: this.memory ? this.memory.render() : '',
      skills: this.skills ? this.skills.render() : '',
      agentsDoc: this.workspace ? this.workspace.readAgents() : '',
      workspaceTree: tree && tree.tree ? tree.tree : '',
      modelName: this.connection ? this.connection.model : ''
    }) + `\n\n【本机工具链】\n${renderToolchainForPrompt()}`;
  }

  // ---------------------------------------------------------------- 工作区

  setWorkspace(dir) {
    const target = String(dir || '').trim();
    if (!target) throw new Error('工作目录不能为空');
    if (!path.isAbsolute(target)) throw new Error('工作目录必须是绝对路径');
    const next = new Workspace({ root: target, logger: this.logger });
    next.ensure();
    this.workspace = next;
    this.memory = new MemoryStore({ workspace: next, appDir: this.appDir, logger: this.logger });
    this.memory.ensure();
    this.skills = new SkillStore({ builtinDir: this.builtinSkillsDir, workspace: next, logger: this.logger });
    this.tools = new ToolRegistry({
      workspace: next,
      logger: this.logger,
      permission: (this.connection && this.connection.permission) || 'read-write'
    });
    if (this.brain) this.loop = new AgentLoop({ brain: this.brain, tools: this.tools, workspace: next, logger: this.logger });
    if (this.connection) {
      const updated = { ...this.connection, workspace: next.dir };
      try { this.connection = this.store.save(updated); } catch (error) {
        this.logger.warn('persist-workspace-failed', { error: error.message });
        this.connection = updated;
      }
    }
    this.logger.info('workspace-changed', { workspace: next.dir });
    return this.describeWorkspace();
  }

  describeWorkspace() {
    if (!this.workspace) return { root: null, exists: false };
    const tree = this.workspace.describe({ maxEntries: 50, maxDepth: 2 });
    return {
      root: this.workspace.dir,
      exists: this.workspace.exists(),
      tree: tree.tree,
      truncated: tree.truncated,
      empty: tree.empty,
      agentsFile: this.workspace.agentsFile,
      hasAgents: Boolean(this.workspace.readAgents().trim())
    };
  }

  // ---------------------------------------------------------------- 权限

  setPermission(level) {
    if (!this.tools) throw new Error('工作区尚未就绪');
    this.tools.setPermission(level);
    if (this.connection) {
      const updated = { ...this.connection, permission: level };
      try { this.connection = this.store.save(updated); } catch (error) {
        this.logger.warn('persist-permission-failed', { error: error.message });
        this.connection = updated;
      }
    }
    this.logger.info('permission-changed', { permission: level });
    return { permission: level };
  }

  // ---------------------------------------------------------------- 角色 / 记忆 / 技能

  personaFile() {
    return this.workspace ? path.join(this.workspace.hermesDir, PERSONA_FILE) : null;
  }

  getPersona() {
    const file = this.personaFile();
    if (!file) return DEFAULT_PERSONA;
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return DEFAULT_PERSONA; }
  }

  savePersona(text) {
    const file = this.personaFile();
    if (!file) throw new Error('工作区尚未就绪');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(text || '').trim() + '\n', 'utf8');
    return { ok: true, persona: this.getPersona() };
  }

  getMemory(scope = 'project') {
    if (!this.memory) throw new Error('工作区尚未就绪');
    return scope === 'global' ? this.memory.globalMemory() : this.memory.projectMemory();
  }

  saveMemory(text, scope = 'project') {
    if (!this.memory) throw new Error('工作区尚未就绪');
    if (scope === 'global') this.memory.saveGlobalMemory(String(text || ''));
    else this.memory.saveProjectMemory(String(text || ''));
    return { ok: true, scope };
  }

  rememberLine(line, scope = 'project') {
    if (!this.memory) throw new Error('工作区尚未就绪');
    return rememberLine(this.memory, line, scope);
  }

  listSkills() { return this.skills ? this.skills.list().map(stripContent) : []; }
  readSkill(name) { return this.skills ? this.skills.read(name) : null; }
  saveSkill(name, content, description) {
    if (!this.skills) throw new Error('工作区尚未就绪');
    return stripContent(this.skills.save(name, content, description));
  }
  removeSkill(name) {
    if (!this.skills) throw new Error('工作区尚未就绪');
    return { removed: this.skills.remove(name) };
  }

  // ---------------------------------------------------------------- 其它

  async models() {
    try {
      await this.ensureReady();
      return await this.brain.listModels();
    } catch (_) {
      return this.connection && this.connection.model ? [this.connection.model] : ['hermes-agent'];
    }
  }

  toolchain() { return detectTooling(); }

  async provisioningStatus() {
    const stored = this.connection || this.store.load();
    if (!stored || !this.provisioning) return { configured: false, reason: 'not_configured' };
    if (!stored.managementUrl) return { configured: false, reason: 'no_management_url' };
    const gateway = this.provisioning.createGateway({ baseUrl: stored.managementUrl, apiKey: stored.apiKey });
    return this.provisioning.fetchProvisioningStatus(gateway);
  }

  disconnect() {
    this.abort();
    const cleared = this.store.clear();
    this.connection = null;
    this.brain = null;
    this.gateway = null;
    this.session = null;
    this.messages = [];
    this.logger.info('disconnected', { cleared });
    return { cleared };
  }
}

function stripContent(skill) {
  if (!skill) return skill;
  const { content, ...rest } = skill;
  return { ...rest, hasContent: Boolean(content) };
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const value = args.command || args.path || args.pattern || '';
  return String(value).slice(0, 40);
}

module.exports = { SessionManager, MAX_HISTORY_MESSAGES, PERSONA_FILE, summarizeArgs };
