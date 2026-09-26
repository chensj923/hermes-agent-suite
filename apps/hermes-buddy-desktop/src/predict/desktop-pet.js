'use strict';

/**
 * 桌宠（Electron 主进程专用）。
 *
 * 一个 frameless / transparent / alwaysOnTop 的小窗口，常驻桌面右下角。
 * v4.5：Live2D 渲染（Hiyori，模型在 assets/live2d/hiyori/，pet:// 协议供 fetch），
 * 自带待机呼吸/眨眼/动作组；模型加载失败自动回退到双帧 PNG 猫（省电版）。
 * 交互规则（不再用 -webkit-app-region: drag —— 它会吞掉鼠标事件导致菜单弹不出）：
 *   - 渲染层手动判定：位移 < 5px = 点击（左/右键都弹菜单），否则 = 拖动（IPC 上报偏移）；
 *   - 悬停在角色外时窗口点击穿透（setIgnoreMouseEvents + forward），不挡桌面操作。
 *
 * 与预测模式的关系：PredictPanel 通过 anchorProvider 取桌宠 bounds，
 * 桌宠可见时建议浮层优先弹在桌宠旁边，而不是鼠标旁。
 *
 * 安全：窗口只经 IPC 与主进程通信，preload 只暴露 click、drag 系列、hover、onSpeak，
 * 不持有任何远端、密钥、文件系统能力；pet:// 协议只映射到本模块 assets 目录。
 */

const path = require('path');
const fs = require('fs');

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* node 环境（测试） */ }

const PET_WIDTH = 170;
const PET_HEIGHT = 190;

/** 桌宠文案（「让猫说话」/ 闲置搭话随机挑选），落 userData/pet-lines.json。 */
const DEFAULT_LINES = [
  '喵～ 有我在！',
  '喵呜～ 今天也要加油哦',
  '喵？叫我吗？',
  '喵～ 摸摸头',
  '记得喝水喵～',
  '喵～ 想我的时候就点点我！',
];

/**
 * 在目录内（浅层递归 2 级）找第一个 Cubism 3/4/5 模型入口（*.model3.json）。
 * 找到返回相对路径；没有返回 null。
 */
function findModelEntry(dir) {
  if (!dir) return null;
  const hits = [];
  const walk = (d, depth) => {
    let names;
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const name of names) {
      const full = path.join(d, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      if (/\.model3\.json$/i.test(name)) hits.push(path.relative(dir, full));
    }
  };
  walk(dir, 0);
  if (!hits.length) return null;
  // 优先浅层的入口（根目录优先于子目录）
  hits.sort((a, b) => a.split(/[/\\]/).length - b.split(/[/\\]/).length);
  return hits[0].split('\\').join('/');
}

class DesktopPet {
  /**
   * @param {object} opts
   * @param {object} [opts.logger]
   * @param {function} [opts.onPredict]  菜单「立即预测」→ 主动预测一次（v4.2）
   * @param {function} [opts.onRestore]  菜单「显示 Hermes Buddy」时回调
   * @param {function} [opts.onHide]     菜单「收起桌宠」时回调
   * @param {string} [opts.dataDir]      userData 目录（存 pet-lines.json）
   * @param {string} [opts.preloadPath]
   */
  constructor({ logger, onPredict, onRestore, onHide, dataDir, preloadPath } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.onPredict = onPredict || (() => {});
    this.onRestore = onRestore || (() => {});
    this.onHide = onHide || (() => {});
    this.dataDir = dataDir || '';
    this.preloadPath = preloadPath || path.join(__dirname, 'desktop-pet-preload.js');
    this.linesFile = this.dataDir ? path.join(this.dataDir, 'pet-lines.json') : '';
    this.modelFile = this.dataDir ? path.join(this.dataDir, 'pet-model.json') : '';
    // v4.12.6：外观模式 cat（默认小猫）| live2d（女孩，需 WebGL）
    this.modeFile = this.dataDir ? path.join(this.dataDir, 'pet-mode.json') : '';
    this.editorWin = null;
    this.win = null;
    this._ready = false;
    this._paused = false;
    this._clickThrough = false;
    this._dragging = false;
    this._loadClickThrough();
    this._setupIpc();
  }

