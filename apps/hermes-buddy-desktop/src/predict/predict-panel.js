'use strict';

/**
 * 预测浮窗（Electron 主进程专用）。
 *
 * 一个 frameless / transparent / alwaysOnTop 的 BrowserWindow，出现在桌宠旁，
 * 以「聊天小框」形式实时展示预测流水线的每一步：触发 → 捕获目标窗口 → 截图 →
 * 本机 VL 读图 → 远端推理 → 生成 → 插入/粘贴。每一步带状态与提示，窗口可滚动、
 * 不自动消失（用户点 × 才关闭），便于实时看清「远端有没有回馈 / 要不要手动粘贴 /
 * 本机 VL 有没有响应」。
 *
 * 安全：浮窗只经 IPC 与主进程通信，永远不直连远端、不持有 API Key。
 * 用户决策通过 predict-panel:decision 回传主进程，由控制器交给 action-executor 执行。
 *
 * 浮窗窗口常驻（懒创建），show()/pushStep() 幂等：多次触发复用同一窗口，避免反复创建开销。
 */

const path = require('path');

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* node 环境 */ }

const PANEL_WIDTH = 384;
const PANEL_HEIGHT = 240;            // 保留给锚定单测的定位数学（垂直居中基准），实际窗口更高
// v4.10.40：步骤面板更高、主体可滚动
const PANEL_STEP_WIDTH = 384;
const PANEL_STEP_HEIGHT = 480;
const PANEL_STEP_HEIGHT_TOPIC = 560;
// v4.10.27：带主题输入框时要高一些（多一行提示 + 一个输入框）
const SUGGEST_TIMEOUT_MS = 10000;   // 用户 10s 不点 = 视为「稍后」
// v4.10.27：需要手填主题时给足输入时间，别 10s 就把浮窗收了
const TOPIC_TIMEOUT_MS = 90000;
// v4.9.0：hybrid 时间预算 = 本地筛选 18s + 远端推断最长 30s ≈ 48s；
// 控制器 30s 超时仍会先降级，这里 45s 只是最后兜底（v4.8.9 实测 23s 会在
// 远端正常推理中途掐断弹窗，造成「思考半天然后超时」）。
const THINKING_TIMEOUT_MS = 45000;

class PredictPanel {
  /**
   * @param {object} opts
   * @param {object} [opts.logger]
   * @param {string} [opts.preloadPath]
   * @param {function} [opts.anchorProvider] ()=>({x,y,width,height})|null
   *   返回桌宠 bounds 时，浮层优先弹在桌宠旁边（而不是鼠标旁）。
   */
  constructor({ logger, preloadPath, anchorProvider, onThinkingTimeout } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.preloadPath = preloadPath || path.join(__dirname, 'predict-panel-preload.js');
    this.anchorProvider = anchorProvider || null;
    this.onThinkingTimeout = onThinkingTimeout || null;
    this.win = null;
    this._ready = false;
    this._pending = null;     // { resolve }
    this._timeout = null;
    this._thinkingTimeout = null;
    this._flowSeq = 0;        // v4.10.40：每轮流水线一个序号，步骤按它命名空间，跨轮累加不覆盖
    this._setupIpc();
  }

  _setupIpc() {
    if (!_electron || this._ipcReady) return;
    const { ipcMain } = _electron;
    ipcMain.on('predict-panel:decision', (_event, payload) => {
      const choice = (payload && payload.choice) || 'later';
      // v4.10.27：浮窗带主题输入框时把用户输入一并回传。
      // 没有 topic（旧协议/普通场景）就 resolve 字符串，保持向后兼容。
      const topic = (payload && typeof payload.topic === 'string') ? payload.topic.trim() : '';
      this._resolve(topic ? { choice, topic } : choice);
    });
    // v4.10.40：用户点 × 主动关闭浮窗（只隐藏，不重置流水线状态；流水线仍在跑，
    // 后续步骤仍会推回——但窗口已关，用户可重新触发再开）。
    ipcMain.on('predict-panel:close', () => { this._hide(); });
    this._ipcReady = true;
  }

  get available() { return !!_electron; }

