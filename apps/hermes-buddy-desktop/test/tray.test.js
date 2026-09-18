'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');

// 给 src/tray.js 提供 Electron 存根
class FakeTray {
  constructor(image) {
    this.image = image;
    this.tooltip = '';
    this.menu = null;
    this.clickHandler = null;
    this.destroyed = false;
  }
  setToolTip(t) { this.tooltip = t; }
  setContextMenu(m) { this.menu = m; }
  on(evt, fn) { if (evt === 'click') this.clickHandler = fn; }
  destroy() { this.destroyed = true; }
}

const builtMenus = [];
const mockElectron = {
  Tray: FakeTray,
  Menu: {
    buildFromTemplate: (tpl) => {
      builtMenus.push(tpl);
      return tpl;
    },
  },
  nativeImage: {
    createFromBuffer: (buf) => ({ buf, isEmpty: () => false }),
    createEmpty: () => ({ isEmpty: () => true }),
  },
};

require.cache[require.resolve('electron')] = { id: 'electron', exports: mockElectron };

const trayModule = require('../src/tray.js');
const { resolveCloseBehavior, buildContextMenu, createTray, destroyTray, _loadIcon } = trayModule;

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

test('resolveCloseBehavior：真正退出时始终 quit', () => {
  assert.strictEqual(resolveCloseBehavior({ isQuitting: true, hasTray: true }), 'quit');
  assert.strictEqual(resolveCloseBehavior({ isQuitting: true, hasTray: false }), 'quit');
});

test('resolveCloseBehavior：有托盘时隐藏到托盘', () => {
  assert.strictEqual(resolveCloseBehavior({ isQuitting: false, hasTray: true, platform: 'win32' }), 'hide-to-tray');
  assert.strictEqual(resolveCloseBehavior({ isQuitting: false, hasTray: true, platform: 'darwin' }), 'hide-to-tray');
});

test('resolveCloseBehavior：无托盘时按平台降级', () => {
  assert.strictEqual(resolveCloseBehavior({ isQuitting: false, hasTray: false, platform: 'win32' }), 'quit');
  assert.strictEqual(resolveCloseBehavior({ isQuitting: false, hasTray: false, platform: 'darwin' }), 'hide-to-tray');
});

test('buildContextMenu：包含打开/预测/退出，无宠物时不显示桌宠项', () => {
  const calls = { showMain: 0, showPet: 0, predict: 0, quit: 0 };
  const menu = buildContextMenu({
    onShowMainWindow: () => calls.showMain++,
    onShowPet: () => calls.showPet++,
    onProactivePredict: () => calls.predict++,
    onQuit: () => calls.quit++,
    hasPet: false,
  });
  assert.strictEqual(menu.length, 4);
  assert.strictEqual(menu[0].label, '打开 Hermes Buddy');
  assert.strictEqual(menu[1].label, '立即预测');
  assert.strictEqual(menu[2].type, 'separator');
  assert.strictEqual(menu[3].label, '退出');
  menu[0].click();
  menu[1].click();
  menu[3].click();
  assert.strictEqual(calls.showMain, 1);
  assert.strictEqual(calls.showPet, 0);
  assert.strictEqual(calls.predict, 1);
  assert.strictEqual(calls.quit, 1);
});

test('buildContextMenu：有宠物时包含显示桌宠项', () => {
  const menu = buildContextMenu({
    onShowMainWindow() {},
    onShowPet() {},
    onProactivePredict() {},
    onQuit() {},
    hasPet: true,
  });
  assert.strictEqual(menu.length, 5);
  assert.strictEqual(menu[1].label, '显示桌宠');
});

test('createTray 单例与托盘菜单交互', () => {
  const calls = { showMain: 0 };
  const first = createTray({
    logger: noopLogger(),
    handlers: {
      onShowMainWindow: () => calls.showMain++,
      onShowPet() {},
      onProactivePredict() {},
      onQuit() {},
    },
    hasPet: true,
  });
  const second = createTray({ logger: noopLogger(), handlers: {}, hasPet: false });
  assert.strictEqual(first, second, '重复创建应返回同一托盘实例');
  assert.strictEqual(first.tooltip, 'Hermes Buddy');
  assert.strictEqual(first.menu.length, 5);
  assert.ok(first.clickHandler, '左键点击应绑定恢复主窗口');
  first.clickHandler();
  assert.strictEqual(calls.showMain, 1);
  destroyTray();
  assert.strictEqual(first.destroyed, true);
});

test('loadIcon 读取真实图标文件成功', () => {
  const img = _loadIcon(path.join(__dirname, '..', 'src', 'assets', 'tray-icon.png'), mockElectron.nativeImage);
  assert.strictEqual(img.isEmpty(), false);
});
