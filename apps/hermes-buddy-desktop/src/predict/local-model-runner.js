'use strict';

/**
 * 本地多模态模型运行器（纯 JS，零 Electron 依赖，node 下可测）。
 *
 * 职责：把「截图 + 行为上下文」送给一个本地 llama.cpp llama-server 进程，
 * 拿到结构化的「意图 + 置信度」JSON。不引入 node-llama-cpp 这类原生 addon——
 * llama.cpp 以受管子进程（llama-server.exe）方式启动，通过 OpenAI 兼容
 * HTTP 接口（/v1/chat/completions）通信，彻底规避 Electron ABI 重编问题。
 *
 * 生命周期：
 *   - 首次 analyze 时惰性 start（拉起子进程、轮询 /health 直到就绪）
 *   - 进程常驻；调用方在「长时间无触发」时主动 stop() 释放显存/内存
 *   - stop 先 SIGTERM，3s 不退再 SIGKILL
 *
 * 可测试性：所有外部依赖（二进制路径、模型路径、端口、logger）通过构造参数
 * 注入。单测用内置 http server 监听指定端口，手动 this.started=true 后直接
 * analyze，即可验证 HTTP 交互与 JSON 解析，无需真实 llama-server 二进制。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const { setTimeout: sleep } = require('timers/promises');

const DEFAULT_PORT = 8877;
// v4.8.9：Qwen2.5-VL-3B（1.8GB）+ mmproj（0.8GB）冷加载在机械盘/占用高的机器上
// 可达 60s+，原 60s 窗口会让预热白白失败。放宽到 120s。
const READY_TIMEOUT_MS = 120 * 1000;
const INFER_TIMEOUT_MS = 30 * 1000;
const KILL_GRACE_MS = 3000;

/**
 * 引导模型的系统提示词。要求它输出固定的 JSON 结构，字段与 behavior-engine
 * 的规则名对齐（intent ∈ 规则名 | none）。temperature 低、要求稳定 JSON。
 */
const SYSTEM_PROMPT = [
  '你是 Hermes Buddy 的本地助手，运行在用户电脑上，负责判断「用户此刻是否卡住了、需要怎样的帮助」。',
  '你只能看到一帧屏幕截图和一组行为元数据（窗口类别、按键/停顿节奏、鼠标停留、剪贴板类型与长度、最近窗口序列）。',
  '你绝对看不到任何文本、密码、聊天内容。请基于可见的 UI 结构推断意图。',
  '',
  '请只输出一个 JSON 对象，不要任何额外文字或解释。结构如下：',
  '{',
  '  "intent": "word_writing" | "data_entry" | "collecting_material" | "api_lookup" | "reading_or_thinking" | "none",',
  '  "confidence": 0.0 到 1.0 之间的数字，表示你判断的把握',
  '  "suggestion": "一句给用户的具体可操作建议（中文，≤40 字）；若 none 则为空字符串",',
  '  "reason": "一句简短的推断依据（中文，≤30 字）",',
  '  "observation": "屏幕可见内容的客观文字描述（中文，≤120 字）。这份描述会被发给远端的纯文本模型，',
  '                 它可能完全没有视觉能力，所以要把「屏幕上正在做什么」写清楚。',
  '                 第一句必须先点名「屏幕最前面的活动窗口」是什么：具体到应用名，',
  '                 如 WPS 文字 / Microsoft Word / 记事本 / Chrome / VSCode / Windows 任务视图 / 开始菜单 / 桌面；',
  '                 如果前台是文档编辑器且页面里有文字内容，必须明确写「正在文档中写作」，',
  '                 并带上可见的标题或正文主题。然后再写光标附近的内容状态、是否有报错/空白。',
  '                 不要写推测结论，只写看得见的事实。"',
  '}',
  'intent 含义：',
  '  word_writing      在写长文/文档，可能卡在措辞',
  '  data_entry        在填表格/录数据，可能卡在某个字段',
  '  collecting_material 在浏览器复制大段资料，可能在整理素材',
  '  api_lookup        在 IDE 里反复切窗口查文档/报错，可能在调接口或排错',
  '  reading_or_thinking 长时间停在某编辑区没动，可能在思考或读内容',
  '  none              无明显卡顿，不要打扰',
].join('\n');

/**
 * v4.10.0：纯描述提示词。
 *
 * 背景：不能假设服务端一定有多模态模型——很多部署（纯文本 LLM、coding 模型）
 * 收到图片会直接报「Model only support text input」。因此截图一律先由本机的
 * 视觉模型转成一段文字描述，服务端只做纯文本推理。
 *
 * 与 SYSTEM_PROMPT 的区别：这里不要 JSON、不要意图判断，只让模型客观描述
 * 屏幕上有什么，输出自由度更高、描述更完整。
 */
