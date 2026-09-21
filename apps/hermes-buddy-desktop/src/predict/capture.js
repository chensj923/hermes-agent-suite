'use strict';

/**
 * 屏幕截图（Electron 主进程专用）。
 *
 * 隐私约束（设计文档硬性要求）：仅在「触发时」截一帧，截图只存在于内存
 * Buffer，绝不上传原图、不在本机持久化；分析完成后由调用方丢弃引用，
 * 满足「截图仅一帧、30 秒内删除」的承诺。
 *
 * v4.10.2 两个修正（实测教训）：
 * 1. 桌宠猫和它的「喵~」气泡是置顶悬浮窗，整屏截图会把它拍进去；3B 本地
 *    VL 的注意力全被卡通猫吸走，观察描述变成「屏幕显示一只卡通猫…」，远端
 *    据此给出的建议全是空话。→ 因此抓整屏前必须隐藏这些浮窗。但抓「用户
 *    前台窗口」这张独立缩略图时，DWM 不会把别的窗口合成进去，无需隐藏，
 *    v4.10.29 起优先走窗口源路径，从根本上消除推理时的闪屏。
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
 * v4.10.3：黑帧/纯色帧检测。
 * 实测教训：desktopCapturer 对「最小化/刚被隐藏」的窗口返回纯黑 thumbnail，
 * VL 拿到后只能输出「屏幕全黑」，远端据此瞎猜意图（日志实锤连续 5 轮）。
 * 采样 bitmap 亮度：平均 < 10 且最大 < 48 判为黑帧。
 */
function _isBlankImage(image) {
  try {
    const size = image.getSize();
    if (!size.width || !size.height) return true;
    const bmp = image.getBitmap(); // BGRA
    const bytes = bmp.length;
    if (!bytes) return true;
    const stride = size.width * 4;
    let sum = 0, max = 0, n = 0;
    // 每行采 16 个点，步长对齐 4 字节
    const rowStep = Math.max(1, Math.floor(size.width / 16)) * 4;
    for (let y = 0; y < size.height; y += 4) {
      const row = y * stride;
      for (let off = 0; off + 2 < stride; off += rowStep) {
        const b = bmp[row + off], g = bmp[row + off + 1], r = bmp[row + off + 2];
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        sum += lum; n++;
        if (lum > max) max = lum;
      }
    }
    if (!n) return false;
    const avg = sum / n;
    return avg < 10 && max < 48;
  } catch (_) {
    return false; // 检测失败不误杀正常截图
  }
}

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
/**
 * v4.10.29：彻底消除「推理时整窗 + 桌宠闪 2 秒」。
 * 旧实现（≤4.10.28）在截图前先把本应用所有窗口 hide()，等
 * desktopCapturer.getSources 返回后才在 finally 恢复——而 getSources 在
 * 某些机器上要 ~2s，于是整窗 + 桌宠被藏 2 秒再出现。
 *
 * 新思路：优先截「用户前台窗口」这张独立缩略图。DWM 的窗口缩略图只含
 * 该窗口自身画面，绝不会把我们的置顶桌宠/预测浮层合成进去，因此根本
 * 不需要隐藏本应用任何窗口 → 零闪屏。仅当没有可用窗口源（用户在桌面 /
 * UWP 全屏）必须退到整屏时，才隐藏浮动窗后重新取一次屏。
 */
async function captureActiveWindow({ maxWidth = MAX_WIDTH, maxHeight = MAX_HEIGHT, quality = JPEG_QUALITY, skipName, fgTitle } = {}) {
  if (!_electron) throw new Error('capture 只能在 Electron 主进程中使用');
  const { desktopCapturer } = _electron;

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  if (!sources.length) throw new Error('没有可用的截图源');

  const skip = skipName instanceof RegExp ? skipName
    : (typeof skipName === 'string' ? new RegExp(skipName, 'i') : null);
  const buddyRe = /hermes buddy|hermes-buddy|桌宠|buddy/i;
  const winSources = sources.filter((s) => s.id.startsWith('window:'));

  // 优先匹配前台窗口标题（截「用户正在看的窗口」，而非碰巧排前面的源）
  const fg = String(fgTitle || '').trim();
  let source = null;
  if (fg) {
    const key = fg.slice(0, 24);
    source = winSources.find((s) => s.name && s.name.indexOf(key) !== -1 && !buddyRe.test(s.name));
  }
  // 其次：第一个非本应用窗口（旧行为兜底）
  if (!source) {
    source = winSources.find((s) => {
      if (!s.name) return false;
      if (skip && skip.test(s.name)) return false;
      return !buddyRe.test(s.name);
    });
  }

  if (source) {
    let image = source.thumbnail; // nativeImage
    // v4.10.3：该窗口缩略图全黑（最小化/被遮挡）→ 退而抓整屏；整屏会拍到
    // 置顶桌宠，所以走 _captureScreenHidingSelf 先隐藏浮窗再重新取一次。
    if (_isBlankImage(image)) {
      const screenSource = sources.find((s) => s.id.startsWith('screen:'));
      if (screenSource && screenSource.id !== source.id && !_isBlankImage(screenSource.thumbnail)) {
        image = await _captureScreenHidingSelf(screenSource);
        source = screenSource;
      } else {
        throw new Error('截图为黑帧（目标窗口最小化或屏幕不可见）');
      }
    }
    return _finishCapture(image, source, maxWidth, maxHeight, quality);
  }

  // 没有任何可用窗口源（用户在桌面 / UWP 全屏）→ 只能抓整屏，需先隐藏浮窗。
  const screenSource = sources.find((s) => s.id.startsWith('screen:'));
  if (!screenSource) throw new Error('未找到截图目标');
  const image = await _captureScreenHidingSelf(screenSource);
  return _finishCapture(image, screenSource, maxWidth, maxHeight, quality);
}

/**
 * 隐藏本应用浮动窗（桌宠/气泡/预测浮层）后重新取一次整屏缩略图。
 * 必须在隐藏【之后】重新 getSources——首轮 sources 是在隐藏前取的，缩略图
 * 里仍含桌宠。返回不含本应用浮窗的整屏画面。
 */
async function _captureScreenHidingSelf(screenSource) {
  const { desktopCapturer, BrowserWindow } = _electron;
  const wasVisible = [];
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed() && w.isVisible() && w._isBuddyFloating) { w.hide(); wasVisible.push(w); }
      } catch (_) {}
    }
    // 等合成器把桌面残影刷新掉（桌宠真的从屏上消失）再取屏
    if (wasVisible.length) await new Promise((r) => setTimeout(r, 180));
  } catch (_) {}
  try {
    const fresh = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const sc = fresh.find((s) => s.id === screenSource.id) || fresh.find((s) => s.id.startsWith('screen:'));
    return (sc && sc.thumbnail) || screenSource.thumbnail;
  } finally {
    for (const w of wasVisible) {
      try { if (!w.isDestroyed()) w.showInactive(); } catch (_) {}
    }
  }
}

function _finishCapture(image, source, maxWidth, maxHeight, quality) {
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
}

/** 截整个主屏幕（用于「用户在哪儿」的兜底）。 */
async function captureScreen(opts) {
  return captureActiveWindow(Object.assign({ skipName: /.*/ }, opts || {}));
}

module.exports = { available, captureActiveWindow, captureScreen, MAX_WIDTH, MAX_HEIGHT };
