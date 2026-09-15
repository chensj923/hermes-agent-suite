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

/**
 * 本客户端依赖的服务端通道最低版本。
 *
 * 服务端 buddy-channel.py 升级后必须重新部署，否则客户端会连上一个「能力残缺」的
 * 服务端（例如不认识 list_models，模型下拉只剩默认那一个）。与其静默降级，
 * 不如在握手时就把版本谈清楚：不满足就断开并明确提示重新部署。
 * 加新协议能力（新的消息类型）时记得同步抬这个版本号。
 */
const REQUIRED_CHANNEL_VERSION = '1.2';

/** 解析 "1.1" / "1" / "v2.0.3" 这类版本号，取 major.minor 比较。 */
function parseVersion(value) {
  const m = /^v?(\d+)(?:\.(\d+))?/.exec(String(value || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0) };
}

/** have >= want ? */
function versionAtLeast(have, want) {
  const h = parseVersion(have);
  const w = parseVersion(want);
  if (!h || !w) return false;   // 解析不出来（老服务端没带版本）按「不满足」处理
  if (h.major !== w.major) return h.major > w.major;
  return h.minor >= w.minor;
}

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
    this.pendingModels = null; // 当前 list_models 的 { resolve, reject }
    this.serverVersion = '';   // 服务端 welcome 里声明的通道版本
    this._welcomed = false;    // 是否已收到 welcome（决定断连时该 resolve 还是 reject）
    this.outdated = null;      // 版本不满足时置为 { server, required }，此时通道已断开
    this._rejectOpen = null;   // 握手阶段主动失败（如版本过旧）用
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
      req.on('upgrade', (res, socket, head) => {
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
          // welcome 到达时由 _onMessage 触发 resolve。必须在消费 head 之前挂上：
          // 否则 welcome 走 head 路径时没人接，resolve 永远不会触发（握手超时）。
          this._resolveOpen = () => { if (!settled) { settled = true; resolve(); } };
          this._rejectOpen = (e) => { if (!settled) { settled = true; reject(e); } };
          // 关键：Node 会把紧跟在 101 握手响应后面「已经到达」的字节放进 head，
          // 而不会走 data 事件。服务端 welcome 发得快时（同一 TCP 段）就会命中这里。
          // 忽略 head → welcome 帧被丢弃 → 表现为随机的「握手超时（未收到 welcome）」。
          if (head && head.length) this._onData(head);
          socket.on('close', () => this._onClose());
          socket.on('error', (e) => { this.logger.warn('channel-socket-error', { error: e.message }); this._onClose(); });
          // TCP keep-alive: 防止空闲时 socket 被中间设备关闭
          try { socket.setKeepAlive(true, 5000); } catch (_) {}
          // WS 层心跳：每 25 秒发一个 ping，防止 NAT/代理把长连接当空闲连接掐掉
          this._startHeartbeat();
          this.send({ type: 'hello', client: 'buddy', version: '1', capabilities: ['tool_execute'] });
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
      this._welcomed = true;
      this.sessionId = msg.session;
      // 能力协商：服务端版本不够就直接断开，不做静默降级。
      const serverVersion = msg.channel_version || msg.version || '';
      this.serverVersion = String(serverVersion);
      if (!versionAtLeast(serverVersion, REQUIRED_CHANNEL_VERSION)) {
        this.outdated = { server: this.serverVersion || '未知', required: REQUIRED_CHANNEL_VERSION };
        const err = new Error(
          `服务端通道版本过旧（${this.serverVersion || '未知'}），当前客户端需要 ${REQUIRED_CHANNEL_VERSION} 及以上。` +
          '请在 Buddy 里对这台服务器重新执行一次部署（或到服务器上重跑 deploy.sh），再重新连接。'
        );
        err.code = 'channel_outdated';
        // 先 reject 再 close：close() 内部走 _onClose()，那里会调 _resolveOpen()，
        // 顺序反了就会「通道已关但连接被当成成功」。
        if (this._rejectOpen) this._rejectOpen(err);
        try { this.close(); } catch (_) {}
        return;
      }
      if (this._resolveOpen) this._resolveOpen();
      return;
    }
    if (msg.type === 'models') {
      // list_models 的应答：服务端从上游 /models 拉到的真实模型清单
      if (this.pendingModels) {
        const p = this.pendingModels;
        this.pendingModels = null;
        p.resolve(Array.isArray(msg.models) ? msg.models : []);
      }
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
      // 服务端会给结构化 code（如 model_unsupported）和给用户的建议 hint
      const text = [msg.message, msg.hint].filter(Boolean).join('\n');
      this.emit({ type: 'error', message: text, code: msg.code, hint: msg.hint });
      if (this.pendingModels) {
        const pm = this.pendingModels;
        this.pendingModels = null;
        pm.reject(new Error(msg.message || '获取模型列表失败'));
      }
      if (this.pendingTask) {
        const p = this.pendingTask;
        this.pendingTask = null;
        const err = new Error(text);
        if (msg.code) err.code = msg.code;
        p.reject(err);
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
  /** 版本已判定不满足时快速失败，别再走一次注定失败的握手。 */
  _assertUsable() {
    if (!this.outdated) return;
    const err = new Error(
      `服务端通道版本过旧（${this.outdated.server}），当前客户端需要 ${this.outdated.required} 及以上。` +
      '请在 Buddy 里对这台服务器重新执行一次部署（或到服务器上重跑 deploy.sh），再重新连接。'
    );
    err.code = 'channel_outdated';
    throw err;
  }

  async sendMessage(text, history, opts = {}) {
    this._assertUsable();
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
      this.send({
        type: 'user_message',
        session: this.sessionId,
        text: String(text || ''),
        history: history || [],
        ...(opts && opts.model ? { model: String(opts.model) } : {}),
      });
    });
  }

  /**
   * 向服务端要模型清单。服务端会去上游（buddy-proxy.env / config.yaml 指向的
   * OpenAI 兼容端点）拉 /models，失败则用 config.yaml 里声明的模型名兜底。
   *
   * 这样通道模式（没有 HTTP 推理端点可打）也能拿到真实可选模型，
   * 而不是只能显示连接配置里那个写死的默认模型。
   */
  async listModels(opts = {}) {
    this._assertUsable();
    await this.connect();
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 15000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (fn) => (arg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pendingModels = null;
        fn(arg);
      };
      this.pendingModels = { resolve: finish(resolve), reject: finish(reject) };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingModels = null;
        reject(new Error('获取模型列表超时（服务端 15 秒无响应）'));
      }, timeoutMs);
      this.send({ type: 'list_models', session: this.sessionId });
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
    // 握手完成前断连必须 reject：之前这里无条件 resolve，导致「连不上」被当成连上了，
    // 后续发消息才暴露问题（表现为莫名其妙的失败）。
    if (this._welcomed) {
      if (this._resolveOpen) this._resolveOpen();
    } else if (this._rejectOpen) {
      this._rejectOpen(new Error('通道在握手完成前断开（服务端未返回 welcome）'));
    }
  }

  close() {
    this._onClose();
    try { if (this.socket) this.socket.destroy(); } catch (_) {}
  }
}

module.exports = { ChannelClient, maskFrame, decodeFrames };
