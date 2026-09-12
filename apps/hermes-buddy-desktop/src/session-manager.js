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
const { AgentStore } = require('./agent-store');

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
    this.controllers = new Map();
    this.lastGatewayError = null; // { code, message, at }，仅用于 UI 诊断，不含密钥

    this.workspace = null;
    this.tools = null;
    this.memory = null;
    this.skills = null;
    this.loop = null;

    // 智能体：每个智能体独立的工作区/权限/模型，会话历史也按智能体隔离。
    try {
      this.agentStore = new AgentStore({ dir: appDir, logger: this.logger });
    } catch (error) {
      this.logger.warn('agent-store-init-failed', { error: error.message });
      this.agentStore = null;
    }
    this.agentMessages = new Map(); // agentId -> OpenAI 消息数组
  }

  get activeAgent() {
    return this.agentStore ? this.agentStore.active() : null;
  }

  /** 智能体配置的工作目录优先；留空则用连接时的默认工作目录。 */
  effectiveWorkspace(connection) {
    const agent = this.activeAgent;
    return (agent && agent.workspace) || (connection && connection.workspace) || '';
  }

  effectiveModel(connection) {
    const agent = this.activeAgent;
    return (agent && agent.model) || (connection && connection.model) || '';
  }

  /** 会话历史按智能体隔离：切换智能体即切换上下文。 */
  get messages() {
    const id = this.activeAgent ? this.activeAgent.id : 'default';
    if (!this.agentMessages.has(id)) this.agentMessages.set(id, []);
    return this.agentMessages.get(id);
  }

  set messages(value) {
    const id = this.activeAgent ? this.activeAgent.id : 'default';
    this.agentMessages.set(id, Array.isArray(value) ? value : []);
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
    const workspaceDir = this.effectiveWorkspace(connection);
    if (!this.workspace || this.workspace.dir !== path.resolve(workspaceDir)) {
      this.workspace = new Workspace({ root: workspaceDir, logger: this.logger });
      this.workspace.ensure();
      this.memory = new MemoryStore({ workspace: this.workspace, appDir: this.appDir, logger: this.logger });
      this.memory.ensure();
      this.skills = new SkillStore({ builtinDir: this.builtinSkillsDir, workspace: this.workspace, logger: this.logger });
      const agent = this.activeAgent;
      this.tools = new ToolRegistry({
        workspace: this.workspace,
        logger: this.logger,
        permission: (agent && agent.permission) || (connection && connection.permission) || 'read-write'
      });
      this.logger.info('workspace-ready', { workspace: this.workspace.dir, agent: agent && agent.name });
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
    this.lastGatewayError = null;
    if (this.provisioning && normalized.baseUrl) {
      const gateway = this.provisioning.createGateway({ baseUrl: normalized.baseUrl, apiKey: normalized.apiKey });
      try {
        health = await gateway.health();
        session = await gateway.createSession(normalized.profile);
        this.gateway = gateway;
        this.session = session;
      } catch (error) {
        // Gateway 不通只降级：本机工具链路不依赖它。
        gatewayWarning = describeGatewayError(error);
        this.lastGatewayError = error;
        this.dumpGatewayDiagnostic(normalized.baseUrl, normalized.managementUrl, error);
        this.logger.warn('gateway-unreachable', { baseUrl: normalized.baseUrl, error: error.message });
      }

      // 部署清单（provisioning）是可选能力：当前 Hermes 服务端的 8700 端口跑的是 Web UI，
      // 并没有 /api/provisioning/* 端点。这里失败不应该影响 Gateway"就绪"状态。
      if (this.session && normalized.managementUrl) {
        try {
          const managementGateway = this.provisioning.createGateway({ baseUrl: normalized.managementUrl, apiKey: normalized.apiKey });
          deployment = await this.provisioning.provision({
            gateway: managementGateway,
            product: this.product,
            deployment: this.deployment,
            registry: this.registry
          });
        } catch (error) {
          if (error && (error.code === 'not_found' || error.status === 404)) {
            this.logger.info('provisioning-not-available', { managementUrl: normalized.managementUrl, message: error.message });
          } else {
            this.logger.warn('provisioning-failed', { managementUrl: normalized.managementUrl, error: error.message });
          }
          // 不设置 lastGatewayError / gatewayWarning：provisioning 不是 Gateway 核心功能。
        }
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
          this.dumpGatewayDiagnostic(stored.baseUrl, stored.managementUrl, error);
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

  async send({ requestId, text, onConfirm, model }, onEvent) {
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
        onConfirm,
        // 智能体配置的模型优先，其次用界面下拉里选的，最后用连接默认。
        model: this.effectiveModel(this.connection) || model
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

  /** 把 Gateway 错误写成明文诊断文件，方便远程排查。 */
  dumpGatewayDiagnostic(baseUrl, managementUrl, error) {
    try {
      const fs = require('fs');
      const path = require('path');
      const appDir = this.store && this.store.dir ? this.store.dir : this.appDir;
      if (!appDir) return;
      const file = path.join(appDir, 'gateway-diagnostic.json');
      const payload = {
        at: new Date().toISOString(),
        baseUrl,
        managementUrl,
        error: {
          code: error && (error.code || error.status),
          status: error && error.status,
          message: error && error.message,
          stack: error && error.stack
        },
        described: describeGatewayError(error)
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
    } catch (_) { /* 诊断写入失败不影响主流程 */ }
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

  // ---------------------------------------------------------------- 智能体

  listAgents() {
    if (!this.agentStore) return { agents: [], activeId: null };
    return { agents: this.agentStore.list(), activeId: this.agentStore.activeId };
  }

  createAgent(input = {}) {
    if (!this.agentStore) throw new Error('智能体存储不可用');
    const agent = this.agentStore.create(input);
    return this.activateAgent(agent.id);
  }

  updateAgent(id, patch = {}) {
    if (!this.agentStore) throw new Error('智能体存储不可用');
    const agent = this.agentStore.update(id, patch);
    // 改的就是当前智能体：立即生效（工作区/权限/模型都可能在改）。
    if (this.agentStore.activeId === id) return this.activateAgent(id);
    return { agent, switched: false };
  }

  removeAgent(id) {
    if (!this.agentStore) throw new Error('智能体存储不可用');
    const removed = this.agentStore.remove(id);
    // 若删的是当前智能体，切到新的当前项。
    if (this.agentStore.activeId) this.activateAgent(this.agentStore.activeId);
    return { removed, activeId: this.agentStore.activeId };
  }

  /** 切换智能体：重建工作区/工具/权限，恢复该智能体自己的对话历史。 */
  activateAgent(id) {
    if (!this.agentStore) throw new Error('智能体存储不可用');
    const agent = this.agentStore.activate(id);
    let warning = null;
    try {
      // 无论是否已连接，都先把工作区目录落盘（.hermes/、AGENTS.md），
      // 否则"创建智能体 → 填工作目录 → 保存"在未连接时目录不会出现。
      const target = this.effectiveWorkspace(this.connection);
      if (target) {
        if (!this.workspace || this.workspace.dir !== path.resolve(target)) {
          this.ensureRuntime(this.connection);
        } else {
          // 目录没变也可能被用户手动删过：保存即补建。
          this.workspace.ensure();
          if (this.tools && agent.permission) this.tools.setPermission(agent.permission);
        }
      }
      if (this.connection && this.brain && this.tools) {
        this.loop = new AgentLoop({ brain: this.brain, tools: this.tools, workspace: this.workspace, logger: this.logger });
      }
    } catch (error) {
      // 目录建不出来（盘符不存在/无权限）不阻断切换，但要把原因带给 UI。
      warning = `工作目录创建失败：${error.message}`;
      this.logger.warn('agent-workspace-ensure-failed', { id: agent.id, workspace: agent.workspace, error: error.message });
    }
    this.logger.info('agent-activated', { id: agent.id, name: agent.name, workspace: agent.workspace || '(默认)' });
    return { agent, workspace: this.describeWorkspace(), warning };
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
    // 权限档位跟随当前智能体保存，切换智能体后各自记住自己的档位。
    const agent = this.activeAgent;
    if (agent && this.agentStore) {
      try { this.agentStore.update(agent.id, { permission: level }); } catch (_) {}
    }
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
    const cleared = this.store.clear(false); // 清除配置
    this.connection = null;
    this.brain = null;
    this.gateway = null;
    this.session = null;
    this.messages = [];
    this.lastGatewayError = null;
    this.logger.info('disconnected', { cleared });
    return { cleared };
  }

  clearCache() {
    this.abort();
    // 彻底清除所有缓存文件
    const appData = this.store.dir || app.getPath('userData');
    const fs = require('fs');
    const path = require('path');
    const dirs = ['gateway-cache', 'logs', 'memory', 'persona', 'skills'];
    dirs.forEach((subDir) => {
      const dirPath = path.join(appData, subDir);
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    });
    // 清除配置文件
    this.store.clear();
    this.connection = null;
    this.brain = null;
    this.gateway = null;
    this.session = null;
    this.messages = [];
    this.lastGatewayError = null;
    this.workspace = null;
    this.tools = null;
    this.memory = null;
    this.skills = null;
    this.loop = null;
    this.logger.info('cache-cleared');
    return { cleared: true };
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
