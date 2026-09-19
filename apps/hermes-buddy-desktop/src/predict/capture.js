'use strict';

/**
 * 屏幕截图（Electron 主进程专用）。
 *
 * 隐私约束（设计文档硬性要求）：仅在「触发时」截一帧，截图只存在于内存
 * Buffer，绝不上传原图、不在本机持久化；分析完成后由调用方丢弃引用，
 * 满足「截图仅一帧、30 秒内删除」的承诺。
 *
 * v4.10.2 两个修正（实测教训）：
 * 1. 截图瞬间隐藏本应用所有窗口——桌宠猫和它的「喵~」气泡是置顶悬浮窗，
 *    全屏/窗口截图都会把它拍进去；3B 本地 VL 的注意力全被卡通猫吸走，
 *    观察描述变成「屏幕显示一只卡通猫…」，远端据此给出的建议全是空话。
 * 2. 优先按「前台窗口标题」匹配截图源——desktopCapturer 的窗口顺序不保证
 *    z 序，旧逻辑「取第一个非本应用窗口」可能拿到后台/空白窗口。
 *
 * 懒加载 electron：本模块在 node --test 下被 require 时不崩（不会真正调用
 * 截图），真正的截图只在 Electron 主进程运行。
 */

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* node 环境 */ }

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const JPEG_QUALITY = 80;

/** electron 是否可用（主进程为 true）。 */
function available() { return !!_electron; }

/**
 * 截取「当前前台窗口」或整屏，缩放至 ≤1280×720，返回 JPEG buffer + base64。
 * @param {object} [opts]
 * @param {number} [opts.maxWidth=1280]
 * @param {number} [opts.maxHeight=720]
 * @param {number} [opts.quality=80]
 * @param {RegExp|string} [opts.skipName] 跳过匹配该名称的窗口（如本应用浮窗）
 * @param {string} [opts.fgTitle] 前台窗口标题（win-info 解析），优先按它匹配截图源
 * @returns {Promise<{buffer:Buffer, base64:string, width:number, height:number, source:string}>}
 */
async function captureActiveWindow({ maxWidth = MAX_WIDTH, maxHeight = MAX_HEIGHT, quality = JPEG_QUALITY, skipName, fgTitle } = {}) {
  if (!_electron) throw new Error('capture 只能在 Electron 主进程中使用');
  const { desktopCapturer, nativeImage, BrowserWindow } = _electron;

  // v4.10.2：截图瞬间隐藏本应用所有窗口（桌宠 / 气泡 / 浮层）。
  // 用 showInactive 恢复，不抢前台焦点。失败不阻断截图。
  const wasVisible = [];
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed() && w.isVisible()) { w.hide(); wasVisible.push(w); }
      } catch (_) {}
    }
    if (wasVisible.length) await new Promise((r) => setTimeout(r, 220)); // 等合成器刷新掉桌面残影
  } catch (_) {}

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (!sources.length) throw new Error('没有可用的截图源');

    const skip = skipName instanceof RegExp ? skipName
      : (typeof skipName === 'string' ? new RegExp(skipName, 'i') : null);

    const winSources = sources.filter((s) => s.id.startsWith('window:'));
    let source = null;

    // v4.10.2：优先匹配前台窗口标题（截「用户正在看的窗口」，而非碰巧排前面的源）
    const fg = String(fgTitle || '').trim();
    if (fg) {
      const key = fg.slice(0, 24);
      source = winSources.find((s) => s.name && s.name.indexOf(key) !== -1
        && !/hermes buddy|hermes-buddy|桌宠|buddy/i.test(s.name));
    }

    // 其次：第一个非本应用窗口（旧行为兜底）
    if (!source) {
      source = winSources.find((s) => {
        if (!s.name) return false;
        if (skip && skip.test(s.name)) return false;
        return !/hermes buddy|hermes-buddy|桌宠|buddy/i.test(s.name);
      });
    }
    // 最后：整屏（此时本应用窗口已隐藏，猫不会入镜）
    if (!source) {
      source = sources.find((s) => s.id.startsWith('screen:'));
    }
    if (!source) throw new Error('未找到截图目标');

    let image = source.thumbnail; // nativeImage
    const size = image.getSize();
    const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
    if (scale < 1) {
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
      });
    }

    const buffer = image.toJPEG(quality);
    const outSize = image.getSize();
    return {
      buffer,
      base64: buffer.toString('base64'),
      width: outSize.width,
      height: outSize.height,
      source: source.name || 'screen',
    };
  } finally {
    // 无论截图成败都恢复窗口可见性
    for (const w of wasVisible) {
      try { if (!w.isDestroyed()) w.showInactive(); } catch (_) {}
    }
  }
}

/** 截整个主屏幕（用于「用户在哪儿」的兜底）。 */
async function captureScreen(opts) {
  return captureActiveWindow(Object.assign({ skipName: /.*/ }, opts || {}));
}

module.exports = { available, captureActiveWindow, captureScreen, MAX_WIDTH, MAX_HEIGHT };
