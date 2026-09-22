'use strict';

/**
 * 预测浮窗（Electron 主进程专用）。
 *
 * 一个 frameless / transparent / alwaysOnTop 的 BrowserWindow，出现在鼠标旁，
 * 展示「Hermes 觉得你可能需要…」的建议，让用户选：生成并插入 / 稍后 / 不再提示。
 *
 * 安全：浮窗只经 IPC 与主进程通信，永远不直连远端、不持有 API Key。
 * 用户决策通过 predict-panel:decision 回传主进程，由控制器交给 action-executor 执行。
 *
 * 浮窗窗口常驻（懒创建），show() 幂等：多次触发复用同一窗口，避免反复创建开销。
 */

const path = require('path');

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* node 环境 */ }

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 240;
// v4.10.27：带主题输入框时要高一些（多一行提示 + 一个输入框）
const PANEL_HEIGHT_TOPIC = 320;
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
    this._ipcReady = true;
  }

  get available() { return !!_electron; }

  _createWindow() {
    const { BrowserWindow, screen } = _electron;
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
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
      if (x + PANEL_WIDTH > area.x + area.width) x = anchor.x - PANEL_WIDTH - 12;
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
    if (x + PANEL_WIDTH > area.x + area.width) x = cursor.x - PANEL_WIDTH - 16;
    if (y + h > area.y + area.height) y = cursor.y - h - 16;
    x = Math.max(area.x, Math.min(x, area.x + area.width - PANEL_WIDTH));
    y = Math.max(area.y, Math.min(y, area.y + area.height - h));
    win.setPosition(Math.round(x), Math.round(y));
  }

  _resolve(choice) {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    const p = this._pending;
    this._pending = null;
    if (p) p.resolve(choice);
    this._hide();
  }

  /**
   * v4.4：先弹一个「思考中」的加载态浮窗（转圈 loading，无按钮）。
   * 模型分析完后由 show() 复用同一窗口换成建议内容。不返回 Promise——不阻塞流水线。
   */
  async showThinking(text) {
    if (!_electron) return;
    const win = await this._ensureReady();
    win.webContents.send('predict-panel:thinking', { text: text || '思考中…' });
    this._position(win);
    // 必须前置 + 聚焦，否则用户当前在其他窗口时看不到「思考中」提示
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true);
      win.show();
      win.focus();
      win.moveTop();
    } catch (e) {
      this.logger.warn('predict-panel-show-failed', { error: e.message });
      try { win.show(); } catch (_) {}
    }
    // 保险：分析卡死时不要让转圈窗口一直挂着。
    // v4.8.5：不再直接 hide，而是通知控制器降级为规则模板弹窗，确保用户能看到输出。
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
    // 给控制器 2s 时间切换成规则建议；若仍未进入建议态则兜底隐藏
    setTimeout(() => {
      if (!this._pending && !this._thinkingTimeout) this._hide();
    }, 2000);
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
    const height = needTopic ? PANEL_HEIGHT_TOPIC : PANEL_HEIGHT;
    try { win.setSize(PANEL_WIDTH, height); } catch (_) {}
    return new Promise((resolve) => {
      this._pending = { resolve };
      win.webContents.send('predict-panel:suggestion', suggestion);
      this._position(win, height);
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true);
        win.show();
        win.focus();
        win.moveTop();
      } catch (e) {
        this.logger.warn('predict-panel-show-failed', { error: e.message });
        try { win.show(); } catch (_) {}
      }
      this._timeout = setTimeout(() => this._resolve('later'), needTopic ? TOPIC_TIMEOUT_MS : SUGGEST_TIMEOUT_MS);
    });
  }

  /**
   * v4.9.1：流水线结束但决定不弹窗时，收走 thinking 态。
   * v4.9.0 实测 bug：远端结果成功返回但置信度没过门槛 → 不调 show() →
   * 「思考中」窗口一直挂着，45s 安全网到点误触发降级，把成功的结果
   * 覆盖成「模型响应超时」。已在建议态（_pending 有值）时只清定时器、不动窗口。
   */
  cancelThinking() {
    if (this._thinkingTimeout) { clearTimeout(this._thinkingTimeout); this._thinkingTimeout = null; }
    if (!this._pending) this._hide();
  }

  _hide() {
    if (this.win) { try { this.win.hide(); } catch (_) {} }
  }

  destroy() {
    this._resolve('later');
    if (this.win) { try { this.win.destroy(); } catch (_) {} this.win = null; this._ready = false; }
  }
}

module.exports = { PredictPanel, PANEL_WIDTH, PANEL_HEIGHT, PANEL_HEIGHT_TOPIC, SUGGEST_TIMEOUT_MS, TOPIC_TIMEOUT_MS, THINKING_TIMEOUT_MS };
