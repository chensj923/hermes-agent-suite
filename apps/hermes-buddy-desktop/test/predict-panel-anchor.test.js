'use strict';

/**
 * PredictPanel 定位逻辑单测：通过 Module._load 注入 fake electron，
 * 验证 v4.1 桌宠锚定（anchorProvider）与无锚点回退（鼠标旁）两种定位路径。
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const Module = require('module');
const { test } = require('node:test');

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

const fakeScreen = {
  getCursorScreenPoint: () => ({ x: 500, y: 500 }),
  getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
  getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
};
const fakeElectron = { screen: fakeScreen, BrowserWindow: function FakeWin() {}, ipcMain: { on() {} } };

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};
const { PredictPanel, PANEL_WIDTH, PANEL_HEIGHT } = require('../src/predict/predict-panel');
Module._load = origLoad;

function makePanel(anchorReturnValue) {
  const panel = new PredictPanel({
    logger: { info() {}, warn() {}, error() {} },
    preloadPath: path.join(os.tmpdir(), 'noop.js'),
    anchorProvider: () => anchorReturnValue,
  });
  const positions = [];
  const fakeWin = { setPosition: (x, y) => positions.push({ x, y }) };
  return { panel, positions, fakeWin };
}

test('桌宠可见且右侧放得下 → 浮层弹在猫咪右侧居中', () => {
  const pet = { x: 1300, y: 800, width: 170, height: 190 };
  const { panel, positions, fakeWin } = makePanel(pet);
  panel._position(fakeWin);
  assert.strictEqual(positions.length, 1);
  // 右侧放得下（1300+170+12+360 = 1842 ≤ 1920）→ x = 宠物右边 + 12
  const p = positions[0];
  assert.strictEqual(p.x, pet.x + pet.width + 12);
  // y = 宠物垂直居中
  assert.strictEqual(p.y, Math.round(pet.y + (pet.height - PANEL_HEIGHT) / 2));
});

test('桌宠贴右边缘 → 浮层换到左侧', () => {
  const pet = { x: 1740, y: 500, width: 170, height: 190 };
  const { panel, positions, fakeWin } = makePanel(pet);
  panel._position(fakeWin);
  const p = positions[0];
  // 右侧放不下（1740+170+12+360 > 1920）→ 换左侧
  assert.strictEqual(p.x, pet.x - PANEL_WIDTH - 12);
});

test('浮层 clamp 到屏幕可用区内，不会弹到屏幕外', () => {
  const pet = { x: 1700, y: 900, width: 170, height: 190 };
  const { panel, positions, fakeWin } = makePanel(pet);
  panel._position(fakeWin);
  const p = positions[0];
  assert.ok(p.x >= WORK_AREA.x, 'x 不越左边界');
  assert.ok(p.x + PANEL_WIDTH <= WORK_AREA.x + WORK_AREA.width + 1, 'x 不越右边界');
  assert.ok(p.y + PANEL_HEIGHT <= WORK_AREA.y + WORK_AREA.height + 1, 'y 不越下边界');
});

test('桌宠不可见（anchor=null）→ 回退鼠标旁定位', () => {
  const { panel, positions, fakeWin } = makePanel(null);
  panel._position(fakeWin);
  assert.strictEqual(positions.length, 1);
  // 鼠标在 (500,500)，右侧放得下 → x=516, y=516
  assert.strictEqual(positions[0].x, 516);
  assert.strictEqual(positions[0].y, 516);
});

test('anchorProvider 抛错不影响定位（回退鼠标旁）', () => {
  const panel = new PredictPanel({
    logger: { info() {}, warn() {}, error() {} },
    anchorProvider: () => { throw new Error('pet gone'); },
  });
  const positions = [];
  const fakeWin = { setPosition: (x, y) => positions.push({ x, y }) };
  panel._position(fakeWin);
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].x, 516);
});

test('v4.10.37：armThinkingTimeout 重新计时会取消上一个安全网（旧的短定时器不再误触发）', async () => {
  let fired = 0;
  const panel = new PredictPanel({
    logger: { info() {}, warn() {}, error() {} },
    onThinkingTimeout: () => { fired += 1; },
  });
  // 先 arm 一个 40ms 后就会触发的定时器（模拟旧的 45s 安全网，已快到点）
  panel.armThinkingTimeout(40);
  // 20ms 后（旧定时器还没触发）用 5s 重新 arm —— 旧的必须被取消
  await new Promise((r) => setTimeout(r, 20));
  panel.armThinkingTimeout(5000);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(fired, 0, '重新 arm 后旧安全网应被取消，不能按旧时间点误降级');
});

test('v4.10.37：已进入建议态（_pending 有值）时安全网到点不误关、不降级', async () => {
  let fired = 0;
  const panel = new PredictPanel({
    logger: { info() {}, warn() {}, error() {} },
    onThinkingTimeout: () => { fired += 1; },
  });
  panel._pending = { resolve() {} };   // 用户正在看建议
  panel.armThinkingTimeout(30);
  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual(fired, 0, '等待用户决策期间安全网不应触发');
});

