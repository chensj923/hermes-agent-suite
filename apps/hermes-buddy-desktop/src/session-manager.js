'use strict';

const path = require('path');
const fs = require('fs');
const { describeGatewayError } = require('@hermes/connection');
const { publicView } = require('./connection-store');
const { Workspace } = require('./workspace');
const { ToolRegistry } = require('./tools');
const { Brain, describeBrainError, BUDDY_PROXY_PORT } = require('./agent/brain');
const { AgentLoop } = require('./agent/loop');
const { ChannelClient, versionAtLeast, REQUIRED_CHANNEL_VERSION } = require('./agent/channel');
const { partsToContent, textToContent, contentToPlainText, stripImagesFromHistory } = require('./agent/parts');
const { DashboardClient } = require('./agent/dashboard-client');
const { buildSystemPrompt, DEFAULT_PERSONA } = require('./agent/prompts');
const { MemoryStore, rememberLine } = require('./memory');
const { SkillStore } = require('./skills');
const { detectTooling, renderToolchainForPrompt } = require('./toolchain');
const { AgentStore } = require('./agent-store');
const http = require('http');
const https = require('https');

const MAX_HISTORY_MESSAGES = 30;
const PERSONA_FILE = 'persona.md';
// 会话历史落盘：按智能体隔离，存到 appDir/history/<agentId>.json。
// 落盘前先脱图（stripImagesFromHistory），避免 base64 图片占满磁盘和下次重载时的体积。
const HISTORY_DIR = 'history';
const HISTORY_MAX_CHARS = 200000;   // 落盘上限，超了从最老开始截

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
    this._unsupportedModels = new Set(); // 本会话内被上游拒绝过的模型名

    this.workspace = null;
    this.tools = null;
    this.memory = null;
    this.skills = null;
    this.loop = null;
    this.channel = null;   // WS 工具通道客户端（通道模式）
    this._channelOutdated = null;   // 服务端通道版本过旧的提示语（重新部署后清空）

    // 智能体：每个智能体独立的工作区/权限/模型，会话历史也按智能体隔离。
    try {
      this.agentStore = new AgentStore({ dir: appDir, logger: this.logger });
    } catch (error) {
      this.logger.warn('agent-store-init-failed', { error: error.message });
      this.agentStore = null;
    }
    this.agentMessages = new Map(); // agentId -> OpenAI 消息数组
    this._lastCrystallize = { at: null, scopes: [], error: null }; // 1.5 结晶同步状态
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
    const picked = (agent && agent.model) || (connection && connection.model) || '';
    // 被上游打回过的模型（如 coding plan 不支持）本会话内不再发送，交给服务端默认模型。
    if (picked && this._unsupportedModels && this._unsupportedModels.has(picked)) return '';
    return picked;
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
    // 工作目录优先用"激活智能体专属配置"，其次才用连接时的默认工作目录。
    // 之前直接拿 connection.workspace，导致切换智能体后聊天框下方显示的工作目录不一致。
    const effectiveWs = this.effectiveWorkspace(this.connection) || view.workspace;
    const workspaceSource = (this.activeAgent && this.activeAgent.workspace) ? 'agent' : 'connection';
    return {
      ...view,
      workspace: effectiveWs,
      workspaceSource,
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
        permission: (agent && agent.permission) || (connection && connection.permission) || 'read-write',
        memory: this.memory
      });
      this.logger.info('workspace-ready', { workspace: this.workspace.dir, agent: agent && agent.name });
      // 工作区就绪后恢复该智能体的历史记录（之前只存在内存里，重开 Buddy 就丢了）
      this.loadHistory();
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

    // Dashboard 模式：HTTP 连 Dashboard 后端（:9119），与官方 Desktop 一致
    if (normalized.mode === 'dashboard') {
      return await this.connectDashboard(normalized);
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
    this.loadHistory();
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
      // 版本过旧：这不是「连不上」，而是连上了但服务端能力不够。
      // 原样抛出，别包成「连不上 WS 通道」，否则用户会去查网络而不是重新部署。
      if (error && error.code === 'channel_outdated') {
        this._channelOutdated = error.message;
        throw error;
      }
      this._channelOutdated = null;
      throw new Error(`连不上 WS 通道（${normalized.channelUrl}）：${error.message}`);
    }
    this.channel = channel;
    this._channelOutdated = null;   // 版本谈妥了，清掉上一次的「需重新部署」提示
    this.brain = null;
    this.loop = null;

    // Gateway 会话登记是通道模式下的辅助功能，不影响本机工具执行。
    // 之前用 await 同步等 Gateway，但 Electron main 进程的 fetch 可能被代理拦截
    // 导致卡死。现在改为 fire-and-forget：WS 连上就算连接成功，Gateway 在后台异步尝试。
    this.lastGatewayError = null;
    this._registerGatewayInBackground(normalized);

    const saved = this.store.save(normalized);
    this.connection = saved;
    this.loadHistory();
    this.logger.info('connected-channel', { channelUrl: normalized.channelUrl, history: this.messages.length });
    return {
      connection: publicView(saved),
      session: null,
      deployment: null,
      health: null,
      models: [],
      workspace: this.describeWorkspace(),
      gatewayWarning: null,
      endpointNotice: this.connection && this.connection.mode === 'dashboard'
        ? 'Dashboard 模式：通过 HTTP 连 Hermes Dashboard 后端。'
        : '通道模式：决策在 Hermes 主机外挂通道，本地只执行工具。'
    };
  }

  /**
   * Dashboard 模式连接：通过 HTTP 连 Hermes Dashboard 后端（:9119）。
   * 与官方 Hermes Desktop 的连接方式一致：HTTP REST，不走 WS。
   * 事件接口与 ChannelClient 完全一致，send() 无需区分。
   */
  async connectDashboard(normalized) {
    const client = new DashboardClient({
      url: normalized.dashboardUrl,
      token: normalized.apiKey,
      tools: this.tools,
      logger: this.logger,
      autoConfirm: true
    });
    try {
      await client.connect();
    } catch (error) {
      throw new Error(`连不上 Dashboard 后端（${normalized.dashboardUrl}）：${error.message}`);
    }
    this.channel = client;  // 复用 this.channel 让 send() 不用改
    this.brain = null;
    this.loop = null;

    this.lastGatewayError = null;
    this._registerGatewayInBackground(normalized);

    const saved = this.store.save(normalized);
    this.connection = saved;
    this.loadHistory();
    this.logger.info('connected-dashboard', { dashboardUrl: normalized.dashboardUrl, history: this.messages.length });
    return {
      connection: publicView(saved),
      session: null,
      deployment: null,
      health: null,
      models: [],
      workspace: this.describeWorkspace(),
      gatewayWarning: null,
      endpointNotice: 'Dashboard 模式：通过 HTTP 连 Hermes Dashboard 后端，与官方 Desktop 连接方式一致。'
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
      if (stored.mode === 'dashboard') return await this.resumeDashboard(stored);
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
      // 版本过旧是「需要重新部署」，不是网络问题，别混进 channel_error 的连不上文案。
      if (error && error.code === 'channel_outdated') {
        this._channelOutdated = error.message;
        return { ok: false, reason: 'channel_outdated', message: error.message };
      }
      this._channelOutdated = null;
      return { ok: false, reason: 'channel_error', message: `连不上 WS 通道（${stored.channelUrl}）：${error.message}` };
    }
    this.channel = channel;
    this._channelOutdated = null;
    this.brain = null;
    this.loop = null;

    // Gateway 后台异步登记（与 connectChannel 一致，不阻塞恢复流程）
    this.lastGatewayError = null;
    this._registerGatewayInBackground(stored);

    this.connection = stored;
    // 之前每次重连/重开都把历史清零 -> 模型"转个头就忘"。
    // 现在从落盘恢复：保证连续对话体验。
    this.loadHistory();
    this.logger.info('resumed-channel', { channelUrl: stored.channelUrl, history: this.messages.length });
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

  async send({ requestId, text, parts, onConfirm, model }, onEvent) {
    await this.ensureReady();
    const id = String(requestId || `req-${Date.now()}`);
    if (this.controllers.has(id)) throw new Error('该请求已在进行中');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const emit = (event) => { if (typeof onEvent === 'function') onEvent({ requestId: id, ...event }); };
    // 历史里只留最近一张图：图片是 base64 内嵌的，不剔除会每轮累积、把请求撑爆。
    const history = stripImagesFromHistory(this.messages.slice(-MAX_HISTORY_MESSAGES));
    // 把服务端实际在调的模型地址告诉界面：出「连接被拒绝」时用户才知道该去查哪个地址
    if (this.channel && this.channel.serverUpstream) {
      emit({ type: 'upstream', url: this.channel.serverUpstream });
    }
    // 通道模式也要把模型透传过去：智能体配置的模型优先，其次界面下拉选的。
    const wantModel = this.effectiveModel(this.connection) || model || '';
    // 把高层 parts 归一成 OpenAI 多模态 content（含本地音视频预处理）；
    // 没有 parts 时退回纯文本 text。预处理失败/缺引擎时降级并提示，不阻断发送。
    const { content, warnings, missing } = await this._buildUserContent(parts, text);
    for (const w of (warnings || [])) {
      emit({
        type: 'notice',
        message: w,
        // 缺引擎时带上动作标记，渲染层据此渲染「一键安装」按钮
        ...(missing && missing.length ? { action: 'install-media-engines', missing } : {}),
      });
    }

    // 通道模式：把消息发给 WS 通道，服务端跑 Agent 循环，事件原样转发给 UI。
    // 断线自愈：若通道已死，用已存配置自动重建并重发一次，用户无需手动点「重连」。
    if (this.channel && (this.channel.closed || !this.channel.connected)) {
      try { this.channel.close(); } catch (_) {}
      this.channel = null;
    }
    if (this.channel) {
      this.channel.emit = emit;
      try {
        return await this._sendOverChannel(content, history, id, wantModel);
      } catch (error) {
        const message = error.message || '';
        const toolInterrupted = /工具执行中中断/.test(message);
        // 版本过旧不是断线，重连一万次也没用：别走进自动重连分支。
        const outdated = (error && error.code === 'channel_outdated') || /通道版本过旧/.test(message);
        const connDead = !outdated && /通道连接已断开|通道握手|ECONN|socket|通道错误|通道连接超时|通道握手超时/.test(message);
        if (outdated) this._channelOutdated = message;
        if (error && error.code === 'model_unsupported' && wantModel) {
          this._unsupportedModels.add(wantModel);
          this.logger.warn('upstream-model-unsupported', { model: wantModel });
        }
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
            return await this._sendOverChannel(content, history, id, wantModel);
          } catch (e2) {
            this.channel = null;
            const m2 = e2.message || '通道连接已断开';
            emit({ kind: 'error', type: 'error', message: m2 });
            const wrapped = new Error(m2); wrapped.code = 'channel_error'; throw wrapped;
          }
        }
        // 上游结构化错误（如 model_unsupported）要把 code 传下去，界面才能给针对性提示
        const wrapped = new Error(message || '通道错误');
        wrapped.code = (error && error.code) || 'channel_error';
        throw wrapped;
      } finally {
        this.controllers.delete(id);
      }
    } else if (this.connection && (this.connection.mode === 'channel' || this.connection.mode === 'dashboard')) {
      // 没有活跃连接但有保存的配置：先连上再发（通道/Dashboard 同一逻辑）。
      try {
        await this._ensureChannel();
        this.channel.emit = emit;
        const out = await this._sendOverChannel(content, history, id, wantModel);
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
        // 多模态：content 数组（文本/图片/文件/音视频预处理后的派生内容）
        userContent: content,
        signal: controller.signal,
        onEvent: emit,
        onConfirm,
        // 智能体配置的模型优先，其次用界面下拉里选的，最后用连接默认。
        model: this.effectiveModel(this.connection) || model
      });

      this.messages.push({ role: 'user', content });
      if (result.text) this.messages.push({ role: 'assistant', content: result.text });
      this.trimHistory();
      this.saveHistory();
      this.remember({ role: 'user', text: contentToPlainText(content), at: Date.now() });
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
    // 已判定服务端通道过旧：别再反复握手，直接给出「重新部署」的指引。
    // 重新部署成功后走 connectChannel/resumeChannel 会把它清空。
    if (this._channelOutdated) {
      const err = new Error(this._channelOutdated);
      err.code = 'channel_outdated';
      throw err;
    }
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
    // 1.5「结晶」：连上服务端后自动把本机记忆同步上去，让服务端形成跨会话持久知识。
    // 这是"结晶系统"的核心--本机记忆不只在当前会话生效，而是沉淀到服务端、跨连接/跨 Buddy 持续。
    this._crystallizeInBackground().catch(() => {});
    return channel;
  }

  /**
   * 1.5「结晶」：把本机记忆和项目约定异步同步到服务端。
   * 不阻塞发送流程，失败了也不影响聊天--结晶是"尽力做"不是"必须做"。
   */
  async _crystallizeInBackground() {
    if (!this.channel || !this.channel._supportsResume) {
      this._lastCrystallize = { at: Date.now(), scopes: [], error: '服务端不支持结晶同步（需 1.5+）' };
      return;
    }
    const globalMem = this.memory ? this.memory.globalMemory().trim() : '';
    const projectMem = this.memory ? this.memory.projectMemory().trim() : '';
    const agentsDoc = this.workspace ? String(this.workspace.readAgents() || '').trim() : '';
    const scopes = [];
    const errors = [];
    // 全局记忆 -> 服务端 GLOBAL.md
    if (globalMem) {
      try {
        await this.channel.syncMemory(globalMem, 'global');
        scopes.push('global');
      } catch (e) { errors.push(`global: ${e.message || '失败'}`); }
    }
    // 项目记忆 -> 服务端 PROJECT.md
    if (projectMem) {
      try {
        await this.channel.syncMemory(projectMem, 'project');
        scopes.push('project');
      } catch (e) { errors.push(`project: ${e.message || '失败'}`); }
    }
    // AGENTS.md -> 服务端 AGENTS.md
    if (agentsDoc) {
      try {
        await this.channel.syncMemory(agentsDoc, 'agents');
        scopes.push('agents');
      } catch (e) { errors.push(`agents: ${e.message || '失败'}`); }
    }
    this._lastCrystallize = {
      at: Date.now(),
      scopes,
      error: errors.length ? errors.join('; ') : null
    };
  }

  /** 通过 WS 通道发一条消息并等待 task_done，顺带维护本地历史。 */
  async _sendOverChannel(content, history, id, model) {
    const result = await this.channel.sendMessage(content, history, {
      timeoutMs: 10 * 60 * 1000,
      // 把选中的模型透传给服务端，让它用这个模型跑 Agent 循环
      model: model || '',
      // 本机上下文（记忆/项目约定/技能/工作区）一并发过去，否则服务端模型
      // 只看得到它自己那份硬编码 SYSTEM_PROMPT，客户端记忆写了也白写。
      systemExtra: this.buildContextBlock(),
    });
    this.messages.push({ role: 'user', content });
    if (result && result.text) this.messages.push({ role: 'assistant', content: result.text });
    this.trimHistory();
    this.saveHistory();
    this.remember({ role: 'user', text: contentToPlainText(content), at: Date.now() });
    return { requestId: id, text: result.text, turns: result.turns || 0, toolCalls: 0, stopped: result.stopped };
  }

  /**
   * 把渲染层传来的高层 parts 归一成 OpenAI 多模态 content 数组。
   *
   * 关键点：语音/视频在这里之前**已经**由 media-preprocess 在 Win 端本地预处理
   * （Whisper 转写 + ffmpeg 抽关键帧），所以原始音视频不会离开本机、不会上传服务端；
   * 最终只有 text / image / file 三类进 content。
   *
   * 返回 { content, warnings, missing }。缺引擎/预处理失败时降级（丢弃无法处理的媒体并提示），
   * 绝不阻断发送——否则用户一条消息就彻底发不出去。
   */
  async _buildUserContent(parts, text) {
    let normalized = parts;
    let warnings = [];
    let missing = [];
    const hasRawMedia = Array.isArray(parts)
      && parts.some((p) => p && (p.type === 'audio' || p.type === 'video'));
    if (hasRawMedia) {
      try {
        const { preprocessParts } = require('./media-preprocess');
        const out = await preprocessParts(parts, { appDir: this.appDir, logger: this.logger });
        normalized = out.parts;
        warnings = out.warnings || [];
        missing = out.missing || [];
      } catch (error) {
        this.logger.warn('media-preprocess-failed', { error: error.message });
        warnings = [`音视频本地处理失败：${error.message || '未知错误'}（已跳过这些附件）`];
        normalized = (parts || []).filter((p) => p && p.type !== 'audio' && p.type !== 'video');
      }
    }
    const content = (normalized && normalized.length)
      ? (partsToContent(normalized) || textToContent(''))
      : textToContent(text);
    return { content, warnings, missing };
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

  // ---------------------------------------------------------------- 历史落盘

  /**
   * 会话历史落盘到 appDir/history/<agentId>.json。
   *
   * 为什么必须落盘：之前 this.messages 纯内存，重开 Buddy / 断线重连 / 重启服务端
   * 都会让上下文清零--模型"转个头就忘"。落盘后启动时恢复，体验跟连续对话一致。
   *
   * 落盘内容：已脱图的纯文本/工具消息（图片 base64 不存盘，既省空间又避免
   * 下次重载时把它们原样塞回 history 再发一遍）。
   */
  _historyFile(agentId) {
    const id = String(agentId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.appDir, HISTORY_DIR);
    return path.join(dir, `${id}.json`);
  }

  saveHistory() {
    try {
      const file = this._historyFile(this.activeAgent ? this.activeAgent.id : null);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 落盘前脱图：只存 text，避免 base64 图片占满磁盘
      const stripped = stripImagesFromHistory(this.messages.slice(-MAX_HISTORY_MESSAGES), 0);
      const payload = {
        agentId: this.activeAgent ? this.activeAgent.id : 'default',
        savedAt: new Date().toISOString(),
        messages: stripped,
      };
      let json = JSON.stringify(payload, null, 0);
      // 硬上限：超了从头部截（最老的对话先丢）
      if (json.length > HISTORY_MAX_CHARS) {
        json = json.slice(0, HISTORY_MAX_CHARS);
        // 截断后可能不是合法 JSON，补个尾巴闭合
        json = json.replace(/,\s*$/, '') + ']}';
      }
      fs.writeFileSync(file, json, 'utf8');
      this.logger.info('history-saved', { agentId: payload.agentId, messages: stripped.length });
    } catch (error) {
      this.logger.warn('history-save-failed', { error: error.message });
    }
  }

  loadHistory() {
    try {
      const file = this._historyFile(this.activeAgent ? this.activeAgent.id : null);
      const json = fs.readFileSync(file, 'utf8');
      const payload = JSON.parse(json);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return;
      // 恢复到 this.messages（getter 会按 agentId 自动找到正确的数组）
      this.messages = messages.slice(-MAX_HISTORY_MESSAGES);
      this.logger.info('history-loaded', { agentId: payload.agentId, messages: this.messages.length });
    } catch (_) {
      // 文件不存在/损坏：静默跳过，用空历史启动
    }
  }

  clearHistory() {
    this.messages = [];
    // 同步删掉落盘文件：重开 Buddy 也不把已清的历史恢复回来
    try {
      const file = this._historyFile(this.activeAgent ? this.activeAgent.id : null);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
    return { cleared: true };
  }

  remember(entry) {
    if (!this.transcript) this.transcript = [];
    this.transcript.push(entry);
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
  }

  history() { return (this.transcript || []).slice(); }

  /**
   * 发给服务端补在 system 提示词后面的"本机上下文"。
   *
   * 通道模式下服务端有自己的身份与工具说明，所以这里**不重复身份**，只补它拿不到的东西：
   * 长期记忆、项目约定（AGENTS.md）、技能、工作目录。没有这段，客户端记忆写得再全，
   * 服务端模型也一个字都看不到。
   */
  buildContextBlock() {
    const blocks = [];
    const memory = this.memory ? this.memory.render().trim() : '';
    if (memory) blocks.push(memory);
    const agentsDoc = this.workspace ? String(this.workspace.readAgents() || '').trim() : '';
    if (agentsDoc) blocks.push(`【项目约定（AGENTS.md）】\n${agentsDoc.slice(0, 4000)}`);
    const skills = this.skills ? String(this.skills.render() || '').trim() : '';
    if (skills) blocks.push(skills);
    if (this.workspace) blocks.push(`【工作目录】${this.workspace.dir}`);
    blocks.push(`【当前时间】${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    const text = blocks.join('\n\n').trim();
    return text ? text.slice(0, 12000) : '';
  }

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
          // 切换智能体后 getter 已指向新 agentId 的数组，但那是空的--加载该智能体的落盘历史
          this.loadHistory();
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
        permission: (this.connection && this.connection.permission) || 'read-write',
        memory: this.memory
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

  /**
   * 记忆诊断：给 UI 展示当前记忆文件位置、字符数、最近结晶同步状态。
   * 方便用户排查"记忆为什么还是空的"。
   */
  memoryDiagnostics() {
    if (!this.memory || !this.workspace) {
      return {
        ready: false,
        workspace: null,
        projectPath: null,
        globalPath: null,
        projectChars: 0,
        globalChars: 0,
        lastCrystallize: this._lastCrystallize
      };
    }
    return {
      ready: true,
      workspace: this.workspace.dir,
      projectPath: path.join(this.workspace.memoryDir, 'MEMORY.md'),
      globalPath: path.join(this.appDir, 'memory', 'MEMORY.md'),
      projectChars: this.memory.projectMemory().length,
      globalChars: this.memory.globalMemory().length,
      lastCrystallize: this._lastCrystallize
    };
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
    // 通道模式没有本地 Brain（this.brain 为 null），模型清单必须问服务端要：
    // 服务端会去上游拉 /models，拿不到就用 config.yaml 里声明的模型名兜底。
    if (this.channel) {
      try {
        return await this.channel.listModels();
      } catch (error) {
        this.logger.warn('channel-list-models-failed', { error: error.message });
      }
    }
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

  // ---------------------------------------------------------------- 多连接（多网关）

  /** 列出所有已保存的 Hermes 连接（不含密钥），供连接页切换/删除。 */
  listProfiles() {
    if (!this.store.listProfiles) return { activeId: null, profiles: [] };
    const result = this.store.listProfiles();
    const currentId = this.connection ? this.store._idFor(this.connection) : result.activeId;
    result.profiles = result.profiles.map((p) => ({ ...p, active: p.id === currentId || p.active }));
    return result;
  }

  /**
   * 探测某个已保存连接的服务端通道版本。
   * 渲染层在连接列表里用它做"是否需要重新部署"的引导。
   */
  probeProfileVersion(profile) {
    return new Promise((resolve) => {
      if (!profile) return resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: '无连接信息' });
      // 优先用通道地址；没有就用 Gateway 地址推导。
      let raw = profile.channelUrl || profile.baseUrl || '';
      if (!raw) return resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: '无地址' });
      try {
        const isWs = /^wss?:\/\//i.test(raw);
        const url = new URL(isWs ? raw : (raw.includes('://') ? raw : `http://${raw}`));
        const hostname = url.hostname;
        const port = url.port || (isWs && url.protocol === 'wss:' ? 443 : isWs ? 80 : 8822);
        const mod = (url.protocol === 'wss:' || url.protocol === 'https:') ? https : http;
        const req = mod.request({
          hostname,
          port,
          path: '/health',
          method: 'GET',
          timeout: 5000,
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += String(c); });
          res.on('end', () => {
            try {
              const info = JSON.parse(body);
              const version = info.channel_version || info.version || null;
              const ok = Boolean(version && versionAtLeast(version, REQUIRED_CHANNEL_VERSION));
              resolve({
                version,
                required: REQUIRED_CHANNEL_VERSION,
                ok,
                needsRedeploy: Boolean(version && !ok),
                error: null
              });
            } catch (e) {
              resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: '返回不是 JSON' });
            }
          });
        });
        req.on('error', (e) => resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: e.message || '请求失败' }));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: '探测超时' }); });
        req.end();
      } catch (e) {
        resolve({ version: null, required: REQUIRED_CHANNEL_VERSION, ok: false, needsRedeploy: false, error: e.message || '地址解析失败' });
      }
    });
  }

  /** 切换激活连接，并预载到 this.connection，随后 resume 即可直连。 */
  setActiveProfile(id) {
    if (!this.store.setActive) throw new Error('存储不可用');
    this.store.setActive(id);
    this.connection = this.store.load();
    return this.connection;
  }

  /** 删除一个已保存连接；若删的是当前激活项，自动回落到下一个。 */
  removeProfile(id) {
    if (!this.store.removeProfile) throw new Error('存储不可用');
    const removed = this.store.removeProfile(id);
    if (this.connection && this.store._idFor(this.connection) === id) {
      this.connection = this.store.load();
    }
    return { removed, activeId: this.store.listProfiles().activeId };
  }

  disconnect() {
    this.abort();
    if (this.channel) { this.channel.close(); this.channel = null; }
    // 多连接场景：断开只结束当前会话，保留已保存的连接（profile），
    // 方便在连接页直接切换 / 重连，不用每次重填主机与 Key。
    // 历史不清零：重连后从落盘恢复，保证连续对话体验。
    this.connection = null;
    this.brain = null;
    this.gateway = null;
    this.session = null;
    this.lastGatewayError = null;
    this.workspace = null;
    this.tools = null;
    this.memory = null;
    this.skills = null;
    this.loop = null;
    this.logger.info('disconnected');
    return { cleared: false };
  }

  clearCache() {
    this.abort();
    if (this.channel) { this.channel.close(); this.channel = null; }
    // 彻底清除所有缓存文件
    const appData = this.store.dir || app.getPath('userData');
    const fs = require('fs');
    const path = require('path');
    const dirs = ['gateway-cache', 'logs', 'memory', 'persona', 'skills', 'history'];
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
    this.agentMessages.clear();
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
