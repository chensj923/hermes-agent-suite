'use strict';

/**
 * 目标窗口捕获（Windows，主进程专用）。
 *
 * v4.10.27：解决「生成并插入没有插到文档里」的最后一块拼图——
 * 光靠「打字时沿 Z 序找回上一个窗口」不可靠：流水线开始后浮窗会 focus、
 * 用户点按钮也会把前台抢走，Z 序的第一顺位常常是浮窗或主窗口自己。
 *
 * 正确做法：在触发的那一刻（前台还是用户的 WPS/Word/浏览器）就把 HWND 抓下来，
 * 之后插入时直接用这个句柄 Activate 再注入，跟中间谁抢过焦点无关。
 *
 * 为什么要 spawn 而不是 execFileSync：捕获要 1~3s（Add-Type 首次编译），
 * 同步调用会把整条流水线堵住。这里返回 Promise，由控制器在流水线起头发起、
 * 到插入前才 await，与截图/模型推理并行跑，实际零额外延迟。
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'foreground.ps1';
// 单次捕获上限。超时按失败处理（返回 null，回退到脚本内的 Z 序查找）。
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 定位 foreground.ps1 真实路径（与 type.ps1 / paste.ps1 同规则）。
 * asar 虚拟路径下 PowerShell -File 访问不到，必须走 app.asar.unpacked。
 */
function resolveForegroundScript() {
  const p = path.join(__dirname, SCRIPT_NAME);
  if (/app\.asar[\\/]/.test(p)) {
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return p;
}

/**
 * 解析 foreground.ps1 的输出。取最后一行非空文本做 JSON 解析，
 * 兼容 PowerShell 可能夹带的杂项前导输出。
 * @returns {{hwnd:number,pid:number,title:string}|null}
 */
function parseForegroundOutput(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'null') return null;
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  const line = lines[lines.length - 1] || '';
  try {
    const o = JSON.parse(line.trim());
    const hwnd = Number(o && o.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return null;
    return {
      hwnd,
      pid: Number(o.pid) || 0,
      title: String(o.title || '').slice(0, 256),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 捕获当前应该被插入的目标窗口。
 * @param {object} [opts]
 * @param {number} [opts.buddyPid]  本进程 PID（用于排除 Buddy 自己的窗口）
 * @param {object} [opts.logger]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{hwnd:number,pid:number,title:string}|null>}
 */
function captureForegroundWindow({ buddyPid, logger, timeoutMs } = {}) {
  const log = logger || { info() {}, warn() {} };
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') return resolve(null);
      const { spawn } = require('child_process');
      const script = resolveForegroundScript();
      if (!fs.existsSync(script)) {
        log.warn('target-window-script-missing', { script });
        return resolve(null);
      }
      const started = Date.now();
      let settled = false;
      const outChunks = [];
      let timer = null;
      const done = (value, err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (value) {
          log.info('target-window-captured', {
            hwnd: String(value.hwnd),
            pid: String(value.pid),
            title: value.title.slice(0, 80),
            ms: String(Date.now() - started),
          });
        } else {
          log.warn('target-window-capture-empty', { error: err ? err.message : '', ms: String(Date.now() - started) });
        }
        resolve(value);
      };
      const child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-buddyPid', String(buddyPid || 0)],
        { windowsHide: true }
      );
      // v4.10.27：不用 spawn 的 timeout 选项（会持有 event loop），手动定时器 + unref，
      // 保证 node --test 不会因为挂着子进程而迟迟不退出。
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        done(null, new Error('timeout'));
      }, timeoutMs || DEFAULT_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      if (child.unref) child.unref();
      // v4.12.7：foreground.ps1 强制 UTF8 输出，这里用 Buffer 收集后统一按 UTF8 解码，
      // 不依赖 String(chunk) 的默认行为，避免中文标题被损坏成 '?'。
      if (child.stdout) child.stdout.on('data', (d) => { if (d) outChunks.push(Buffer.from(d)); });
      child.on('error', (e) => done(null, e));
      child.on('close', () => done(parseForegroundOutput(Buffer.concat(outChunks).toString('utf8')), null));
    } catch (e) {
      resolve(null);
    }
  });
}

module.exports = {
  captureForegroundWindow,
  parseForegroundOutput,
  resolveForegroundScript,
  DEFAULT_TIMEOUT_MS,
};