const DESCRIBE_PROMPT = [
  '你是运行在用户本机上的视觉描述助手。你会看到一张屏幕截图。',
  '请用中文客观描述「用户此刻正在做什么」，供另一台没有视觉能力的文本模型据此给出建议。',
  '要求：',
  '1. 第一句必须先说明屏幕最前面的活动窗口是什么应用：具体到应用名，',
  '   如 WPS 文字 / Microsoft Word / 记事本 / Chrome / VSCode / Windows 任务视图 / 开始菜单 / 桌面；',
  '2. 如果前台是文档编辑器且页面里有文字内容，必须明确写「正在文档中写作」，并带上可见的标题或正文主题；',
  '3. 只描述画面上真实可见的信息，不要臆测、不要编造看不见的文字；',
  '4. 再补充：光标附近正在写的内容到哪一步了、是否出现报错信息/空白/未完成的句子/重复操作痕迹；',
  '5. 不要输出任何建议，不要输出 JSON，直接输出 2~4 句中文，控制在 120 字以内；',
  '6. 涉及隐私（密码框、私人聊天内容）时只写类型不写具体内容。',
].join('\n');

class LocalModelRunner {
  constructor({
    llamaServerPath, modelPath, mmprojPath,
    host = '127.0.0.1', port = DEFAULT_PORT,
    logger, extraArgs = [],
  } = {}) {
    this.llamaServerPath = llamaServerPath;
    this.modelPath = modelPath;
    this.mmprojPath = mmprojPath;
    this.host = host;
    this.port = port;
    this.logger = logger || { log() {}, warn() {}, error() {} };
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.proc = null;
    this.started = false;
    this._exiting = false;
  }

  get baseUrl() { return `http://${this.host}:${this.port}`; }

