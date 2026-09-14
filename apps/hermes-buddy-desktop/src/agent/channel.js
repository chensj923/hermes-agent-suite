'use strict';

/**
 * Buddy 侧 WS 工具通道客户端（零依赖）。
 *
 * 职责：连上服务端外挂通道（hermes-buddy-channel），把用户消息发过去，
 * 服务端跑 Agent 循环并把工具调用卸载到本机；客户端收到 tool_request 时
 * 过命令护栏后本地执行，把结果回传。决策在服务器，执行在本地。
 *
 * 事件形状与 AgentLoop 完全一致（status/text/tool_start/tool_output/tool_result/done/error/notice），
 * 因此 SessionManager.send() 可以直接把频道事件转发给渲染进程，UI 不用改。
 *
 * WS 实现：用 http 升级握手 + 手搓 RFC6455 帧（客户端发送需 mask），不引入 `ws` 依赖。
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function maskFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8');
  const len = data.length;
  let header;
  if (len <= 125) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7F;
    let idx = offset + 2;
    if (length === 126) { if (offset + 4 > buf.length) break; length = buf.readUInt16BE(idx); idx += 2; }
    else if (length === 127) { if (offset + 10 > buf.length) break; const hi = buf.readUInt32BE(idx); const lo = buf.readUInt32BE(idx + 4); length = hi * 2 ** 32 + lo; idx += 8; }
    let mask = null;
    if (masked) { if (idx + 4 > buf.length) break; mask = buf.slice(idx, idx + 4); idx += 4; }
    if (idx + length > buf.length) break;
    let payload = buf.slice(idx, idx + length);
    if (masked) { const out = Buffer.alloc(length); for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i % 4]; payload = out; }
    frames.push({ fin, opcode, payload });
    offset = idx + length;
  }
  return { frames, rest: buf.slice(offset) };
}

class ChannelClient {
  constructor({ url, token = '', tools, logger, emit, onConfirm, autoConfirm = true }) {
    if (!url) throw new Error('缺少通道地址');
    if (!tools) throw new Error('缺少 tools');
    this.url = String(url).trim();
    this.token = String(token || '').trim();
    this.tools = tools;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.onConfirm = onConfirm;
    this.autoConfirm = autoConfirm;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.sessionId = null;
    this.openPromise = null;
    this.pendingTask = null;   // 当前 user_message 的 { resolve, reject }
    this.fragmentOpcode = null;
    this.fragmentBuf = Buffer.alloc(0);
    this._toolInFlight = false;   // 是否有本地工具正在执行（用于断线安全判断）
  }

  connect() {
    if (this.connected || this.openPromise) return this.openPromise || Promise.resolve();
    const u = new URL(/^wss?:\/\//i.test(this.url) ? this.url : `ws://${this.url}`);
    const key = crypto.randomBytes(16).toString('base64');
    // 同时用 Authorization header 和 ?token= query string 传递 API Key，
    // 兼容服务端两种鉴权方式。
    let path = (u.pathname || '/');
    if (this.token) {
      const sep = path.includes('?') ? '&' : '?';
      path += `${sep}token=${encodeURIComponent(this.token)}`;
    }
    if (u.search) path += (path.includes('?') ? '&' : '?') + u.search.slice(1);
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    this.openPromise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'wss:' ? 443 : 80),
        path,
        headers,
        timeout: 10000,  // 10 秒内没收到 upgrade 就快速失败，不卡死
      });
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
      // HTTP 请求级超时：旧版服务端可能不回 upgrade 也不回 response
      req.on('timeout', () => {
        if (!settled) { settled = true; req.destroy(); reject(new Error('通道连接超时（10 秒内服务端未响应 WS 升级请求，可能服务端是旧版或端口不对）')); }
      });
      req.on('upgrade', (res, socket) => {
        // 关键：这里是事件回调，抛出的异常不会进 Promise 的 try/catch，
        // 会让 openPromise 永久悬挂（表现为"连接超时"而不是真实错误）。
        // 所以整个初始化过程必须包 try/catch，任何异常都要走 fail()。
        try {
          const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
          if (res.headers['sec-websocket-accept'] !== accept) {
            return fail(new Error('WS 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
          }
          this.socket = socket;
          this.connected = true;
          socket.on('data', (chunk) => this._onData(chunk));
          socket.on('close', () => this._onClose());
          socket.on('error', (e) => { this.logger.warn('channel-socket-error', { error: e.message }); this._onClose(); });
          // TCP keep-alive: 防止空闲时 socket 被中间设备关闭
          try { socket.setKeepAlive(true, 5000); } catch (_) {}
          // WS 层心跳：每 25 秒发一个 ping，防止 NAT/代理把长连接当空闲连接掐掉
          this._startHeartbeat();
          this.send({ type: 'hello', client: 'buddy', version: '1', capabilities: ['tool_execute'] });
          // welcome 到达时 resolve（由 _onMessage 触发）
          this._resolveOpen = () => { if (!settled) { settled = true; resolve(); } };
          // 超时兜底：8 秒内没收到 welcome 就报错
          setTimeout(() => { if (!settled) { settled = true; reject(new Error('通道握手超时（8 秒内未收到 welcome）')); } }, 8000);
        } catch (error) {
          this.logger.error('channel-upgrade-init-failed', { error: error.message });
          try { socket.destroy(); } catch (_) {}
          fail(new Error(`通道握手后初始化失败：${error.message}`));
        }
      });
      req.on('response', (res) => {
        fail(new Error(`通道握手被拒绝：HTTP ${res.statusCode}`));
      });
      req.on('error', (e) => fail(new Error(`连不上通道服务：${e.message}`)));
      req.end();
    });
    return this.openPromise;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { this._onClose(); return; }
      if (f.opcode === 0x9) { this._sendFrame(0xA, f.payload); continue; } // ping -> pong
      if (f.opcode === 0xA) continue; // pong
      let payload = f.payload;
      if (!f.fin) {
        // 分片：合并到 fragmentBuf，等 fin
        if (this.fragmentOpcode === null) this.fragmentOpcode = f.opcode;
        this.fragmentBuf = Buffer.concat([this.fragmentBuf, payload]);
        if (!f.fin) continue;
        payload = this.fragmentBuf; this.fragmentBuf = Buffer.alloc(0); this.fragmentOpcode = null;
      }
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        try { this._onMessage(JSON.parse(payload.toString('utf-8'))); } catch (e) { this.logger.warn('channel-bad-json', { error: e.message }); }
      }
    }
  }

  _onMessage(msg) {
    if (msg.type === 'welcome') {
      this.sessionId = msg.session;
      if (this._resolveOpen) this._resolveOpen();
      return;
    }
    if (msg.type === 'ping') { this._sendFrame(0x9, Buffer.alloc(0)); return; }
    if (msg.type === 'assistant_chunk') {
      this.emit({ type: 'text', text: msg.text });
      return;
    }
    if (msg.type === 'status') { this.emit({ type: 'status', text: msg.text, turn: msg.turn }); return; }
    if (msg.type === 'tool_request') { this._handleTool(msg); return; }
    if (msg.type === 'task_done') {
      this.emit({ type: 'done', text: msg.text, turns: msg.turns, stopped: msg.stopped });
      if (this.pendingTask) { const p = this.pendingTask; this.pendingTask = null; p.resolve({ text: msg.text, turns: msg.turns, stopped: msg.stopped }); }
      return;
    }
    if (msg.type === 'error') {
      this.emit({ type: 'error', message: msg.message });
      if (this.pendingTask) { const p = this.pendingTask; this.pendingTask = null; p.reject(new Error(msg.message)); }
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
    let aborted = false;
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
      if (outcome.blocked) {
        // 被命令护栏拦截：服务端会把它作为"失败的工具结果"回灌模型，让其换路。
        this.send({ type: 'tool_rejected', id, reason: outcome.text });
      } else {
        this.send({ type: 'tool_result', id, ok: outcome.ok, text: outcome.text, exit_code: (outcome.data && outcome.data.exitCode) });
      }
    } catch (error) {
      if (timer) { clearTimeout(timer); flush(); }
      const message = (error && error.message) || String(error);
      this.emit({ type: 'tool_result', id, name: tool, ok: false, text: `执行失败: ${message}` });
      this.send({ type: 'tool_result', id, ok: false, text: `执行失败: ${message}` });
    } finally {
      this._toolInFlight = false;
    }
  }

  send(obj) {
    if (!this.socket || this.closed) return;
    try { this.socket.write(maskFrame(0x1, JSON.stringify(obj))); } catch (e) { this.logger.warn('channel-send-failed', { error: e.message }); }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.closed) return;
    try { this.socket.write(maskFrame(opcode, payload)); } catch (_) {}
  }

  /** 发一条用户消息，返回任务结束后的结果（task_done）。
   *  opts.timeoutMs：整条消息的最长等待（默认 10 分钟），超时按"连接超时"处理，
   *  便于上层触发自动重连而不是无限卡死。 */
  async sendMessage(text, history, opts = {}) {
    await this.connect();
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 10 * 60 * 1000;
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
          reject(new Error('通道连接超时（服务端 10 分钟无响应）'));
        }, timeoutMs);
      }
      this.send({ type: 'user_message', session: this.sessionId, text: String(text || ''), history: history || [] });
    });
  }

  abort() {
    this.send({ type: 'cancel' });
  }

  /**
   * WS 层心跳：每 25 秒发一个 ping 帧，防止 NAT/代理把长连接当空闲连接掐掉。
   * 间隔必须小于常见的 60 秒 idle timeout。
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      if (this.closed || !this.connected) { this._stopHeartbeat(); return; }
      this._sendFrame(0x9, Buffer.alloc(0));   // ping
    }, 25000);
    // 心跳不该阻止进程退出
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.openPromise = null;   // 关键：置空后下一次 connect() 才会真正重建握手，而非复用已死的旧 promise
    this._stopHeartbeat();
    this.logger.warn('channel-closed', { hadPending: !!this.pendingTask, toolInFlight: this._toolInFlight });
    if (this.pendingTask) {
      const p = this.pendingTask;
      this.pendingTask = null;
      // 工具执行中途断开时不建议自动重发（会重复执行命令），用特定文案提示手动重试。
      const msg = this._toolInFlight
        ? '通道连接已断开（工具执行中中断，请手动重试以避免重复执行）'
        : '通道连接已断开';
      p.reject(new Error(msg));
    }
    if (this._resolveOpen) this._resolveOpen();
  }

  close() {
    this._onClose();
    try { if (this.socket) this.socket.destroy(); } catch (_) {}
  }
}

module.exports = { ChannelClient, maskFrame, decodeFrames };