  get available() { return !!_electron; }

  /**
   * v4.5：注册 pet:// 特权协议（必须在 app ready 之前调用一次）。
   * Live2D 模型经 fetch/XHR 加载，file:// 下会被 CORS 拦；走自定义协议绕开。
   */
  static registerSchemes() {
    const ipc = _electron && typeof _electron === 'object' ? _electron : null;
    if (!ipc || !ipc.protocol) return false;
    try {
      ipc.protocol.registerSchemesAsPrivileged([{
        scheme: 'pet',
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
      }]);
      return true;
    } catch (_) { return false; }
  }

  /** v4.5：安装 pet:// 处理器（app ready 后、创建桌宠窗口前调用）。 */
  installProtocolHandler() {
    const ipc = _electron && typeof _electron === 'object' ? _electron : null;
    if (!ipc || !ipc.protocol || this._protoReady) return;
    const { protocol } = ipc;
    try {
      const MIME = {
        '.json': 'application/json', '.png': 'image/png', '.moc3': 'application/octet-stream',
      };
      const assetsRoot = path.join(__dirname, 'assets');
      // pet://assets/<相对路径> → src/predict/assets/<相对路径>（内置资源）
      // pet://model/<相对路径> → 用户自选模型目录（v4.6）
      // 注意用 fs.readFile：资源打包在 app.asar 里，Chromium 的 file 加载器读不到 asar，
      // 只有 Electron 打过补丁的 fs 能透明解包。
      protocol.handle('pet', (request) => new Promise((resolve) => {
        try {
          const url = new URL(request.url);
          let root;
          if (url.hostname === 'model') root = (this._customModel && this._customModel.dir) || '';
          else root = assetsRoot;
          if (!root) { resolve(new Response('no custom model', { status: 404 })); return; }
          const rel = path.normalize(decodeURIComponent(url.pathname).replace(/^([/\\])+/, ''));
          const file = path.normalize(path.join(root, rel));
          if (!file.startsWith(root)) { resolve(new Response('forbidden', { status: 403 })); return; }
          fs.readFile(file, (err, data) => {
            if (err) { resolve(new Response('not found', { status: 404 })); return; }
            resolve(new Response(data, {
              status: 200,
              headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
            }));
          });
        } catch (e) {
          resolve(new Response('bad request', { status: 400 }));
        }
      }));
      this._protoReady = true;
    } catch (e) { this.logger.warn('pet-protocol-install-failed', { error: e.message }); }
  }

  _setupIpc() {
    if (this._ipcReady) return;
    // Node 测试环境：require('electron') 拿到的是字符串路径，没有 ipcMain，跳过注册
    const ipc = _electron && typeof _electron === 'object' ? _electron : null;
    if (!ipc || !ipc.ipcMain) return;
    const { ipcMain, Menu } = ipc;
    // v4.3：左键/右键点猫都弹菜单（立即预测 / 修改文案 / 唤出主窗口 / 收起）
    const popup = () => this._popupMenu();
    ipcMain.on('pet:click', popup);
    ipcMain.on('pet:context', popup);
    // v4.5：手动拖动（渲染层 mousedown 记基准 → 拖动中持续上报相对偏移 → mouseup 结束）
    ipcMain.on('pet:drag-start', () => {
      if (!this.win) return;
      try {
        const b = this.win.getBounds();
        this._dragBase = { x: b.x, y: b.y };
        this._dragLast = null;
        this._dragging = true;
      } catch (_) {}
    });
    ipcMain.on('pet:drag-end', () => { this._dragging = false; this._dragLast = null; });
    ipcMain.on('pet:drag-move', (_e, dx, dy) => this._dragTo(dx, dy));
    // v4.12.5b：真实拖动聚合埋点（松手一次），用于以真实手感数据定位卡顿
    ipcMain.on('pet:drag-trace', (_e, data) => {
      try { this.logger.info('pet-drag-trace', { trace: JSON.parse(JSON.stringify(data || {})) }); } catch (_) {}
    });
    // v4.7：不再靠 hover 切换穿透（见 _setClickThrough）；渲染层诊断错误上报
    ipcMain.on('pet:error', (_e, msg) => this.logger.warn('pet-renderer-error', { error: String(msg || '').slice(0, 300) }));
    // v4.7：动画开关（省电模式）
    ipcMain.on('pet:paused', (_e, paused) => { this._paused = Boolean(paused); });
    // 文案编辑窗口的读写
    ipcMain.handle('pet-lines:get', () => this.getLines());
    ipcMain.handle('pet-lines:save', (_e, text) => {
      this.saveLines(String(text || ''));
      this.speak(this.randomLine());
      return this.getLines();
    });
    this._ipcReady = true;
  }