  /** 启动 llama-server 子进程并等待就绪。已在运行则直接返回。 */
  async start({ readyTimeoutMs = READY_TIMEOUT_MS, ctxSize = 4096 } = {}) {
    if (this.proc && !this.proc.killed) return true;
    if (!this.llamaServerPath) throw new Error('缺少 llama-server 可执行文件（请先安装/配置引擎）');
    if (!this.modelPath || !require('fs').existsSync(this.modelPath)) {
      throw new Error('缺少 VLM 模型文件：' + this.modelPath);
    }

    const args = [
      '-m', this.modelPath,
      '--host', this.host,
      '--port', String(this.port),
      '--ctx-size', String(ctxSize),
      // v4.8.9：llama-server 没有 --nobrowser 这个参数，传了会
      //   "error: invalid argument: --nobrowser" 并立刻 exit(1)，
      // 导致本地 VLM 永远起不来、hybrid 模式每次都 cold 走远端。此处移除。
    ];
    if (this.mmprojPath && require('fs').existsSync(this.mmprojPath)) {
      args.push('--mmproj', this.mmprojPath);
    }
    args.push(...this.extraArgs);

    // v4.8.8：控制器注入的 logger 只有 info/warn/error/debug，没有 log；
    // 这里曾直接调 this.logger.log 导致 start() 必抛、本地模型永远无法预热（hybrid 永远走远端）。
    (this.logger.info || this.logger.log || this.logger.warn).call(
      this.logger,
      '[runner] 启动 llama-server: ' + this.llamaServerPath + ' (port ' + this.port + ')'
    );
    this._exiting = false;
    this.proc = spawn(this.llamaServerPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (d) => {
      const s = d.toString();
      if (/error|fail|exception/i.test(s)) this.logger.warn('[runner:stdout] ' + s.trim());
    });
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.logger.warn('[runner:stderr] ' + s);
    });
    this.proc.on('exit', (code, signal) => {
      this.started = false;
      if (!this._exiting) {
        this.logger.warn('[runner] llama-server 意外退出 code=' + code + ' signal=' + signal);
      }
    });
    this.proc.on('error', (err) => {
      this.logger.error('[runner] 启动失败: ' + err.message);
    });

    await this._waitReady(readyTimeoutMs);
    this.started = true;
    return true;
  }

  /** 轮询 /health（失败后回退 /）直到就绪或超时。超时则停掉进程并抛错。 */
  async _waitReady(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this._health()) return;
      await sleep(500);
    }
    await this.stop();
    throw new Error('llama-server 启动超时（' + (ms / 1000) + 's 内未就绪）');
  }

  async _health() {
    try {
      const r = await this._http('GET', '/health', null, 3000);
      if (r.status === 200) return true;
    } catch (_) {}
    try {
      const r2 = await this._http('GET', '/', null, 3000);
      return r2.status === 200;
    } catch (_) {
      return false;
    }
  }

  /**
   * 核心：分析一帧 + 行为上下文。
   * @param {object}  opts
   * @param {string}  [opts.imageBase64]  截图 base64（PNG/JPEG，无 data: 前缀）
   * @param {object}  [opts.behaviorContext] 行为元数据（透传给 engine）
   * @param {string}  [opts.userPrompt]  追加的用户侧描述
   * @param {number}  [opts.temperature]
   * @param {number}  [opts.maxTokens]
   * @returns {object|null} { intent, confidence, suggestion, reason, behaviorContext } 或 null（解析失败）
   */
  async analyze({
    imageBase64, behaviorContext, userPrompt,
    temperature = 0.2, maxTokens = 512, inferTimeoutMs = INFER_TIMEOUT_MS,
  } = {}) {
    if (!this.started) await this.start();

    const text = (userPrompt || '') +
      '\n\n行为上下文（JSON）：\n' + JSON.stringify(behaviorContext || {});

    const content = [{ type: 'text', text }];
    if (imageBase64) {
      content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } });
    }
    const body = {
      model: 'local-vlm',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    };

    const res = await this._http('POST', '/v1/chat/completions', body, inferTimeoutMs);
    const payload = (res && res.body) || {};
    const raw = payload.choices && payload.choices[0] && payload.choices[0].message &&
      payload.choices[0].message.content;
    return this._parseResult(raw, behaviorContext);
  }

  /**
   * v4.10.0：把一帧截图「翻译」成客观文字描述，交给远端的纯文本模型。
   *
   * 为什么需要：服务端部署的模型未必支持多模态（实测 volcengine-coding 直接报
   * 「Model only support text input」，纯文本 LLM 更不用说）。与其要求每个客户的
   * 服务端都配视觉模型，不如在本机用 VL 模型把图读成文字——截图不出本机，
   * 服务端只收到一段话，纯文本模型即可完成推理。
   *
   * @returns {string} 描述文本；无图 / 解析失败返回空串（调用方据此决定是否降级）。
   */
  async describe({
    imageBase64, behaviorContext,
    temperature = 0.2, maxTokens = 320, inferTimeoutMs = INFER_TIMEOUT_MS,
  } = {}) {
    if (!imageBase64) return '';
    if (!this.started) await this.start();

    const hint = behaviorContext && behaviorContext.rule
      ? '（行为线索：' + behaviorContext.rule + '）' : '';
    const content = [
      { type: 'text', text: '请描述这张截图里用户正在做什么。' + hint },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } },
    ];
    const body = {
      model: 'local-vlm',
      messages: [
        { role: 'system', content: DESCRIBE_PROMPT },
        { role: 'user', content },
      ],
      temperature,
      max_tokens: maxTokens,
    };
    try {
      const res = await this._http('POST', '/v1/chat/completions', body, inferTimeoutMs);
      const payload = (res && res.body) || {};
      const raw = payload.choices && payload.choices[0] && payload.choices[0].message &&
        payload.choices[0].message.content;
      return this._cleanDescription(raw);
    } catch (e) {
      (this.logger.warn || this.logger.error || function () {}).call(
        this.logger, '[runner] 屏幕描述失败: ' + (e && e.message)
      );
      return '';
    }
  }

  /** 清洗描述文本：剥代码围栏与常见前缀，限长，避免模型把整段 JSON 吐出来。 */
  _cleanDescription(raw) {
    if (typeof raw !== 'string') return '';
    let t = raw.trim();
    const fence = t.match(/```(?:json|text|md)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    t = t.replace(/^(描述|截图描述|画面描述|屏幕描述)\s*[:：]\s*/, '');
    return t.slice(0, 500).trim();
  }

  /** 把模型原始文本解析为结构化结果；容忍 ```json 围栏。失败返回 null。 */
  _parseResult(raw, behaviorContext) {
    if (typeof raw !== 'string') return null;
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      this.logger.warn('[runner] 模型返回不是合法 JSON');
      return null;
    }
    const conf = typeof obj.confidence === 'number' ? obj.confidence
      : (typeof obj.score === 'number' ? obj.score : 0);
    const intent = obj.intent || obj.category || 'none';
    return {
      intent: typeof intent === 'string' ? intent : 'none',
      confidence: Math.max(0, Math.min(1, conf)),
      suggestion: obj.suggestion || obj.action || '',
      reason: obj.reason || '',
      // v4.10.0：本机视觉模型对屏幕的文字描述，供「没有视觉能力」的远端纯文本模型使用
      observation: typeof obj.observation === 'string' ? obj.observation : '',
      behaviorContext,
    };
  }

  /** 终止子进程（SIGTERM → 宽限 → SIGKILL）。 */
  async stop() {
    this._exiting = true;
    const p = this.proc;
    this.proc = null;
    this.started = false;
    if (!p || p.exitCode !== null) return;
    try { p.kill('SIGTERM'); } catch (_) {}
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(); }, KILL_GRACE_MS);
      p.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  /** 找到一个空闲端口（port 传 0 时由 start 调用）。 */
  async _pickPort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
  }

  /** 极简 HTTP 客户端（不依赖 fetch/node-fetch，Electron 自带 node 有 http）。 */
  _http(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request({
        host: this.host,
        port: this.port,
        path,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: timeoutMs,
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let parsed = null;
          if (buf && /application\/json/.test(res.headers['content-type'] || '')) {
            try { parsed = JSON.parse(buf); } catch (_) {}
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('HTTP 超时')); });
      if (data) req.write(data);
      req.end();
    });
  }
}

module.exports = { LocalModelRunner, SYSTEM_PROMPT, DESCRIBE_PROMPT, DEFAULT_PORT };
