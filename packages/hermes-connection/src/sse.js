'use strict';

/**
 * Hermes api_server 的 chat 端点以 text/event-stream 返回增量事件。
 * 观察到的契约（见 workbuddy/server.js 的透传逻辑）：
 *   - 每个事件是 `data: <json>`，事件之间以空行分隔
 *   - 流结束可能出现哨兵 `data: [DONE]`
 *   - 事件对象形如 { type: 'hermes.tool.progress', data: { tool, status, label } }
 *   - 代理层可能注入 { type: 'hermes.permission.intercept', data: { blocked_command, reason } }
 * 文本增量的字段名在服务端尚未冻结，因此这里用容错提取（extractTextDelta），
 * 避免客户端因为一次服务端改名就完全收不到回复。
 */

const DONE_SENTINEL = '[DONE]';

function parseEventBlock(block) {
  const lines = String(block).split(/\r?\n/);
  const dataLines = [];
  let event = 'message';
  let id = null;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // 注释/心跳
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value || 'message';
    else if (field === 'id') id = value;
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  if (raw.trim() === DONE_SENTINEL) return { event, id, raw, done: true, json: null };
  let json = null;
  try { json = JSON.parse(raw); } catch (_) { json = null; }
  return { event, id, raw, done: false, json };
}

/** 增量 SSE 解析器：喂入任意切分的字符串块，吐出完整事件。 */
class SseParser {
  constructor() { this.buffer = ''; }

  push(chunk) {
    this.buffer += String(chunk);
    const separator = /\r?\n\r?\n/;
    const events = [];
    let match;
    while ((match = separator.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseEventBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** 流结束时调用，处理最后一个没有以空行收尾的事件块。 */
  flush() {
    const block = this.buffer;
    this.buffer = '';
    if (!block.trim()) return [];
    const parsed = parseEventBlock(block);
    return parsed ? [parsed] : [];
  }
}

function firstString(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * 从一个事件里提取可直接追加到气泡的文本增量。
 * 兼容 Hermes 原生字段与 OpenAI 风格 delta，未识别时返回空串。
 */
function extractTextDelta(event) {
  const payload = event && event.json;
  if (!payload || typeof payload !== 'object') return '';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const text = firstString(
    data.delta, data.text, data.content, data.message,
    payload.delta, payload.text, payload.content,
    choice && choice.delta && choice.delta.content,
    choice && choice.message && choice.message.content,
    choice && choice.text
  );
  if (!text) return '';
  const type = String(payload.type || event.event || '');
  // 工具进度/权限拦截等控制事件不是助手正文，交给 UI 单独展示。
  if (/tool|permission|error|usage|heartbeat/i.test(type)) return '';
  return text;
}

/** 把事件归类成 UI 需要的语义种类。 */
function classifyEvent(event) {
  if (event.done) return 'done';
  const type = String((event.json && event.json.type) || event.event || '');
  if (/permission/i.test(type)) return 'permission';
  if (/tool/i.test(type)) return 'tool';
  if (/error/i.test(type)) return 'error';
  return extractTextDelta(event) ? 'text' : 'meta';
}

/**
 * 读取 fetch 响应体并逐事件回调。
 * 同时支持 WHATWG ReadableStream（Electron / undici）与 Node 可迭代流。
 */
async function consumeEventStream(body, onEvent) {
  if (!body) throw new Error('响应没有可读取的流');
  const parser = new SseParser();
  const decoder = new TextDecoder('utf-8');
  const emit = (events) => { for (const event of events) onEvent(event); };
  const decode = (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        emit(parser.push(decode(value)));
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) emit(parser.push(decode(chunk)));
  } else {
    throw new Error('不支持的响应流类型');
  }
  emit(parser.flush());
}

module.exports = { SseParser, parseEventBlock, extractTextDelta, classifyEvent, consumeEventStream, DONE_SENTINEL };