  /**
   * 拖动：以 mousedown 时的窗口位置为基准平移。
   *
   * v4.12.5：
   *   - 用 setPosition 代替 setBounds（实测 1.22ms vs 1.31ms，且不带尺寸参数，
   *     避免每次移动都走一遍尺寸变更路径）；
   *   - 位置去重：渲染层节流后仍可能发来相同坐标（如只移动了 1px 又回退），
   *     重复 SetWindowPos 是纯浪费，直接跳过。
   * 真正的节流在渲染层（时间节流 ~60fps）——高刷屏上 rAF 间隔只有 ~7ms，
   * 靠 rAF 限流等于不限流，每秒上百次同步窗口移动会把主进程拖垮。
   */
  _dragTo(dx, dy) {
    if (!this.win || !this._dragBase) return;
    const x = this._dragBase.x + dx;
    const y = this._dragBase.y + dy;
    if (this._dragLast && this._dragLast.x === x && this._dragLast.y === y) return;
    this._dragLast = { x, y };
    try { this.win.setPosition(x, y); } catch (_) {}
  }

  /**
   * 点击穿透开关（v4.7）：默认关。开启后鼠标事件直接落到桌面，
   * 代价是不能点击/弹菜单——所以只在用户明确要求「不挡桌面」时启用。
   */
  _setClickThrough(on) {
    this._clickThrough = Boolean(on);
    if (!this.win) return;
    try { this.win.setIgnoreMouseEvents(this._clickThrough, { forward: false }); } catch (_) {}
    if (this._clickThrough) {
      this.speak('鼠标穿透已开启，无法点击。再次点菜单可关闭。');
    }
  }

  _ctFile() {
    return this.dataDir ? path.join(this.dataDir, 'pet-clickthrough.json') : '';
  }

