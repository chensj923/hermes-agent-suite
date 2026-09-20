'use strict';

/**
 * 建议动作执行器（Electron 主进程专用）。
 *
 * 预测浮窗里的「生成/插入」落到这里执行。所有动作都在主进程发生，
 * 绝不下发到渲染进程（API Key / 远端调用同样只在主进程），满足 v4.0 安全约束。
 *
 * 当前支持的动作：
 *   - clipboard: 把建议文本写入剪贴板，并先把旧值存起来，延迟一段时间再恢复，
 *     避免「建议一插就把用户正在用的内容冲掉」的竞态；恢复失败也无妨（旧值已尽力保留）。
 *   - clipboard-keep: 写入且不恢复（v4.10.2，生成内容用）
 *   - clipboard-paste: 写入剪贴板 + 模拟 Ctrl+V 自动粘贴到前台窗口（v4.10.10）
 *   - type-input: SendInput KEYEVENTF_UNICODE 直接在当前窗体打字（v4.10.24），
 *     不经过剪贴板，用户剪贴板原值分毫不动。
 *   - noop
 */

const fs = require('fs');
const DEFAULT_RESTORE_MS = 8000;

/**
 * v4.10.10：模拟 Ctrl+V 粘贴（Windows）。
 * 调用同目录下的 paste.ps1（PowerShell + Win32 SendInput）。
 * 失败不阻断主流程（已写入剪贴板，用户手动 Ctrl+V 即可）。
 */
/**
 * v4.10.24：定位 type.ps1 真实路径（逻辑同 resolvePasteScript，asar unpack 规则一致）。
 */
function resolveTypeScript() {
  const path = require('path');
  const p = path.join(__dirname, 'type.ps1');
  if (/app\.asar[\\/]/.test(p)) {
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return p;
}

/**
 * v4.10.24：直接打字输入（Windows）。
 * 文本经 stdin（UTF-8）传给 type.ps1，PowerShell 侧用 SendInput KEYEVENTF_UNICODE
 * 逐字敲进前台窗口——不碰剪贴板，用户正在复制的东西原样保留。
 * 文本走 stdin 而不是命令行参数：避免转义地狱与 32K 命令行长度上限。
 * 失败不阻断主流程，返回 false 供上层回退到粘贴。
 */
function simulateTyping(text, logger, targetHwnd) {
  return new Promise((resolve) => {
    const started = Date.now();
    try {
      const { spawn } = require('child_process');
      const script = resolveTypeScript();
      // v4.10.26：-buddyPid 让脚本跳过 Buddy 自身的窗口，把焦点交还给真正的工作窗口。
      // v4.10.27：-targetHwnd 用触发那一刻捕获到的窗口句柄，直接插回那个窗口。
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-buddyPid', String(process.pid), '-targetHwnd', String(targetHwnd || 0)], {
        // v4.10.26：PowerShell 冷启动 + Add-Type 编译偶发到 30s（曾观察到 308 字被超时 kill），放宽到 45s。
        timeout: 45000,
        windowsHide: true,
      });
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        if (logger) {
          const ms = Date.now() - started;
          if (ok) logger.info('type-input-sent', { len: String(text || '').length, ms: String(ms), targetHwnd: String(targetHwnd || 0) });
          else logger.warn('type-input-failed', { error: err && err.message, ms: String(ms) });
        }
        resolve(ok);
      };
      child.on('error', (e) => done(false, e));
      child.on('exit', (code) => done(code === 0, code === 0 ? null : new Error('type.ps1 exit ' + code)));
      // stdin 写入可能因进程提前退出而报 EPIPE，吞掉即可
      child.stdin.on('error', () => {});
      child.stdin.end(String(text || ''), 'utf8');
    } catch (e) {
      if (logger) logger.warn('type-input-failed', { error: e.message });
      resolve(false);
    }
  });
}

// v4.10.26：改用 spawn（可按参数传 buddyPid）并等待退出，保证「焦点归还 → Ctrl+V」顺序执行。
function simulatePaste(logger, targetHwnd) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const script = resolvePasteScript();
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-buddyPid', String(process.pid), '-targetHwnd', String(targetHwnd || 0)], {
        timeout: 20000,
        windowsHide: true
      });
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        if (logger) {
          if (ok) logger.info('paste-simulated', { script });
          else logger.warn('paste-simulate-failed', { error: err && err.message, script });
        }
        resolve(ok);
      };
      child.on('error', (e) => done(false, e));
      child.on('exit', (code) => done(code === 0, code === 0 ? null : new Error('paste.ps1 exit ' + code)));
    } catch (e) {
      if (logger) logger.warn('paste-simulate-failed', { error: e.message });
      resolve(false);
    }
  });
}

