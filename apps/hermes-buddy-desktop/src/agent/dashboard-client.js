'use strict';

/**
 * Buddy 侧 HTTP Dashboard 工具通道客户端（零依赖）。
 *
 * 与 ChannelClient（WS）职责完全一致：连服务端、发用户消息、收 tool_request
 * 在本地执行、回传 tool_result、收 assistant 文本和 done。
 * 区别是不走 WebSocket，而是标准 HTTP 请求 + 轮询（poll）事件流：
 *
 *   1. POST   /api/buddy/session          -> 创建会话，拿到 sessionId
 *   2. POST   /api/buddy/session/{id}/chat -> 发用户消息，拿到 taskId
 *   3. GET    /api/buddy/session/{id}/events?since=N  -> 轮询事件流
 *      事件类型与 WS 帧完全一致：welcome, status, assistant_chunk,
 *      tool_request, task_done, error, ping
 *   4. POST   /api/buddy/session/{id}/tool_result/{toolId} -> 回传工具结果
 *
 * 这个设计的好处：
 *   · 不需要 WS 长连接 -- 穿透反向代理 / CDN / nginx 更可靠
 *   · 和官方 Hermes Desktop 连 Dashboard 后端的方式一致（HTTP REST）
 *   · Docker 环境里只需暴露 HTTP 端口，不用处理 WS upgrade
 *
 * 服务端侧：buddy-channel.py 可同时暴露 WS（:8822）和 HTTP（:9119）两种端点，
 * 或单独跑一个 HTTP wrapper。客户端不关心服务端怎么实现，只管 HTTP 约定。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const POLL_INTERVAL_MS = 800;     // 事件轮询间隔
const POLL_TIMEOUT_MS = 120000;   // 单次轮询最长等待
const REQUEST_TIMEOUT = 30000;    // 普通 HTTP 请求超时

class DashboardClient {
  constructor({ url, token = '', tools, logger, emit, onConfirm, autoConfirm = true }) {
    if (!url) throw new Error('缺少 Dashboard 后端地址');
    if (!tools) throw new Error('缺少 tools');
    this.url = String(url).trim().replace(/\/$/, '');
    this.token = String(token || '').trim();
    this.tools = tools;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.onConfirm = onConfirm;
    this.autoConfirm = autoConfirm;

    this.connected = false;
    this.closed = false;
    this.sessionId = null;
    this.eventSeq = 0;            // 轮询游标
    this.pollTimer = null;
    this.pendingTask = null;      // { resolve, reject }
    this._toolInFlight = false;
  }

  /** 发一个 HTTP 请求，返回 { statusCode, headers, body }。 */
  _request(method, pathname, body) {
    const u = new URL(this.url);
    if (u.pathname && u.pathname !== '/' && pathname.startsWith('/')) {
      pathname = u.pathname.replace(/\/$/, '') + pathname;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let data = null;
    if (body !== undefined) data = Buffer.from(JSON.stringify(body));

    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: pathname,
        method,
        headers,
        timeout: REQUEST_TIMEOUT,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf-8') });
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP 请求超时')); });
      req.on('error', (e) => reject(e));
      if (data) req.write(data);
      req.end();
    });
  }

  _json(response) {
    if (!response.body) return null;
    try { return JSON.parse(response.body); } catch (_) { return null; }
  }

  /** 连接：创建会话 */
  async connect() {
    if (this.connected) return;
    const res = await this._request('POST', '/api/buddy/session', { client: 'buddy', version: '1', capabilities: ['tool_execute'] });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`Dashboard 会话创建失败：HTTP ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
    const data = this._json(res) || {};
    this.sessionId = data.session || data.sessionId || data.id;
    if (!this.sessionId) throw new Error('Dashboard 后端未返回会话 ID');
    this.connected = true;
    this.logger.info('dashboard-connected', { url: this.url, session: this.sessionId });
    // 启动事件轮询
    this._startPolling();
  }

  _startPolling() {
    this._stopPolling();
    const poll = () => {
      if (this.closed || !this.connected) return;
      this._pollOnce().catch((e) => {
        this.logger.warn('dashboard-poll-error', { error: e.message });
      });
    };
    poll(); // 立即跑一次
    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }

  _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  async _pollOnce() {
    const since = this.eventSeq;
    const res = await this._request('GET', `/api/buddy/session/${this.sessionId}/events?since=${since}`);
    if (res.statusCode === 404) {
      // 会话不存在（可能服务端重启了）
      this._onClose();
      return;
    }
    if (res.statusCode !== 200) {
      this.logger.warn('dashboard-poll-bad-status', { statusCode: res.statusCode });
      return;
    }
    const data = this._json(res);
    if (!data || !Array.isArray(data.events)) return;
    for (const ev of data.events) {
      if (ev.seq && ev.seq > this.eventSeq) this.eventSeq = ev.seq;
      this._onEvent(ev);
    }
  }

  _onEvent(ev) {
    const type = ev.type;
    if (type === 'welcome') {
      // 已在 connect 里处理
      return;
    }
    if (type === 'ping') return;
    if (type === 'assistant_chunk' || type === 'text') {
      this.emit({ type: 'text', text: ev.text });
      return;
    }
    if (type === 'status') {
      this.emit({ type: 'status', text: ev.text, turn: ev.turn });
      return;
    }
    if (type === 'tool_request') {
      this._handleTool(ev);
      return;
    }
    if (type === 'task_done' || type === 'done') {
      this.emit({ type: 'done', text: ev.text, turns: ev.turns, stopped: ev.stopped });
      if (this.pendingTask) {
        const p = this.pendingTask; this.pendingTask = null;
        p.resolve({ text: ev.text, turns: ev.turns, stopped: ev.stopped });
      }
      return;
    }
    if (type === 'error') {
      this.emit({ type: 'error', message: ev.message });
      if (this.pendingTask) {
        const p = this.pendingTask; this.pendingTask = null;
        p.reject(new Error(ev.message));
      }
      return;
    }
  }

  async _handleTool(msg) {
    const id = msg.id;
    const tool = msg.tool;
    const params = msg.params || {};
    this.emit({ type: 'tool_start', id, name: tool, args: params });
    this._toolInFlight = true;
    const started = Date.now();
    let pendingOutput = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pendingOutput) return;
      const chunk = pendingOutput; pendingOutput = '';
      this.emit({ type: 'tool_output', id, name: tool, chunk });
    };
    try {
      const outcome = await this.tools.invoke(tool, params, {
        signal: null,
        onData: ({ chunk }) => {
          pendingOutput += chunk;
          if (!timer) timer = setTimeout(flush, 200);
        },
        onConfirm: (request) => (this.autoConfirm
          ? Promise.resolve(true)
          : (typeof this.onConfirm === 'function' ? this.onConfirm(request) : Promise.resolve(false))),
      });
      if (timer) { clearTimeout(timer); flush(); }
      const durationMs = Date.now() - started;
      this.emit({ type: 'tool_result', id, name: tool, ok: outcome.ok, durationMs, text: outcome.text, blocked: outcome.blocked });
      // 回传结果给服务端
      const payload = outcome.blocked
        ? { type: 'tool_rejected', id, reason: outcome.text }
        : { type: 'tool_result', id, ok: outcome.ok, text: outcome.text, exit_code: (outcome.data && outcome.data.exitCode) };
      try {
        await this._request('POST', `/api/buddy/session/${this.sessionId}/tool_result/${id}`, payload);
      } catch (e) {
        this.logger.warn('dashboard-tool-result-failed', { id, error: e.message });
      }
    } catch (error) {
      if (timer) { clearTimeout(timer); flush(); }
      const message = (error && error.message) || String(error);
      this.emit({ type: 'tool_result', id, name: tool, ok: false, text: `执行失败: ${message}` });
      try {
        await this._request('POST', `/api/buddy/session/${this.sessionId}/tool_result/${id}`, { type: 'tool_result', id, ok: false, text: `执行失败: ${message}` });
      } catch (_) {}
    } finally {
      this._toolInFlight = false;
    }
  }

  /** 发一条用户消息，返回任务结束后的结果。 */
  async sendMessage(text, history, opts = {}) {
    await this.connect();
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 10 * 60 * 1000;
    const res = await this._request('POST', `/api/buddy/session/${this.sessionId}/chat`, {
      text: String(text || ''),
      history: history || [],
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`发送消息失败：HTTP ${res.statusCode}`);
    }
    const data = this._json(res) || {};
    // 有些后端会在响应体里直接返回 done（同步模式），有些返回 taskId（异步模式）。
    if (data.done || data.text) {
      this.emit({ type: 'done', text: data.text || '', turns: data.turns || 0, stopped: data.stopped });
      return { text: data.text || '', turns: data.turns || 0, stopped: data.stopped };
    }
    // 异步模式：靠轮询事件拿到 task_done / error
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (fn) => (arg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pendingTask = null;
        fn(arg);
      };
      this.pendingTask = { resolve: finish(resolve), reject: finish(reject) };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.pendingTask = null;
          reject(new Error('Dashboard 连接超时（服务端 10 分钟无响应）'));
        }, timeoutMs);
      }
    });
  }

  abort() {
    if (!this.sessionId || !this.connected) return;
    this._request('POST', `/api/buddy/session/${this.sessionId}/cancel`, {}).catch(() => {});
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this._stopPolling();
    this.logger.warn('dashboard-closed', { hadPending: !!this.pendingTask, toolInFlight: this._toolInFlight });
    if (this.pendingTask) {
      const p = this.pendingTask; this.pendingTask = null;
      const msg = this._toolInFlight
        ? 'Dashboard 连接已断开（工具执行中中断，请手动重试以避免重复执行）'
        : 'Dashboard 连接已断开';
      p.reject(new Error(msg));
    }
  }

  close() {
    this._onClose();
  }
}

module.exports = { DashboardClient };