  /** 清除持久化的穿透状态文件（安全策略：防止死锁）。 */
  _clearClickThroughFile() {
    try {
      const f = this._ctFile();
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  }

  _loadClickThrough() {
    // 安全策略：启动时不再从文件恢复穿透状态。
    // 穿透开着时窗口不接收任何鼠标事件，用户无法弹菜单关掉它，
    // 表现为「桌宠卡死、无法点击、无法拖拽」。
    // 穿透只做运行时临时开关，下次启动自动回到可交互状态。
    this._clickThrough = false;
    try { this._clearClickThroughFile(); } catch (_) {}
    return false;
  }

  /** 点猫/右键共用的弹出菜单。 */
  _popupMenu() {
    if (!this.win || !_electron) return;
    this.wave();
    const { Menu } = _electron;
    const isLive2d = this.getMode() === 'live2d';
    const menu = Menu.buildFromTemplate([
      { label: '立即预测（看一眼屏幕）', click: () => { this.speak('喵～ 我看一眼…'); try { this.onPredict(); } catch (_) {} } },
      { label: '修改文案…', click: () => this._openLinesEditor() },
      { label: '显示 Hermes Buddy', click: () => { try { this.onRestore(); } catch (_) {} } },
      { type: 'separator' },
      {
        label: isLive2d ? '外观：换回小猫（推荐，最流畅）' : '外观：切换 Live2D 女孩（更吃性能）',
        click: () => {
          const next = isLive2d ? 'cat' : 'live2d';
          this.setMode(next);
          this.speak(next === 'cat' ? '喵～ 我回来啦！' : '切换到 Live2D…');
          this._reload();
        },
      },
      {
        label: this._paused ? '继续动画' : '暂停动画（省电）',
        click: () => {
          this._paused = !this._paused;
          try { this.win.webContents.send('pet:paused', this._paused); } catch (_) {}
        },
      },
      {
        label: this._clickThrough ? '关闭鼠标穿透（恢复可点击）' : '鼠标穿透（临时不挡桌面，重启失效）',
        click: () => this._setClickThrough(!this._clickThrough),
      },
      { type: 'separator' },
      { label: '收起桌宠', click: () => this.hide() },
    ]);
    // v4.10.10：不调 win.focus() -- 透明置顶窗口 focus 后会闪烁/消失。
    // menu.popup 会自己处理窗口关联。
    const anchor = this._menuAnchor();
    try {
      menu.popup({ window: this.win, x: anchor.x, y: anchor.y });
    } catch (_) {
      try { menu.popup({ window: this.win }); } catch (_) {}
    }
  }

  /**
   * 菜单弹出点（相对桌宠窗口）。v4.8.1 修复：popup 的 x/y 是相对窗口的坐标，
   * 之前错传屏幕绝对坐标，导致菜单弹到与猫无关的位置。
   * 默认弹猫右侧；贴近屏幕右缘翻到左侧；贴近底部向上展开。
   */
  _menuAnchor() {
    const MENU_W = 240, MENU_H = 280;
    const fallback = { x: PET_WIDTH + 4, y: 12 };
    try {
      const { screen } = _electron;
      const b = this.win.getBounds();
      const area = (screen.getDisplayMatching(b) || screen.getPrimaryDisplay()).workArea;
      let x = PET_WIDTH + 4;
      // 猫右缘到工作区右边的剩余空间放不下菜单 → 翻到猫左侧（负 x = 越过窗口左缘）
      if (area.x + area.width - (b.x + PET_WIDTH) < MENU_W) x = -(MENU_W + 8);
      let y = 12;
      // 猫下方放不下 → 向上展开（负 y = 越过窗口顶缘）
      if (area.y + area.height - (b.y + y) < MENU_H) y = PET_HEIGHT - MENU_H - 4;
      return { x: Math.round(x), y: Math.round(y) };
    } catch (_) {
      return fallback;
    }
  }

  // ---- 外观模式（v4.12.6）：cat 默认小猫 | live2d 女孩 ----

  /** 读当前外观模式，损坏/未设置返回 'cat'。 */
  getMode() {
    try {
      if (this.modeFile && fs.existsSync(this.modeFile)) {
        const m = JSON.parse(fs.readFileSync(this.modeFile, 'utf-8'));
        if (m && (m.mode === 'live2d' || m.mode === 'cat')) return m.mode;
      }
    } catch (_) {}
    return 'cat';
  }

  /** 写外观模式。 */
  setMode(mode) {
    const m = mode === 'live2d' ? 'live2d' : 'cat';
    try {
      if (this.modeFile) {
        fs.mkdirSync(path.dirname(this.modeFile), { recursive: true });
        fs.writeFileSync(this.modeFile, JSON.stringify({ mode: m }), 'utf-8');
      }
    } catch (e) { this.logger.warn('pet-mode-save-failed', { error: e.message }); }
    return m;
  }

  // ---- 自定义模型（v4.6）：用户可导入本地 Cubism 3/4/5 模型文件夹 ----

  /** 读用户自选模型（userData/pet-model.json → {dir,file}），损坏/目录已不存在返回 null。 */
  getModel() {
    try {
      if (this.modelFile && fs.existsSync(this.modelFile)) {
        const o = JSON.parse(fs.readFileSync(this.modelFile, 'utf-8'));
        if (o && typeof o.dir === 'string' && typeof o.file === 'string' &&
            fs.existsSync(path.join(o.dir, o.file))) return { dir: o.dir, file: o.file };
      }
    } catch (_) { /* 损坏回落内置 */ }
    return null;
  }

  /**
   * 设置本地模型目录。在目录内（浅层递归 2 级）找第一个 *.model3.json（Cubism 3/4/5）。
   * 找不到抛错；成功后落盘并热重载桌宠窗口。
   * @returns {{ok:true, file:string}}
   */
  setModel(dir) {
    const entry = findModelEntry(dir);
    if (!entry) {
      throw new Error('所选文件夹里没有 Live2D 模型文件（*.model3.json，Cubism 3/4/5 格式）');
    }
    try {
      if (this.modelFile) {
        fs.mkdirSync(path.dirname(this.modelFile), { recursive: true });
        fs.writeFileSync(this.modelFile, JSON.stringify({ dir, file: entry }, null, 2), 'utf-8');
      }
    } catch (e) { this.logger.warn('pet-model-save-failed', { error: e.message }); }
    this._customModel = { dir, file: entry };
    this._reload();
    return { ok: true, file: entry };
  }

  /** 清除自选模型，回到内置 Hiyori。 */
  clearModel() {
    try { if (this.modelFile && fs.existsSync(this.modelFile)) fs.unlinkSync(this.modelFile); } catch (_) {}
    this._customModel = null;
    this._reload();
    return { ok: true };
  }

  /** 当前应加载的模型 URL（pet:// 协议），内置为 Hiyori。 */
  _modelUrl() {
    const m = this._customModel || this.getModel();
    if (m) this._customModel = m;
    if (m) return 'pet://model/' + m.file.split('\\').join('/').split('/').map(encodeURIComponent).join('/');
    return 'pet://assets/live2d/hiyori/Hiyori.model3.json';
  }

  /** v4.12.6：窗口加载查询，含外观模式。 */
  _petQuery() {
    const mode = this.getMode();
    if (mode === 'live2d') return { mode: 'live2d', model: this._modelUrl() };
    return { mode: 'cat' };
  }

  /** 模型变更后热重载桌宠窗口（窗口不存在则下次 show 时生效）。 */
  _reload() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this._ready = false;
      this.win.loadFile(path.join(__dirname, 'desktop-pet.html'), {
        query: this._petQuery(),
      }).then(() => { if (this.win) this._ready = true; }).catch(() => {});
    } catch (_) {}
  }

  // ---- 桌宠文案 ----
  getLines() {
    try {
      if (this.linesFile && fs.existsSync(this.linesFile)) {
        const arr = JSON.parse(fs.readFileSync(this.linesFile, 'utf-8'));
        if (Array.isArray(arr) && arr.length) return arr.map(String).filter(Boolean);
      }
    } catch (_) { /* 损坏则回落默认 */ }
    return DEFAULT_LINES.slice();
  }

  saveLines(text) {
    const arr = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const lines = arr.length ? arr : DEFAULT_LINES;
    try {
      if (this.linesFile) {
        fs.mkdirSync(path.dirname(this.linesFile), { recursive: true });
        fs.writeFileSync(this.linesFile, JSON.stringify(lines, null, 2), 'utf-8');
      }
    } catch (e) { this.logger.warn('pet-lines-save-failed', { error: e.message }); }
    return lines;
  }

  randomLine() {
    const lines = this.getLines();
    return lines[Math.floor(Math.random() * lines.length)] || '喵～';
  }

  /** 打开一个小编辑窗口，每行一句桌宠台词。 */
  _openLinesEditor() {
    if (!_electron) return;
    if (this.editorWin && !this.editorWin.isDestroyed()) { try { this.editorWin.focus(); } catch (_) {} return; }
    const { BrowserWindow } = _electron;
    const win = new BrowserWindow({
      width: 380,
      height: 320,
      title: '桌宠文案',
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'desktop-pet-editor-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'desktop-pet-editor.html'));
    win.on('closed', () => { this.editorWin = null; });
    win._isBuddyFloating = true; // 截图时只隐藏悬浮窗，不隐藏主窗口
    this.editorWin = win;
  }

  _createWindow() {
    const { BrowserWindow, screen } = _electron;
    const win = new BrowserWindow({
      width: PET_WIDTH,
      height: PET_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: true,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      focusable: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,   // preload 只用 ipcRenderer，保持最小暴露
      },
    });
    // 永久置顶：盖过全屏应用之外的绝大多数窗口
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    // v4.7：不再默认点击穿透。上一版用 setIgnoreMouseEvents(true,{forward:true})
    // 只转发 mousemove、靠悬停检测再切回可交互，实测在 Windows 上：
    //   ① 菜单弹不出来（点击被系统丢掉）；② 频繁切换穿透状态会反复改窗口样式 → 拖动卡顿。
    // 现在窗口默认完全可交互，穿透做成菜单里的可选开关。
    win.loadFile(path.join(__dirname, 'desktop-pet.html'), {
      query: this._petQuery(),
    });
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

  /** 显示桌宠（幂等）。首次出现在主屏工作区右下角。 */
  async show() {
    if (!_electron) return null;
    const win = await this._ensureReady();
    if (!win.isVisible()) {
      const { screen } = _electron;
      const area = screen.getPrimaryDisplay().workArea;
      const x = area.x + area.width - PET_WIDTH - 24;
      const y = area.y + area.height - PET_HEIGHT - 8;
      win.setPosition(Math.round(x), Math.round(y));
      win.showInactive();
      // 安全策略：每次显示都先确保窗口完全可交互。
      // 不再从 pet-clickthrough.json 恢复穿透状态 -- 穿透开着时
      // 用户无法点击/拖拽/弹菜单，会变成「桌宠卡死」的死锁。
      // 穿透改为仅运行时开关，不持久化。
      if (this._clickThrough) {
        this._clickThrough = false;
        try { this._clearClickThroughFile(); } catch (_) {}
        try { win.setIgnoreMouseEvents(false); } catch (_) {}
        this.logger.info('pet-clickthrough-reset-on-show', { reason: 'safety: prevent dead state' });
      }
      setTimeout(() => this.speak(this.randomLine()), 800);
    }
    return this.getBounds();
  }

  hide() {
    if (this.win) { try { this.win.hide(); } catch (_) {} }
    try { this.onHide(); } catch (_) {}
  }

  isVisible() {
    try { return Boolean(this.win && this.win.isVisible()); } catch (_) { return false; }
  }

  /** 给 PredictPanel 的锚点：桌宠可见时返回其 bounds，否则 null。 */
  panelAnchor() {
    if (!this.isVisible()) return null;
    try { return this.win.getBounds(); } catch (_) { return null; }
  }

  getBounds() {
    try { return this.win ? this.win.getBounds() : null; } catch (_) { return null; }
  }

  /** 让猫头顶冒一句话（4 秒消失）。 */
  speak(text) {
    if (!this.win || !this._ready) return;
    try { this.win.webContents.send('pet:speak', String(text || '喵～')); } catch (_) {}
  }

  /** 挥手动作（切到举手帧晃 2 秒）。 */
  wave() {
    if (!this.win || !this._ready) return;
    try { this.win.webContents.send('pet:wave'); } catch (_) {}
  }

  destroy() {
    if (this.editorWin) { try { this.editorWin.destroy(); } catch (_) {} this.editorWin = null; }
    if (this.win) { try { this.win.destroy(); } catch (_) {} this.win = null; this._ready = false; }
  }
}

module.exports = { DesktopPet, PET_WIDTH, PET_HEIGHT, findModelEntry };
