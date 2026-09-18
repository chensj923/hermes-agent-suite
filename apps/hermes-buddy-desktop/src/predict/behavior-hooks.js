'use strict';

/**
 * 行为钩子输入层（Electron 主进程专用）。
 *
 * 职责：把操作系统级输入事件（键盘节奏、鼠标、剪贴板、前台窗口切换）归一化成
 * behavior-engine 能消费的「行为元数据」事件，再喂给引擎。绝不接收任何文本/密码——
 * 引擎入口只接受 windowClass / 节奏 / 鼠标停留 / 剪贴板类型与长度，隐私边界在入口守住。
 *
 * 钩子后端可插拔：
 *   - 默认 IohookBackend：用 @tkomde/iohook 捕获全局键鼠事件（仅节奏/时间戳，不记内容）。
 *   - @tkomde/iohook 是 wilix-team/iohook 的活跃 fork，支持 Electron 29-39 (ABI 127)，
 *     提供预编译 win32 x64 二进制；原版 wilix-team/iohook 只到 Electron 12 已废弃。
 *
 * 杀软拦截（全功能无降级）：
 *   - 安装时用户已显式授权才启用（config.authorized === true）。
 *   - 检测在跑的杀软（Defender / 火绒 / 360）；Defender 用 PowerShell 加排除区，
 *     火绒/360 引导手动加。不满足则整体不启用，不存在「降为无键盘」的退化路径。
 */

const { execFile, execFileSync } = require('child_process');

// ---- 杀软检测 ----

/** 已知杀软特征（进程名 / 服务名）。命中即认为在跑。 */
const AV_SIGNATURES = {
  defender: {
    name: 'Windows Defender',
    exclusive: false,
    detect: () => defenderEnabled(),
  },
  huorong: {
    name: '火绒安全 (Huorong)',
    exclusive: true,
    detect: () => processExists(['HipsDaemon.exe', 'wsctrlsvc.exe', 'hipsmain.exe']),
  },
  qihoo360: {
    name: '360 安全卫士',
    exclusive: true,
    detect: () => processExists(['360tray.exe', '360Safe.exe', '360sd.exe']),
  },
};

function processExists(names) {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 })
      .toString('utf8').toLowerCase();
    return names.some((n) => out.includes(n.toLowerCase()));
  } catch (_) {
    return false;
  }
}

function defenderEnabled() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-MpComputerStatus).AMServiceEnabled",
    ], { windowsHide: true, timeout: 8000 }).toString('utf8').trim().toLowerCase();
    return out === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * 检测在跑的杀软列表（纯函数，便于单测注入 execFileSync）。
 * @returns {Array<{key:string,name:string,exclusive:boolean}>}
 */
function detectAntivirus({ execSync = execFileSync } = {}) {
  const results = [];
  for (const [key, sig] of Object.entries(AV_SIGNATURES)) {
    let hit = false;
    try { hit = Boolean(sig.detect()) || false; } catch (_) { hit = false; }
    if (hit) results.push({ key, name: sig.name, exclusive: sig.exclusive });
  }
  return results;
}

/**
 * 给 Defender 添加排除路径（仅 Defender 支持命令行排除）。
 * 返回 Promise<{ok:boolean, message:string}>。
 */
function addDefenderExclusion(appPath, { exec = execFile } = {}) {
  return new Promise((resolve) => {
    const ps = `(Add-MpPreference -ExclusionPath '${String(appPath).replace(/'/g, "''")}') 2>&1 | Out-String`;
    exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, message: '添加 Defender 排除区失败：' + (err.message || err) });
        } else {
          resolve({ ok: true, message: '已添加 Defender 排除区：' + appPath });
        }
      });
  });
}

// ---- iohook 后端 ----

/**
 * iohook 后端：全局键鼠钩子。
 * 仅记录节奏（时间戳）与鼠标位置/停留，绝不记录按键内容。
 * windowId → windowClass 的解析由外部 resolveWindow 负责（需要 Win32 调用，
 * 默认实现可能为空，详见 controller 的 getWindowInfo 注入）。
 */
class IohookBackend {
  constructor({ logger, resolveWindow } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.resolveWindow = resolveWindow || (async () => null);
    this.iohook = null;
    this._timer = null;
    this._lastWindow = null;
    this._mouseIdleTimer = null;
    this._lastActivity = Date.now();
    this._handlers = { keydown: [], mousemove: [], mousedown: [], clipboard: [] };
  }

  async _load() {
    if (this.iohook) return this.iohook;
    let mod;
    try {
      // @tkomde/iohook 是 wilix-team/iohook 的活跃 fork，支持 Electron 29-39 (ABI 127)。
      // 它导出一个单例 iohook 对象（而非构造函数），API 与原版兼容：
      //   mod.on('keydown', ...) / mod.start() / mod.stop()
      // 预编译二进制通过 package.json 的 "iohook" 配置块指定 targets/platforms/arches。
      // 加载失败（ABI 不匹配 / 预编译缺失）则抛错，由上层决定是否启用（无降级）。
      mod = require('@tkomde/iohook');
      // @tkomde/iohook 导出形如 { iohook } 或直接是 iohook 对象，兼容两种
      this.iohook = (mod && mod.iohook) ? mod.iohook : mod;
    } catch (e) {
      const err = new Error('iohook 加载失败（可能与当前 Electron 版本不兼容）：' + e.message);
      err.code = 'iohook_unavailable';
      throw err;
    }
    return this.iohook;
  }

