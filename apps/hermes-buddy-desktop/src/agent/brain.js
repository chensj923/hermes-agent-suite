'use strict';

const { GatewayError } = require('@hermes/connection');

const DEFAULT_TIMEOUT_MS = 120000;
// Hermes 部署里 Gateway 在 22122、模型路由在 8800，填一个就能推出另一个。
const LLM_PORT_CANDIDATES = ['8800', '8000', '11434'];

class BrainError extends Error {
  constructor(message, code = 'brain_error', status = undefined) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 从 Gateway 地址推导 LLM 推理端点。
 * 用户只填一个地址是最省事的，但推导错了要能一眼看懂报错，所以保留原文兜底。
 */
function deriveLlmEndpoint(gatewayUrl, explicit) {
  const raw = String(explicit || '').trim();
  if (raw) return normalizeLlmEndpoint(raw);
  const source = String(gatewayUrl || '').trim();
  if (!source) throw new BrainError('缺少 Hermes 地址', 'missing_endpoint');
  let url;
  try { url = new URL(/^https?:\/\//i.test(source) ? source : `http://${source}`); } catch (_) {
    throw new BrainError(`Hermes 地址无法解析: ${source}`, 'invalid_endpoint');
  }
  const port = url.port || '22122';
  const next = LLM_PORT_CANDIDATES.includes(port) ? port : '8800';
  url.port = next;
  url.pathname = '/v1/chat/completions';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** 允许直接给到 /v1/chat/completions，也允许只给到主机根。 */
function normalizeLlmEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new BrainError('缺少推理端点', 'missing_endpoint');
  // 先自己判协议：'ftp://h' 被补成 'http://ftp://h' 后 URL 依然能解析，会悄悄放过。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new BrainError('推理端点必须是 HTTP 或 HTTPS', 'invalid_endpoint');
  let url;
  try { url = new URL(scheme ? raw : `http://${raw}`); } catch (_) {
    throw new BrainError(`推理端点无法解析: ${raw}`, 'invalid_endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BrainError('推理端点必须是 HTTP 或 HTTPS', 'invalid_endpoint');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1/chat/completions';
  return url.toString();
}

/** 解析 OpenAI 风格的 SSE：只关心 content 与 tool_calls 增量。 */
function parseCompletionSse(chunk, sink) {
  sink.buffer += chunk;
  const blocks = sink.buffer.split('\n\n');
  sink.buffer = blocks.pop() || '';
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return true;
      let json;
      try { json = JSON.parse(payload); } catch (_) { continue; }
      const choice = json && json.choices && json.choices[0];
      if (!choice) continue;
      if (choice.delta) applyDelta(sink, choice.delta);
      if (choice.finish_reason) sink.finishReason = choice.finish_reason;
    }
  }
  return false;
}

function applyDelta(sink, delta) {
  if (typeof delta.content === 'string' && delta.content) {
    sink.content += delta.content;
    if (sink.onText) sink.onText(delta.content);
  }
  if (!Array.isArray(delta.tool_calls)) return;
  for (const piece of delta.tool_calls) {
    const index = Number.isInteger(piece.index) ? piece.index : 0;
    const slot = sink.toolCalls[index] || (sink.toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
    if (piece.id) slot.id = piece.id;
    if (piece.function && piece.function.name) {
      slot.function.name += piece.function.name;
      if (sink.onToolName) sink.onToolName(index, slot.function.name);
    }
    if (piece.function && typeof piece.function.arguments === 'string') {
      slot.function.arguments += piece.function.arguments;
    }
  }
}

/**
 * 大模型客户端。buddy 只用它的"推理 + function calling"能力，
 * 工具执行一律在本地，所以这里刻意不接 Hermes 的服务端 agent 端点。
 */
class Brain {
  constructor({ endpoint, model = 'hermes-agent', apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.endpoint = normalizeLlmEndpoint(endpoint);
    this.model = String(model || 'hermes-agent');
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    if (typeof this.fetch !== 'function') throw new BrainError('当前运行时不支持网络请求', 'no_fetch');
  }

  headers() {
    const base = { 'Content-Type': 'application/json', Accept: 'application/json' };
    // 模型路由本身不校验，但保留头可以让需要鉴权的部署直接可用。
    if (this.apiKey) base.Authorization = `Bearer ${this.apiKey}`;
    return base;
  }

  /**
   * @param {object} options
   * @param {Array} options.messages OpenAI 消息数组
   * @param {Array} [options.tools] function-calling schema
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.stream]
   * @param {(text:string)=>void} [options.onText]
   * @returns {Promise<{ content: string, toolCalls: Array, finishReason: string|null, usage?: object }>}
   */
  async complete({ messages, tools, toolChoice = 'auto', signal, stream = false, onText, onToolName, temperature } = {}) {
    if (!Array.isArray(messages) || !messages.length) throw new BrainError('消息不能为空', 'empty_messages');
    const body = { model: this.model, messages, stream: Boolean(stream) };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = toolChoice; }
    if (typeof temperature === 'number') body.temperature = temperature;

    const controller = new AbortController();
    const forward = () => controller.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) throw new BrainError('请求已取消', 'aborted');
      signal.addEventListener('abort', forward, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new BrainError('模型响应超时', 'timeout')), this.timeoutMs);

    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
      if (signal && signal.aborted) throw new BrainError('已停止生成', 'aborted');
      if (error && error.name === 'AbortError') throw new BrainError(`模型在 ${Math.round(this.timeoutMs / 1000)} 秒内没有响应`, 'timeout');
      throw new BrainError(`无法连接 Hermes 推理服务: ${error && error.message ? error.message : error}`, 'network');
    }

    try {
      if (!response.ok) {
        const detail = await readError(response);
        throw new BrainError(`模型服务返回 ${response.status}: ${detail}`, mapStatus(response.status), response.status);
      }
      if (!stream) return await this.readJson(response);
      return await this.readStream(response, { onText, onToolName });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
    }
  }

