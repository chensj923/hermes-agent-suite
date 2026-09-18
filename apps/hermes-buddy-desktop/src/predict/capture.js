'use strict';

/**
 * 屏幕截图（Electron 主进程专用）。
 *
 * 隐私约束（设计文档硬性要求）：仅在「触发时」截一帧，截图只存在于内存
 * Buffer，绝不上传原图、不在本机持久化；分析完成后由调用方丢弃引用，
 * 满足「截图仅一帧、30 秒内删除」的承诺。
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
 * @returns {Promise<{buffer:Buffer, base64:string, width:number, height:number, source:string}>}
 */
async function captureActiveWindow({ maxWidth = MAX_WIDTH, maxHeight = MAX_HEIGHT, quality = JPEG_QUALITY, skipName } = {}) {
  if (!_electron) throw new Error('capture 只能在 Electron 主进程中使用');
  const { desktopCapturer, nativeImage } = _electron;

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  if (!sources.length) throw new Error('没有可用的截图源');

  const skip = skipName instanceof RegExp ? skipName
    : (typeof skipName === 'string' ? new RegExp(skipName, 'i') : null);

  // 优先前台应用窗口（排除本应用浮窗/主窗口），否则退回整屏。
  const winSources = sources.filter((s) => s.id.startsWith('window:'));
  let source = winSources.find((s) => {
    if (!s.name) return false;
    if (skip && skip.test(s.name)) return false;
    return !/hermes buddy|hermes-buddy/i.test(s.name);
  });
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
}

/** 截整个主屏幕（用于「用户在哪儿」的兜底）。 */
async function captureScreen(opts) {
  return captureActiveWindow(Object.assign({ skipName: /.*/ }, opts || {}));
}

module.exports = { available, captureActiveWindow, captureScreen, MAX_WIDTH, MAX_HEIGHT };
