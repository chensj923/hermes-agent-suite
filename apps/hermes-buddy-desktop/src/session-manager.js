'use strict';

const path = require('path');
const fs = require('fs');
const { describeGatewayError } = require('@hermes/connection');
const { publicView } = require('./connection-store');
const { Workspace } = require('./workspace');
const { ToolRegistry } = require('./tools');
const { Brain, describeBrainError, BUDDY_PROXY_PORT } = require('./agent/brain');
const { AgentLoop } = require('./agent/loop');
const { ChannelClient } = require('./agent/channel');
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
    this.channel = null;   // WS 工具通道客户端（通道模式）

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
      ready: Boolean((this.brain && this.workspace) || (this.channel && this.channel.connected)),
      connected: Boolean(this.session || (this.channel && this.channel.connected)),
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
    if (!this.brain && connection && connection.mode !== 'channel') {
      // 通道模式：决策在 Hermes 服务端外挂通道，本机不建 Brain/本地 ReAct 循环。
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
   * 端点能力校验 + 自动纠正（v2.3.9）。
   *
   * 背景（2026-09-14 实测终版）：
   * Gateway 的 /v1/chat/completions（api_server 平台，22122）是"服务端 agent 端点"——
   * 无视请求里的 tools、注入自有系统提示、在服务器上执行命令；
   * 换 model 名（填 hermes-agent 或底层真实模型 ark-code-latest）都绕不过去。
   * `hermes proxy` 也不是本地推理端点：它把请求转发给 OAuth 供应商（Nous/xai），
   * 子命令是 start、默认端口 8645。
   *
   * 所以：Buddy 必须直连一个原生支持 function calling 的 OpenAI 兼容端点
   * （上游供应商 / hermes proxy / 自建 vLLM 等）。
   * 这里只做「检测到 agent 端点 → 顺带试一下同主机 8645 是不是 hermes proxy」，
   * 找不到就抛出可直接照做的错误，不再瞎猜端口。
   */
  async resolveBrain(connection) {
    const brain = new Brain({
      endpoint: connection.llmUrl,
      model: connection.model,
      apiKey: connection.apiKey,
      fetchImpl: this.fetchImpl
    });
    let probe;
    try {
      probe = await brain.probeCapability();
    } catch (error) {
      // 探测失败（网络/超时）不在这里定论，让后续 assertReachable 给出具体错误。
      this.logger.warn('endpoint-probe-failed', { llmUrl: connection.llmUrl, error: error.message });
      return { brain, llmUrl: connection.llmUrl, notice: null };
    }

    if (probe.verdict === 'stateless') return { brain, llmUrl: connection.llmUrl, notice: null };
    if (probe.verdict === 'no_fc') {
      // 模型没回 tool_calls 但也没有服务端注入的迹象：不致命，聊天时再观察。
      this.logger.warn('endpoint-no-fc', { llmUrl: connection.llmUrl, detail: probe.detail });
      return { brain, llmUrl: connection.llmUrl, notice: null };
    }
    if (probe.verdict === 'unknown') {
      // 探测失败（网络/超时）不在这里定论，让后续 assertReachable 给出具体错误。
      return { brain, llmUrl: connection.llmUrl, notice: null };
    }

    // verdict === 'agent_endpoint'：请求被服务端 agent 接管，尝试同主机上的纯推理候选端口。
    // 8811 = Buddy 直通代理（服务端准备脚本部署，首选）；8645 = hermes proxy 默认端口。
    this.logger.warn('endpoint-is-agent-mode', { llmUrl: connection.llmUrl, verdict: probe.verdict, detail: probe.detail });
    for (const port of [BUDDY_PROXY_PORT, '8645', '8800', '8000']) {
      let alt;
      try { alt = withPort(connection.llmUrl, port); } catch (_) { continue; }
      if (!alt || alt === connection.llmUrl) continue;
      const altBrain = new Brain({
        endpoint: alt,
        model: connection.model,
        apiKey: connection.apiKey,
        fetchImpl: this.fetchImpl
      });
      try {
        const altProbe = await altBrain.probeCapability();
        if (altProbe.verdict === 'stateless') {
          this.logger.info('endpoint-auto-switched', { from: connection.llmUrl, to: alt });
          return {
            brain: altBrain,
            llmUrl: alt,
            notice: `检测到 ${connection.llmUrl} 是服务端 agent 端点（会在服务器上执行命令，Buddy 无法使用），已自动切换到纯推理端点 ${alt}`
          };
        }
      } catch (_) { /* 下一个候选 */ }
    }

    throw new Error(
      `当前推理端点（${connection.llmUrl}）是 Hermes 服务端 agent 端点：` +
      '它会忽略请求里的 tools、注入自己的系统提示，并在服务器上执行命令后返回文字，' +
      '所以 Buddy 的本地工具链路完全用不了（换模型名也绕不过去，已实测）。\n' +
      `修复办法：在连接页点「生成服务端准备脚本」，到 Hermes 服务器上跑一次 ——\n` +
      `它会在本机部署 Buddy 推理直通代理（:${BUDDY_PROXY_PORT}），复用 Hermes 自己配好的上游模型\n` +
      `并原样透传 tools；完成后把「推理端点」填 http://<hermes-host>:${BUDDY_PROXY_PORT}/v1/chat/completions。\n` +
      '也可以手填任意原生支持 function calling 的 OpenAI 兼容端点，例如：\n' +
      '  · 火山方舟 Ark：https://ark.cn-beijing.volces.com/api/v3/chat/completions\n' +
      '  · DeepSeek：    https://api.deepseek.com/v1/chat/completions'
    );
  }

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

    // 通道模式：决策在 Hermes 主机的外挂通道，本地只执行工具，不需要 LLM 端点。
    if (normalized.mode === 'channel') {
      return await this.connectChannel(normalized);
    }

    // 端点能力校验：agent 端点自动切换到纯推理端口，找不到直接报可操作的错。
    const resolved = await this.resolveBrain(normalized);
    const brain = resolved.brain;
    normalized.llmUrl = resolved.llmUrl;
    const endpointNotice = resolved.notice;

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
      gatewayWarning,
      endpointNotice
    };
  }

  /**
   * 通道模式连接：决策在 Hermes 主机的外挂通道，本地只执行工具。
   * 不走 Brain / 本地 ReAct 循环，直接建一条持久 WS 通道。
   */
  async connectChannel(normalized) {
    const channel = new ChannelClient({
      url: normalized.channelUrl,
      token: normalized.apiKey,
      tools: this.tools,
      logger: this.logger,
      autoConfirm: true
    });
    try {
      await channel.connect();
    } catch (error) {
      throw new Error(`连不上 WS 通道（${normalized.channelUrl}）：${error.message}`);
    }
    this.channel = channel;
    this.brain = null;
    this.loop = null;

    // Gateway 会话登记是通道模式下的辅助功能，不影响本机工具执行。
    // 之前用 await 同步等 Gateway，但 Electron main 进程的 fetch 可能被代理拦截
    // 导致卡死。现在改为 fire-and-forget：WS 连上就算连接成功，Gateway 在后台异步尝试。
    this.lastGatewayError = null;
    this._registerGatewayInBackground(normalized);

    const saved = this.store.save(normalized);
    this.connection = saved;
    this.messages = [];
    this.logger.info('connected-channel', { channelUrl: normalized.channelUrl });
    return {
      connection: publicView(saved),
      session: null,
      deployment: null,
      health: null,
      models: [],
      workspace: this.describeWorkspace(),
      gatewayWarning: null,
      endpointNotice: '通道模式：决策在 Hermes 主机外挂通道，本地只执行工具。'
    };
  }

  /**
   * 后台异步尝试 Gateway 会话登记（通道模式专用）。
   * 成功就把 session/gateway 挂到 this 上；失败只记 warning，不阻塞任何用户操作。
   */
  _registerGatewayInBackground(normalized) {
    if (!this.provisioning || !normalized.baseUrl) return;
    Promise.resolve().then(async () => {
      try {
        const gateway = this.provisioning.createGateway({
          baseUrl: normalized.baseUrl,
          apiKey: normalized.apiKey,
          timeoutMs: 8000
        });
        await gateway.health();
        const session = await gateway.createSession(normalized.profile);
        this.gateway = gateway;
        this.session = session;
        this.logger.info('channel-gateway-registered', { baseUrl: normalized.baseUrl });
      } catch (error) {
        this.lastGatewayError = error;
        this.dumpGatewayDiagnostic(normalized.baseUrl, normalized.managementUrl, error);
        this.logger.warn('channel-gateway-degraded', { baseUrl: normalized.baseUrl, error: error.message });
      }
    }).catch((err) => {
      this.logger.warn('channel-gateway-bg-error', { error: err.message });
    });
  }

  /** 用已保存凭据恢复。找不到配置或推理端点不通都算失败。 */
  async resume() {
    const stored = this.connection || this.store.load();
    if (!stored) return { ok: false, reason: 'not_configured', message: '还没有配置 Hermes 连接' };
    try {
      this.ensureRuntime(stored);
      if (stored.mode === 'channel') return await this.resumeChannel(stored);
      // 恢复时同样做端点能力校验（agent 端点自动切到纯推理端口并持久化纠正结果）。
      const resolved = await this.resolveBrain(stored);
      const brain = resolved.brain;
      stored.llmUrl = resolved.llmUrl;
      const endpointNotice = resolved.notice;
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
      return { ok: true, connection: publicView(stored), workspace: this.describeWorkspace(), gatewayWarning, endpointNotice };
    } catch (error) {
      this.logger.warn('resume-failed', { error: error.message, code: error.code });
      return { ok: false, reason: error.code || 'error', message: describeBrainError(error) };
    }
  }

  async resumeChannel(stored) {
    const channel = new ChannelClient({
      url: stored.channelUrl,
      token: stored.apiKey,
      tools: this.tools,
      logger: this.logger,
      autoConfirm: true
    });
    try {
      await channel.connect();
    } catch (error) {
      return { ok: false, reason: 'channel_error', message: `连不上 WS 通道（${stored.channelUrl}）：${error.message}` };
    }
    this.channel = channel;
    this.brain = null;
    this.loop = null;

    // Gateway 后台异步登记（与 connectChannel 一致，不阻塞恢复流程）
    this.lastGatewayError = null;
    this._registerGatewayInBackground(stored);

    this.connection = stored;
    this.messages = [];
    this.logger.info('resumed-channel', { channelUrl: stored.channelUrl });
    return { ok: true, connection: publicView(stored), workspace: this.describeWorkspace() };
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
    const history = this.messages.slice(-MAX_HISTORY_MESSAGES);

    // 通道模式：把消息发给 WS 通道，服务端跑 Agent 循环，事件原样转发给 UI。
    // 断线自愈：若通道已死，用已存配置自动重建并重发一次，用户无需手动点「重连」。
    if (this.channel && (this.channel.closed || !this.channel.connected)) {
      try { this.channel.close(); } catch (_) {}
      this.channel = null;
    }
    if (this.channel) {
      this.channel.emit = emit;
      try {
        return await this._sendOverChannel(text, history, id);
      } catch (error) {
        const message = error.message || '';
        const toolInterrupted = /工具执行中中断/.test(message);
        const connDead = /通道连接已断开|通道握手|ECONN|socket|通道错误|通道连接超时|通道握手超时/.test(message);
        if (connDead && !toolInterrupted && (this.connection || this.store)) {
          this.logger.warn('channel-dropped-auto-reconnect', { message });
          try { if (this.channel) this.channel.close(); } catch (_) {}
          this.channel = null;
          try {
            await this._ensureChannel();
          } catch (re) {
            this.channel = null;
            emit({ kind: 'error', type: 'error', message: re.message || '通道重连失败，请点「重连」按钮。' });
            const wrapped = new Error(re.message || '通道连接已断开'); wrapped.code = 'channel_error'; throw wrapped;
          }
          this.channel.emit = emit;
          try {
            return await this._sendOverChannel(text, history, id);
          } catch (e2) {
            this.channel = null;
            const m2 = e2.message || '通道连接已断开';
            emit({ kind: 'error', type: 'error', message: m2 });
            const wrapped = new Error(m2); wrapped.code = 'channel_error'; throw wrapped;
          }
        }
        const wrapped = new Error(message || '通道错误'); wrapped.code = 'channel_error'; throw wrapped;
      } finally {
        this.controllers.delete(id);
      }
    } else if (this.connection && this.connection.mode === 'channel') {
      // 没有活跃通道但有保存的配置：先连上再发。
      try {
        await this._ensureChannel();
        this.channel.emit = emit;
        const out = await this._sendOverChannel(text, history, id);
        return out;
      } catch (error) {
        const m = error.message || '通道连接已断开';
        emit({ kind: 'error', type: 'error', message: m });
        const w = new Error(m); w.code = 'channel_error'; throw w;
      } finally {
        this.controllers.delete(id);
      }
    }

    try {
      const systemPrompt = this.buildPrompt();
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

  /** 用已保存配置重建一条 WS 通道（断线自愈用）。已连着就直接复用。 */
  async _ensureChannel() {
    if (this.channel && !this.channel.closed && this.channel.connected) return this.channel;
    if (this.channel) { try { this.channel.close(); } catch (_) {} this.channel = null; }
    const stored = this.connection || (this.store ? this.store.load() : null);
    if (!stored || stored.mode !== 'channel') throw new Error('没有可用的通道配置');
    const channel = new ChannelClient({
      url: stored.channelUrl,
      token: stored.apiKey,
      tools: this.tools,
      logger: this.logger,
      autoConfirm: true,
    });
    await channel.connect();
    this.channel = channel;
    return channel;
  }

  /** 通过 WS 通道发一条消息并等待 task_done，顺带维护本地历史。 */
  async _sendOverChannel(text, history, id) {
    const result = await this.channel.sendMessage(text, history, { timeoutMs: 10 * 60 * 1000 });
    this.messages.push({ role: 'user', content: String(text || '') });
    if (result && result.text) this.messages.push({ role: 'assistant', content: result.text });
    this.trimHistory();
    this.remember({ role: 'user', text: String(text || ''), at: Date.now() });
    return { requestId: id, text: result.text, turns: result.turns || 0, toolCalls: 0, stopped: result.stopped };
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
    if (this.channel) {
      this.channel.abort();
      return true;
    }
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
    if (this.channel) { this.channel.close(); this.channel = null; }
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
    if (this.channel) { this.channel.close(); this.channel = null; }
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

/** 把 URL 的端口换成 port，其余（主机/路径）保持不变；解析失败返回 null。 */
function withPort(urlString, port) {
  try {
    const url = new URL(urlString);
    url.port = String(port);
    return url.toString();
  } catch (_) {
    return null;
  }
}

module.exports = { SessionManager, MAX_HISTORY_MESSAGES, PERSONA_FILE, summarizeArgs };
