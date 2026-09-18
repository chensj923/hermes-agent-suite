'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

let tray = null;

const DEFAULT_ICON = path.join(__dirname, 'assets', 'tray-icon.png');

/**
 * 决定主窗口收到 close 事件时该怎么处理。
 * 有托盘时默认「隐藏到托盘」，避免用户关闭主窗口后失去入口；
 * 真正退出（托盘「退出」/ before-quit）时 isQuitting=true，正常关闭。
 */
function resolveCloseBehavior({ isQuitting, hasTray, platform }) {
  if (isQuitting) return 'quit';
  if (hasTray) return 'hide-to-tray';
  return platform === 'darwin' ? 'hide-to-tray' : 'quit';
}

function loadIcon(iconPath, nativeImageImpl = nativeImage) {
  try {
    const buf = fs.readFileSync(iconPath);
    return nativeImageImpl.createFromBuffer(buf);
  } catch (_) {
    return nativeImageImpl.createEmpty();
  }
}

function buildContextMenu(handlers, MenuImpl = Menu) {
  const items = [
    { label: '打开 Hermes Buddy', click: () => handlers.onShowMainWindow() },
  ];
  if (handlers.hasPet) {
    items.push({ label: '显示桌宠', click: () => handlers.onShowPet() });
  }
  items.push(
    { label: '立即预测', click: () => handlers.onProactivePredict() },
    { type: 'separator' },
    { label: '退出', click: () => handlers.onQuit() }
  );
  return MenuImpl.buildFromTemplate(items);
}

/**
 * 创建系统托盘常驻图标。
 * @param {Object} opts
 * @param {string} [opts.iconPath]      托盘图标路径，默认 src/assets/tray-icon.png
 * @param {Object} opts.logger
 * @param {Object} opts.handlers
 * @param {()=>void} opts.handlers.onShowMainWindow
 * @param {()=>void} opts.handlers.onShowPet
 * @param {()=>void|Promise<void>} opts.handlers.onProactivePredict
 * @param {()=>void} opts.handlers.onQuit
 * @param {boolean} [opts.hasPet=false]
 * @returns {Tray}
 */
function createTray({ iconPath = DEFAULT_ICON, logger = null, handlers = {}, hasPet = false } = {}) {
  if (tray) return tray;

  const image = loadIcon(iconPath);
  if (image.isEmpty()) {
    if (logger) logger.warn('tray-icon-missing', { iconPath });
  }

  tray = new Tray(image);
  tray.setToolTip('Hermes Buddy');
  tray.setContextMenu(buildContextMenu({ ...handlers, hasPet }));
  tray.on('click', () => handlers.onShowMainWindow && handlers.onShowMainWindow());
  if (logger) logger.info('tray-created');
  return tray;
}

function destroyTray() {
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
}

function setTrayVisible(visible) {
  // Electron Tray 没有 setVisible，重建成本最低；目前仅提供 destroyTray。
  if (!visible) destroyTray();
}

module.exports = {
  createTray,
  destroyTray,
  setTrayVisible,
  resolveCloseBehavior,
  buildContextMenu,
  // 导出内部函数便于测试
  _loadIcon: loadIcon,
  _getTray: () => tray,
};
