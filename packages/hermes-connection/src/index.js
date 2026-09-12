'use strict';

const { consumeEventStream, extractTextDelta, classifyEvent, SseParser } = require('./sse');

const DEFAULT_TIMEOUT_MS = 15000;
// Hermes api_server 的存活探测历史上落在 /health，网关文档里写的是 /api/health。
// 客户端不猜，两个都探一遍，命中后记住。
const HEALTH_PATHS = Object.freeze(['/health', '/api/health']);

class GatewayError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code || GatewayError.codeFromStatus(status);
  }

  static codeFromStatus(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not_found';
    if (typeof status === 'number' && status >= 500) return 'server';
    if (typeof status === 'number') return 'http';
    return 'invalid';
  }
}

function normalizeGatewayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new GatewayError('Hermes 地址不能为空');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  // 'ws://' 之类被补成 'http://ws://…' 后仍能被 URL 接受，所以先自己判协议。
  if (scheme && !/^https?$/i.test(scheme[1])) throw new GatewayError('Hermes 地址必须是 HTTP 或 HTTPS');
  let url;
  try {
    url = new URL(scheme ? raw : `http://${raw}`);
  } catch (_) {
    throw new GatewayError(`Hermes 地址无法解析: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new GatewayError('Hermes 地址必须是 HTTP 或 HTTPS');
  if (url.search || url.hash) throw new GatewayError('Hermes 地址不能带查询参数或锚点');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function assertSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new GatewayError('会话 ID 非法');
  return value;
}

/** 把 AbortSignal 与超时合成到一个 controller 上，Node 18/20/22 与 Electron 表现一致。 */
function createLinkedController(externalSignal) {
  const controller = new AbortController();
  if (!externalSignal) return { controller, dispose() {} };
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return { controller, dispose() {} };
  }
  const forward = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener('abort', forward, { once: true });
  return { controller, dispose() { externalSignal.removeEventListener('abort', forward); } };
}

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 20 || error.code === 'ABORT_ERR');
}

class GatewayClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeGatewayUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.healthPath = null;
    if (!this.apiKey) throw new GatewayError('API Key 不能为空');
    if (typeof this.fetch !== 'function') throw new GatewayError('当前运行时不支持网络请求');
  }

  headers(extra) {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(extra || {}) };
  }

  /** 发起请求并保证异常都是 GatewayError；raw=true 时返回原始响应（供 SSE 使用）。 */
  async send(path, { raw = false, signal, timeoutMs, ...options } = {}) {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;
    const { controller, dispose } = createLinkedController(signal);
    let timedOut = false;
    const timer = limit > 0
      ? setTimeout(() => { timedOut = true; controller.abort(new GatewayError('请求超时', undefined, 'timeout')); }, limit)
      : null;

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: this.headers(options.headers)
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      dispose();
      if (timedOut) throw new GatewayError(`Hermes 在 ${limit} 毫秒内没有响应`, undefined, 'timeout');
      if (isAbortError(error)) throw new GatewayError('请求已取消', undefined, 'aborted');
      throw new GatewayError(`无法连接 Hermes: ${error && error.message ? error.message : error}`, undefined, 'network');
    }

    if (raw) {
      // 流式响应：响应头到手就解除超时，剩下的生命周期交给调用方的 signal。
      if (timer) clearTimeout(timer);
      if (!response.ok) {
        const detail = await this.readErrorDetail(response);
        dispose();
        throw new GatewayError(detail, response.status);
      }
      return { response, dispose };
    }

    try {
      const body = await response.text();
      let data = body;
      try { data = body ? JSON.parse(body) : {}; } catch (_) {}
      if (!response.ok) {
        throw new GatewayError(
          (data && (data.detail || data.error || data.message)) || `Gateway 请求失败 (${response.status})`,
          response.status
        );
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
      dispose();
    }
  }

  async readErrorDetail(response) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    try {
      const parsed = body ? JSON.parse(body) : null;
      if (parsed && (parsed.detail || parsed.error || parsed.message)) return parsed.detail || parsed.error || parsed.message;
    } catch (_) {}
    return body ? body.slice(0, 300) : `Gateway 请求失败 (${response.status})`;
  }

  /** 兼容旧调用点：request 依旧返回解析后的 JSON。 */
  request(path, options = {}) { return this.send(path, options); }

  /** 存活探测：/health 与 /api/health 任一通过即算连通。 */
  async health() {
    const paths = this.healthPath ? [this.healthPath] : HEALTH_PATHS;
    let lastError = null;
    for (const path of paths) {
      try {
        const data = await this.send(path);
        this.healthPath = path;
        return { ...(typeof data === 'object' && data ? data : { raw: data }), endpoint: path };
      } catch (error) {
        lastError = error;
        // 只有"这个端点不存在"才继续换路径；鉴权失败、网络不通都应立刻报出去。
        if (error.code !== 'not_found') break;
      }
    }
    throw lastError || new GatewayError('健康检查失败');
  }

  createSession(profile, extra) {
    // Gateway 的 _expected_api_key() 对命名 profile（如 "buddy"）会从 secret_scope
    // 取 API_SERVER_KEY，而不是从环境变量取。这导致环境变量里的 Key 和 profile-scoped
    // 的 Key 不一致时返回 401。解决方案：createSession 不传 profile（走 default 路径，
    // 用环境变量里的 API_SERVER_KEY 鉴权），profile 信息靠 Buddy 侧自行管理。
    return this.send('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // model 缺失会被 Gateway 判成 401，属于服务端硬约束。
      body: JSON.stringify({ model: 'hermes-agent', ...(extra || {}) })
    });
  }

  async listSessions() {
    const data = await this.send('/api/sessions');
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.sessions)) return data.sessions;
    return [];
  }

  buildChatPayload({ message, model, workdir, systemMessage, stream }) {
    const text = String(message == null ? '' : message);
    if (!text.trim()) throw new GatewayError('消息内容不能为空');
    const payload = { message: text };
    if (model) payload.model = String(model);
    if (workdir) payload.workdir = String(workdir);
    if (systemMessage) payload.system_message = String(systemMessage);
    if (stream !== undefined) payload.stream = Boolean(stream);
    return payload;
  }

  /** 非流式对话，用于脚本化调用与自检。参数校验失败也走 rejection，调用方只需 catch 一处。 */
  async chat(sessionId, options = {}) {
    const id = assertSessionId(sessionId);
    return this.send(`/api/sessions/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildChatPayload({ ...options, stream: false })),
      timeoutMs: options.timeoutMs
    });
  }

  /**
   * 流式对话。onEvent 收到语义化事件：
   *   { kind: 'text' | 'tool' | 'permission' | 'error' | 'meta' | 'done', text, payload }
   * 返回聚合后的完整文本，便于主进程落库或做失败重试。
   */
  async streamChat(sessionId, options = {}) {
    const id = assertSessionId(sessionId);
    const { onEvent, signal } = options;
    const { response, dispose } = await this.send(`/api/sessions/${id}/chat`, {
      raw: true,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(this.buildChatPayload({ ...options, stream: true })),
      signal
    });

    const contentType = String((response.headers && response.headers.get && response.headers.get('content-type')) || '');
    let text = '';
    const emit = (kind, event, chunk) => {
      if (typeof onEvent === 'function') onEvent({ kind, text: chunk || '', payload: (event && event.json) || null, raw: (event && event.raw) || '' });
    };

    try {
      if (!contentType.includes('text/event-stream')) {
        // 服务端降级成一次性 JSON：照样把正文交给同一个回调，UI 不需要分支。
        const body = await response.text();
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (_) {}
        const single = extractTextDelta({ json: parsed, event: 'message' });
        text = single || (typeof parsed === 'string' ? parsed : (parsed && (parsed.reply || parsed.content || parsed.message)) || body || '');
        if (text) emit('text', { json: parsed, raw: body }, text);
        emit('done', { json: parsed, raw: body });
        return { text, streamed: false };
      }

      await consumeEventStream(response.body, (event) => {
        const kind = classifyEvent(event);
        if (kind === 'text') {
          const chunk = extractTextDelta(event);
          text += chunk;
          emit('text', event, chunk);
          return;
        }
        emit(kind, event);
      });
      return { text, streamed: true };
    } catch (error) {
      if (isAbortError(error)) throw new GatewayError('对话已中断', undefined, 'aborted');
      throw error instanceof GatewayError ? error : new GatewayError(`读取回复流失败: ${error.message}`, undefined, 'stream');
    } finally {
      dispose();
    }
  }

  /** 模型清单：Gateway 侧不可用时退回 hermes-agent，保证 UI 有可选项。 */
  async listModels() {
    try {
      const data = await this.send('/v1/models');
      const list = Array.isArray(data) ? data : (data && data.data) || [];
      const ids = list.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean);
      return ids.length ? ids : ['hermes-agent'];
    } catch (_) {
      return ['hermes-agent'];
    }
  }
}

/** 把 GatewayError 翻成给用户看的一句话。 */
function describeGatewayError(error) {
  if (!error) return '未知错误';
  const code = error.code || GatewayError.codeFromStatus(error.status);
  switch (code) {
    case 'unauthorized': return 'API Key 无效或没有权限，请检查 ~/.hermes/data/.env 中的 API_SERVER_KEY';
    case 'timeout': return 'Hermes 没有在预期时间内响应，请确认网关进程和端口可达';
    case 'network': return '网络不可达，请确认地址、端口和防火墙设置';
    case 'not_found': return '接口不存在，请确认 Hermes 网关版本';
    case 'server': return 'Hermes 网关内部错误，请查看服务端日志';
    case 'aborted': return '操作已取消';
    default: return error.message || '请求失败';
  }
}

module.exports = {
  GatewayClient,
  GatewayError,
  normalizeGatewayUrl,
  describeGatewayError,
  assertSessionId,
  SseParser,
  extractTextDelta,
  classifyEvent,
  consumeEventStream,
  DEFAULT_TIMEOUT_MS,
  HEALTH_PATHS
};