/**
 * v4.10.13：定位 paste.ps1 真实路径。
 *
 * 根因：Electron 把 asar 挂为虚拟文件系统，fs.existsSync() 对 asar 内的文件
 * 也返回 true。旧逻辑先 existsSync(asar 内路径) -> true -> 直接返回 asar 内路径，
 * 回退到 app.asar.unpacked 从未执行。PowerShell -File 无法访问 asar 虚拟路径，
 * 报"路径不存在"，导致 simulatePaste 永远失败 -> "推测完了但没粘贴"。
 *
 * 修复：检测到 __dirname 含 app.asar 时，直接优先用 unpacked 路径（asarUnpack
 * 已在 package.json 配置，打包时 paste.ps1 一定被解到 app.asar.unpacked 同结构
 * 位置）；只有 unpacked 不存在时才退回 asar 内路径（开发态或未配置 unpack）。
 */
function resolvePasteScript() {
  const path = require('path');
  const p = path.join(__dirname, 'paste.ps1');
  // 打包态：__dirname 含 app.asar -> 直接走 unpacked 真实路径
  if (/app\.asar[\\/]/.test(p)) {
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  // 开发态或未配置 unpack：用原始路径（开发态 __dirname 在真实文件系统）
  return p;
}

class ActionExecutor {
  /**
   * @param {object} opts
   * @param {object} opts.clipboard  Electron clipboard 实例（注入便于测试）
   * @param {object} opts.logger
   * @param {number} [opts.restoreMs=8000]
   */
  constructor({ clipboard, logger, restoreMs = DEFAULT_RESTORE_MS } = {}) {
    if (!clipboard) throw new Error('ActionExecutor 需要 clipboard');
    this.clipboard = clipboard;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.restoreMs = restoreMs;
    this._restoreTimer = null;
  }

  /**
   * 执行一个建议动作。
   * @param {object} action { type:'clipboard', text }              写入并在 restoreMs 后恢复旧值
   *                          { type:'clipboard-keep', text }      写入且不恢复（v4.10.2，生成内容用）
   *                          { type:'noop' }
   * @returns {Promise<{ok:boolean, type:string, message:string}>}
   */
  async execute(action) {
    const type = (action && action.type) || 'noop';
    if (type === 'clipboard') {
      return this._fillClipboard(String(action.text || ''), false);
    }
    if (type === 'clipboard-keep') {
      return this._fillClipboard(String(action.text || ''), true);
    }
    if (type === 'clipboard-paste') {
      // v4.10.10：写入剪贴板 + 模拟 Ctrl+V 自动粘贴
      const r = await this._fillClipboard(String(action.text || ''), true);
      if (r.ok) {
        // 延迟 200ms 让剪贴板写入生效，再模拟粘贴
        const hwnd = action.targetHwnd || 0;
        setTimeout(() => simulatePaste(this.logger, hwnd), 200);
      }
      return r;
    }
    if (type === 'type-input') {
      // v4.10.24：直接打字进目标窗体，不碰剪贴板。失败时回退到 clipboard-paste。
      const text = String(action.text || '');
      if (!text) return { ok: true, type: 'type-input', message: '内容为空，跳过' };
      const ok = await simulateTyping(text, this.logger, action.targetHwnd || 0);
      if (ok) return { ok: true, type: 'type-input', message: '已直接输入到当前窗体（' + text.length + ' 字）' };
      this.logger.warn('type-input-fallback-paste');
      return this.execute({ type: 'clipboard-paste', text, targetHwnd: action.targetHwnd || 0 });
    }
    if (type === 'noop' || !action) {
      return { ok: true, type: 'noop', message: '无需执行' };
    }
    // 未知动作：安全拒绝，避免静默做不该做的事
    this.logger.warn('action-unknown', { type });
    return { ok: false, type, message: '不支持的动作类型：' + type };
  }

  async _fillClipboard(text, keep) {
    if (!text) return { ok: true, type: 'clipboard', message: '内容为空，跳过' };
    // 先保存旧值（含富文本/文件等类型，一律转字符串尽力保存）
    let previous = '';
    try { previous = this.clipboard.readText() || ''; } catch (_) { previous = ''; }

    try {
      this.clipboard.writeText(text);
    } catch (e) {
      return { ok: false, type: 'clipboard', message: '写入剪贴板失败：' + e.message };
    }

    // keep=true（v4.10.2 生成内容）：不启动恢复定时器——用户点「生成并插入」
    // 拿到的是真生成的内容，8 秒后被旧值冲掉等于功能白做。
    if (keep) {
      this.logger.info('clipboard-filled-keep', { len: text.length });
      return { ok: true, type: 'clipboard-keep', message: '已将生成内容写入剪贴板（' + text.length + ' 字，不会自动恢复）' };
    }

    // 延迟恢复旧值，避免冲掉用户当前内容。恢复失败仅记录，不影响本次插入。
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    this._restoreTimer = setTimeout(() => {
      try { if (previous) this.clipboard.writeText(previous); }
      catch (e) { this.logger.warn('clipboard-restore-failed', { error: e.message }); }
      finally { this._restoreTimer = null; }
    }, this.restoreMs);

    this.logger.info('clipboard-filled', { len: text.length });
    return { ok: true, type: 'clipboard', message: '已将建议写入剪贴板（' + text.length + ' 字）' };
  }

  /** 立即取消待恢复的旧值（用户主动操作后调用，避免误恢复）。 */
  cancelRestore() {
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
  }
}

module.exports = { ActionExecutor, DEFAULT_RESTORE_MS };