  async readJson(response) {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new BrainError(`模型返回了无法解析的内容: ${text.slice(0, 200)}`, 'bad_response'); }
    const choice = data && data.choices && data.choices[0];
    if (!choice) throw new BrainError('模型没有返回任何结果', 'empty_response');
    return {
      content: (choice.message && choice.message.content) || '',
      toolCalls: normalizeToolCalls(choice.message),
      finishReason: choice.finish_reason || null,
      usage: data.usage || null
    };
  }

  async readStream(response, { onText, onToolName }) {
    if (!response.body) return this.readJson(response);
    const sink = { buffer: '', content: '', toolCalls: [], finishReason: null, onText, onToolName };
    const reader = response.body.getReader ? response.body.getReader() : null;
    const decoder = new TextDecoder('utf8');
    if (!reader) {
      // Node 的 fetch 流也可能是异步迭代器，两条路都兜一下。
      for await (const chunk of response.body) {
        if (parseCompletionSse(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), sink)) break;
      }
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (parseCompletionSse(decoder.decode(value, { stream: true }), sink)) break;
      }
    }
    return {
      content: sink.content,
      toolCalls: normalizeToolCalls({ tool_calls: sink.toolCalls.filter(Boolean) }),
      finishReason: sink.finishReason,
      usage: null
    };
  }

  /** 列出可用模型。这里是"尽力而为"：拿不到就退回当前模型，供 UI 下拉使用。 */
  async listModels() {
    try { return await this.fetchModels(); } catch (_) { return [this.model]; }
  }

  /** 严格的连通性检查：拿不到模型清单就抛错，用于连接校验。 */
  async assertReachable() {
    const models = await this.fetchModels();
    if (!models.length) throw new BrainError('推理服务没有返回任何可用模型', 'no_models');
    return models;
  }

  async fetchModels() {
    const base = new URL(this.endpoint);
    base.pathname = '/v1/models';
    base.search = '';
    let response;
    try {
      response = await this.fetch(base.toString(), { headers: this.headers() });
    } catch (error) {
      throw new BrainError(`无法连接 Hermes 推理服务: ${error && error.message ? error.message : error}`, 'network');
    }
    if (!response.ok) throw new BrainError(`模型服务返回 ${response.status}`, mapStatus(response.status), response.status);
    let data;
    try { data = await response.json(); } catch (_) { throw new BrainError('模型服务返回了无法解析的内容', 'bad_response'); }
    const list = Array.isArray(data) ? data : (data && data.data) || [];
    const ids = list.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean);
    return ids.length ? ids : [this.model];
  }
}

function normalizeToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call, index) => {
    const raw = (call && call.function && call.function.arguments) || '';
    let args = {};
    if (typeof raw === 'string') {
      try { args = raw.trim() ? JSON.parse(raw) : {}; } catch (_) { args = { _raw: raw }; }
    } else if (raw && typeof raw === 'object') {
      args = raw;
    }
    return {
      id: (call && call.id) || `call_${index}_${Date.now()}`,
      name: (call && call.function && call.function.name) || '',
      arguments: args
    };
  }).filter((call) => Boolean(call.name));
}

async function readError(response) {
  let text = '';
  try { text = await response.text(); } catch (_) { return `HTTP ${response.status}`; }
  try {
    const parsed = JSON.parse(text);
    const detail = parsed && (parsed.error && (parsed.error.message || parsed.error) || parsed.detail || parsed.message);
    if (typeof detail === 'string') return detail;
  } catch (_) { /* 不是 JSON */ }
  return text ? text.slice(0, 300) : `HTTP ${response.status}`;
}

function mapStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (typeof status === 'number' && status >= 500) return 'server';
  if (typeof status === 'number') return 'http';
  return 'invalid';
}

/** 把 BrainError 翻成用户能看懂的一句话。 */
function describeBrainError(error) {
  if (!error) return '未知错误';
  const code = error.code || mapStatus(error.status);
  switch (code) {
    case 'unauthorized': return 'Hermes 拒绝了这次请求，请检查 API Key';
    case 'timeout': return '模型响应超时，可以换个模型或稍后重试';
    case 'network': return '连不上 Hermes 推理服务，请确认地址和端口可达';
    case 'not_found': return '推理端点不存在，请检查地址';
    case 'server': return 'Hermes 推理服务内部错误，请查看服务端日志';
    case 'aborted': return '已停止';
    case 'bad_response': return '模型返回了异常内容，请确认推理端点是否为 OpenAI 兼容接口';
    default: return error.message || '请求失败';
  }
}

module.exports = {
  Brain,
  BrainError,
  describeBrainError,
  deriveLlmEndpoint,
  normalizeLlmEndpoint,
  parseCompletionSse,
  normalizeToolCalls,
  DEFAULT_TIMEOUT_MS,
  LLM_PORT_CANDIDATES
};

// GatewayError 仍在主进程其它链路上使用，这里一并保持引用清晰。
module.exports.GatewayError = GatewayError;
