'use strict';

/**
 * 常驻前台窗口监视器（Electron 主进程专用，Windows only）。
 *
 * v4.12.8：解决「打开推理模式起整机微卡」的架构问题。
 *
 * 旧做法：behavior-hooks 每 800ms 调一次 win-info，每次都冷启动一个全新
 * powershell.exe（0.5~1s + P/Invoke）→ 每秒 fork 进程，持续占 CPU。
 *
 * 新做法：只启动一个常驻 foreground-watcher.ps1，进程内部 300ms 轮询 user32，
 * HWND 变化时才往 stdout 写一行 JSON。本模块读这些行、更新内存最新值；
 * resolveWindow() 直接同步返回最新值，运行期间零进程创建、零冷启动。
 *
 * 生命周期：随预测模式 enable() 启动、disable() 停止。
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'foreground-watcher.ps1';
const START_TIMEOUT_MS = 4000;

/** exe 名 → 合成 windowClass（与 win-info 保持一致，解决类名碰撞）。 */
const EXE_TO_CLASS = {
  code: 'VSCodeIDE',
  devenv: 'VisualStudioIDE',
  idea64: 'CASCADIA_HOST',
  webstorm6: 'CASCADIA_HOST',
};

function resolveScript() {
  const p = path.join(__dirname, SCRIPT_NAME);
  if (/app\.asar[\\/]/.test(p)) {
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return p;
}

/**
 * 解析监视器输出的一行 JSON。
 * @returns {{hwnd:number,pid:number,title:string,class:string,exe:string}|null}
 */
function parseLine(line) {
  try {
    const o = JSON.parse(String(line || '').trim());
    const hwnd = Number(o && o.hwnd);
    if (!Number.isFinite(hwnd)) return null;
    return {
      hwnd,
      pid: Number(o.pid) || 0,
      title: String(o.title || '').slice(0, 256),
      class: String(o.class || ''),
      exe: String(o.exe || ''),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 把监视器的原始行转成 resolveWindow 的统一结构（与 win-info 对齐）。
 */
function toWindowInfo(r) {
  if (!r) return null;
  const exeName = (r.exe || 'unknown').trim() || 'unknown';
  const realClass = (r.class || '').trim() || 'unknown';
  const windowClass = EXE_TO_CLASS[exeName.toLowerCase()]
    ? EXE_TO_CLASS[exeName.toLowerCase()]
    : (realClass === 'unknown' ? exeName : realClass);
  return {
    windowClass: windowClass.slice(0, 128),
    title: r.title,
    exeName,
  };
}

class ForegroundWatcher {
  constructor({ logger, onChange } = {}) {
    this.logger = logger || { info() {}, warn() {} };
    this.onChange = onChange || null;
    this._child = null;
    this._latest = null;       // 原始行 {hwnd,...}
    this._lastEmittedHwnd = 0;
    this._buf = '';
  }

  get running() {
    return Boolean(this._child);
  }

  /** 同步返回最新前台窗口信息（无数据时返回 null）。 */
  latest() {
    return toWindowInfo(this._latest);
  }

  /**
   * 启动常驻监视器。
   * @returns {Promise<boolean>} 是否已启动；已在运行直接返回 true。
   */
  start() {
    if (this._child) return Promise.resolve(true);
    if (process.platform !== 'win32') return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const { spawn } = require('child_process');
        const script = resolveScript();
        if (!fs.existsSync(script)) {
          this.logger.warn('foreground-watcher-script-missing', { script });
          return resolve(false);
        }
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        this._child = spawn(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          { windowsHide: true }
        );
        // 启动保护：进程异常退出 / 超时未就绪 → 返回 false，上层可回退。
        const timer = setTimeout(() => finish(this._latest !== null), START_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        this._child.stdout.on('data', (d) => this._onData(d, () => {
          clearTimeout(timer);
          finish(true);
        }));
        this._child.on('error', (e) => {
          this.logger.warn('foreground-watcher-error', { error: e.message });
          clearTimeout(timer);
          this._child = null;
          finish(false);
        });
        this._child.on('exit', () => {
          clearTimeout(timer);
          this._child = null;
        });
        if (this._child.unref) this._child.unref();
      } catch (e) {
        this.logger.warn('foreground-watcher-start-failed', { error: e.message });
        resolve(false);
      }
    });
  }

  _onData(d, onFirst) {
    this._buf += d.toString('utf8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      const r = parseLine(line);
      if (!r) continue;
      const first = this._latest === null;
      this._latest = r;
      if (first) onFirst();
      if (r.hwnd !== this._lastEmittedHwnd) {
        this._lastEmittedHwnd = r.hwnd;
        if (this.onChange) {
          try { this.onChange(toWindowInfo(r), r); } catch (_) {}
        }
      }
    }
  }

  /** 停止常驻进程。 */
  stop() {
    const c = this._child;
    this._child = null;
    this._latest = null;
    this._buf = '';
    this._lastEmittedHwnd = 0;
    if (c) {
      try { c.kill(); } catch (_) {}
    }
  }
}

module.exports = {
  ForegroundWatcher,
  parseLine,
  toWindowInfo,
  resolveScript,
};