  _onKeydown(ev) {
    // ev 只含 keycode / type / windowId / time；不暴露字符。
    this._lastActivity = Date.now();
    this._emit('keydown', { windowId: ev.windowId });
  }

  _onMousemove(ev) {
    const now = Date.now();
    if (now - this._lastActivity > 0) this._lastActivity = now;
    // 鼠标移动即代表用户活跃；停留由轮询器在「无移动 N 秒」时计算。
  }

  _onMousedown(ev) {
    this._lastActivity = Date.now();
    this._emit('mousedown', { windowId: ev.windowId, button: ev.button });
  }

  _emit(type, payload) {
    for (const h of this._handlers[type] || []) {
      try { h(payload); } catch (e) { this.logger.warn('hook-handler-error', { type, error: e.message }); }
    }
  }

  /** 启动轮询：前台窗口切换检测 + 鼠标停留计时。 */
  _startPolling() {
    // 每 800ms 检测一次前台窗口是否变化（仅靠 iohook 无法稳定拿到 windowClass）。
    this._timer = setInterval(async () => {
      try {
        const info = await this.resolveWindow();
        if (info && info.windowClass && info.windowClass !== this._lastWindow) {
          this._lastWindow = info.windowClass;
          this._emit('window_change', { windowClass: info.windowClass, title: info.title, exeName: info.exeName });
        }
      } catch (_) { /* 解析失败不影响钩子 */ }
    }, 800);

    // 鼠标停留：连续 1.5s 无键鼠活动即视为「编辑区停留」（配合 rule5）。
    this._mouseIdleTimer = setInterval(() => {
      const idle = Date.now() - this._lastActivity;
      if (idle >= 1500) this._emit('mouse_idle', { idleMs: idle });
    }, 1500);
  }

  on(type, handler) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(handler);
  }

  async start() {
    const mod = await this._load();
    mod.on('keydown', (e) => this._onKeydown(e));
    mod.on('mousemove', (e) => this._onMousemove(e));
    mod.on('mousedown', (e) => this._onMousedown(e));
    mod.start(false); // false = 不禁用输入事件重放
    this._startPolling();
    this.logger.info('iohook-started');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._mouseIdleTimer) { clearInterval(this._mouseIdleTimer); this._mouseIdleTimer = null; }
    try { if (this.iohook) this.iohook.stop(); } catch (_) {}
    this.iohook = null;
  }
}

// ---- 钩子编排 ----

/**
 * 创建行为钩子编排器。
 * @param {object} opts
 * @param {object} opts.config        PredictConfig
 * @param {object} opts.engine        BehaviorEngine
 * @param {object} opts.db            BehaviorDB
 * @param {object} opts.logger
 * @param {function} opts.resolveWindow  async () => {windowClass,title,exeName}|null
 * @param {function} opts.onTrigger    (result) => void  引擎命中规则时回调（控制器接管截图/模型/浮窗）
 * @param {object}  [opts.backend]     可注入的钩子后端（测试用 FakeBackend）
 */
function createBehaviorHooks({ config, engine, db, logger, resolveWindow, onTrigger, backend } = {}) {
  if (!config) throw new Error('createBehaviorHooks 需要 config');
  if (!engine) throw new Error('createBehaviorHooks 需要 engine');
  logger = logger || { info() {}, warn() {}, error() {} };

  const be = backend || new IohookBackend({ logger, resolveWindow });
  let running = false;

  // 把 iohook 原始事件归一化为引擎事件
  be.on('keydown', (_p) => {
    if (!running) return;
    const r = engine.handleEvent({ type: 'keypress' });
    _maybeTrigger(r);
  });
  be.on('mousedown', (_p) => {
    if (!running) return;
    const r = engine.handleEvent({ type: 'tick' });
    _maybeTrigger(r);
  });
  be.on('window_change', (p) => {
    if (!running) return;
    const r = engine.handleEvent({ type: 'window_change', windowClass: p.windowClass });
    _maybeTrigger(r);
  });
  be.on('mouse_idle', (p) => {
    if (!running) return;
    const r = engine.handleEvent({ type: 'mouse', mouseIdleMs: p.idleMs, inEditArea: true });
    _maybeTrigger(r);
  });

  function _maybeTrigger(r) {
    if (r && r.shouldScreenshot && typeof onTrigger === 'function') {
      onTrigger(r);
    }
  }

  return {
    backend: be,
    get running() { return running; },

    /** 启动钩子。未授权则拒绝（全功能无降级）。 */
    async start() {
      if (!config.get('authorized')) {
        throw new Error('预测模式未授权：请在安装时授予钩子权限');
      }
      if (!config.get('enabled')) {
        throw new Error('预测模式未启用');
      }
      await be.start();
      running = true;
      logger.info('behavior-hooks-started');
    },

    stop() {
      be.stop();
      running = false;
      logger.info('behavior-hooks-stopped');
    },
  };
}

module.exports = {
  IohookBackend,
  createBehaviorHooks,
  detectAntivirus,
  addDefenderExclusion,
  AV_SIGNATURES,
};