  _createWindow() {
    const { BrowserWindow, screen } = _electron;
    const win = new BrowserWindow({
      width: PANEL_STEP_WIDTH,
      height: PANEL_STEP_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.loadFile(path.join(__dirname, 'predict-panel.html'));
    win.on('closed', () => { this.win = null; this._ready = false; });
    win._isBuddyFloating = true; // 截图时只隐藏悬浮窗，不隐藏主窗口
    return win;
  }

  async _ensureReady() {
    if (this.win && this._ready) return this.win;
    if (!this.win) this.win = this._createWindow();
    if (!this._ready) {
      await new Promise((resolve) => {
        this.win.webContents.once('did-finish-load', () => { this._ready = true; resolve(); });
      });
    }
    return this.win;
  }

  /**
   * 定位浮窗：桌宠可见时弹在猫咪旁边（优先右侧，放不下换左侧，再放不下贴屏幕边缘）；
   * 否则跟旧行为一样弹在鼠标旁。两种来源都 clamp 到屏幕可用区内。
   */
  _position(win, height) {
    const { screen } = _electron;
    const h = height || PANEL_HEIGHT;
    let anchor = null;
    if (this.anchorProvider) {
      try { anchor = this.anchorProvider(); } catch (_) { anchor = null; }
    }
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      const disp = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
      const area = disp.workArea;
      let x = anchor.x + anchor.width + 12;
      let y = anchor.y + (anchor.height - h) / 2;
      if (x + PANEL_STEP_WIDTH > area.x + area.width) x = anchor.x - PANEL_STEP_WIDTH - 12;
      if (x < area.x) x = area.x;
      if (y + h > area.y + area.height) y = area.y + area.height - h;
      if (y < area.y) y = area.y;
      win.setPosition(Math.round(x), Math.round(y));
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(cursor);
    const area = disp.workArea;
    let x = cursor.x + 16;
    let y = cursor.y + 16;
    if (x + PANEL_STEP_WIDTH > area.x + area.width) x = cursor.x - PANEL_STEP_WIDTH - 16;
    if (y + h > area.y + area.height) y = cursor.y - h - 16;
    x = Math.max(area.x, Math.min(x, area.x + area.width - PANEL_STEP_WIDTH));
    y = Math.max(area.y, Math.min(y, area.y + area.height - h));
    win.setPosition(Math.round(x), Math.round(y));
  }

  /** 确保窗口存在并可见、置顶（供 pushStep / showThinking / show 复用）。 */
  _showWindow(win, height) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true);
      this._position(win, height);
      win.show();
      win.moveTop();
    } catch (e) {
      this.logger.warn('predict-panel-show-failed', { error: e.message });
      try { win.show(); } catch (_) {}
    }
  }

  _resolve(choice) {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    const p = this._pending;
    this._pending = null;
    // v4.10.40：决策后只收起确认卡片（让用户看清已处理），不再隐藏整个浮窗——
    // 用户要求步骤面板常驻、不自动消失。
    if (this.win) {
      try { this.win.webContents.send('predict-panel:card-hide'); } catch (_) {}
    }
    if (p) p.resolve(choice);
  }

  /**
   * v4.10.40：开新一轮流水线——序号 +1 并推一条分隔步骤。步骤按 flowSeq 命名空间，
   * 跨轮累加（聊天小框观感），不互相覆盖。
   * @param {string} [label]
   */
  beginFlow(label) {
    if (!_electron) return;
    this._flowSeq += 1;
    this._pushRaw('__flow__', {
      title: label || ('第 ' + this._flowSeq + ' 轮预测'),
      status: 'info',
    });
  }

  /**
   * v4.10.40：追加/更新一条步骤。同一 flowSeq 内相同 id 会原地更新（如 vl 从
   * pending→done），跨轮自动追加。窗口懒创建并立即可见。
   * @param {string} id 步骤标识（同轮内用于去重更新）
   * @param {{title?:string,status?:string,detail?:string}} opts
   */
  pushStep(id, opts = {}) {
    const key = this._flowSeq + ':' + (id || 'step');
    this._pushRaw(key, {
      title: opts.title || '',
      status: opts.status || 'pending',
      detail: opts.detail || '',
    });
  }

  _pushRaw(key, payload) {
    if (!_electron) return;
    Promise.resolve()
      .then(() => this._ensureReady())
      .then((win) => {
        this._showWindow(win);
        try { win.webContents.send('predict-panel:step', Object.assign({ id: key }, payload)); } catch (_) {}
      })
      .catch(() => {});
  }

  /** 清空步骤列表（保留窗口）。 */
  clearSteps() {
    if (!_electron || !this.win) return;
    try { this.win.webContents.send('predict-panel:clear'); } catch (_) {}
  }

  /**
   * v4.4：先弹一个「思考中」的加载态（转圈 loading，无按钮）。
   * 模型分析完后由 show() 复用同一窗口换成建议内容。不返回 Promise——不阻塞流水线。
   * v4.10.40：思考态作为一条常驻步骤（不自动消失），并保留顶部「思考中」横幅。
   */
  async showThinking(text) {
    if (!_electron) return;
    const win = await this._ensureReady();
    win.webContents.send('predict-panel:thinking', { text: text || '思考中…' });
    this._showWindow(win);
    // 同步推一条「思考中」步骤，保持步骤面板与横幅一致
    this.pushStep('thinking', { title: '思考中', status: 'pending', detail: text || '思考中…' });
    // 保险：分析卡死时通知控制器降级为规则模板弹窗，确保用户能看到输出。
    // v4.10.40：到点只触发降级回调，不再隐藏窗口（用户要求常驻）。
    this.armThinkingTimeout(THINKING_TIMEOUT_MS);
  }

  /**
   * v4.10.37：（重新）启动「思考安全网」。
   * 关键修复：showThinking() 在流水线一开始就按 45s 计时，但本机 VL 读图本身要
   * 14~27s，等请求真正发出时安全网只剩 18~31s，而服务端分析实测要 37~72s
   * → 正确结果总在最后一刻判超时丢弃。控制器在「服务端请求真正发出」那一刻
   * 用对齐 90s 的时长重新 arm，安全网就只覆盖真正的在途请求，不含本地 VL。
   */
  armThinkingTimeout(ms) {
    if (this._thinkingTimeout) clearTimeout(this._thinkingTimeout);
    const delay = Number.isFinite(ms) && ms > 0 ? ms : THINKING_TIMEOUT_MS;
    this._thinkingTimeout = setTimeout(() => this._fireThinkingTimeout(), delay);
  }

  _fireThinkingTimeout() {
    this._thinkingTimeout = null;
    if (this._pending) return;        // 已经在等用户决策，别误关
    this.logger.warn('predict-panel-thinking-timeout');
    if (typeof this.onThinkingTimeout === 'function') {
      try {
        const maybePromise = this.onThinkingTimeout();
        if (maybePromise && typeof maybePromise.then === 'function') maybePromise.catch(() => {});
      } catch (_) {}
    }
    // v4.10.40：不再自动隐藏窗口——降级后的建议/步骤仍留在面板，用户随时可见。
  }

  /**
   * 展示一条建议，返回用户决策的 Promise。
   * @param {object} suggestion { intent, suggestion, reason, confidence, action }
   * @returns {Promise<'generate'|'later'|'never'>}
   */
  async show(suggestion) {
    if (!_electron) return 'later';
    const win = await this._ensureReady();
    if (this._thinkingTimeout) { clearTimeout(this._thinkingTimeout); this._thinkingTimeout = null; }
    // v4.10.27：需要手填主题时窗口更高，且给用户充足的填写时间
    const needTopic = Boolean(suggestion && suggestion.needTopic);
    const height = needTopic ? PANEL_STEP_HEIGHT_TOPIC : PANEL_STEP_HEIGHT;
    try { win.setSize(PANEL_STEP_WIDTH, height); } catch (_) {}
    return new Promise((resolve) => {
      this._pending = { resolve };
      win.webContents.send('predict-panel:suggestion', suggestion);
      // 同轮推进：把确认卡片标记为一条「等待确认」步骤
      this.pushStep('decide', { title: '需要你确认', status: 'pending', detail: '是否生成并插入？（或手动填写主题）' });
      this._showWindow(win, height);
      this._timeout = setTimeout(() => this._resolve('later'), needTopic ? TOPIC_TIMEOUT_MS : SUGGEST_TIMEOUT_MS);
    });
  }

  /**
   * v4.9.1：流水线结束但决定不弹窗时，收走「思考中」横幅（窗口仍留着，步骤保留）。
   */
  cancelThinking() {
    if (this._thinkingTimeout) { clearTimeout(this._thinkingTimeout); this._thinkingTimeout = null; }
    if (this.win) {
      try { this.win.webContents.send('predict-panel:thinking-stop'); } catch (_) {}
    }
  }

  /**
   * v4.10.39：强制了结当前等待中的用户决策（按「稍后」），并收起确认卡片。
   * 场景路径的 panel.show() 因窗口创建/setSize 卡住被外层超时丢弃后，内部的
   * _pending 仍挂着——不清理会泄漏，且下一次 show() 会覆盖它，迟到的 settle
   * 还可能误关新窗口。这里统一收口；无等待时仅收卡片。窗口不隐藏。
   */
  dismissAwaiting() {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    if (this._thinkingTimeout) { clearTimeout(this._thinkingTimeout); this._thinkingTimeout = null; }
    if (this.win) {
      try { this.win.webContents.send('predict-panel:thinking-stop'); } catch (_) {}
      try { this.win.webContents.send('predict-panel:card-hide'); } catch (_) {}
    }
    const p = this._pending;
    this._pending = null;
    if (p) { try { p.resolve('later'); } catch (_) {} }
  }

  _hide() {
    if (this.win) { try { this.win.hide(); } catch (_) {} }
  }

  destroy() {
    this._resolve('later');
    if (this.win) { try { this.win.destroy(); } catch (_) {} this.win = null; this._ready = false; }
  }
}

module.exports = {
  PredictPanel,
  PANEL_WIDTH, PANEL_HEIGHT,
  PANEL_STEP_WIDTH, PANEL_STEP_HEIGHT, PANEL_STEP_HEIGHT_TOPIC,
  SUGGEST_TIMEOUT_MS, TOPIC_TIMEOUT_MS, THINKING_TIMEOUT_MS,
};
