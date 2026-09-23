'use strict';

/**
 * v4.10.40 步骤面板单测：通过 Module._load 注入 fake electron，验证
 * - beginFlow 递增 flowSeq；
 * - pushStep 按 flowSeq 命名空间（跨轮同语义 id 不互相覆盖，聊天小框观感）；
 * - 同一 flowSeq 内同 id 推送 id 不变（渲染端原地更新）。
 */

const assert = require('assert');
const Module = require('module');
const { test } = require('node:test');

const fakeScreen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
};

let sent = [];
const fakeWin = {
  webContents: {
    on() {},
    send(ch, data) { sent.push({ ch, data }); },
  },
  loadFile() {}, setSize() {}, show() {}, hide() {}, moveTop() {},
  setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, setPosition() {}, destroy() {},
};
const fakeElectron = {
  screen: fakeScreen,
  BrowserWindow: function FakeWin() { return fakeWin; },
  ipcMain: { on() {} },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};
const { PredictPanel } = require('../src/predict/predict-panel');
Module._load = origLoad;

function makePanel() {
  const p = new PredictPanel({ logger: { info() {}, warn() {}, error() {} } });
  // 跳过真实窗口创建/加载：直接就绪
  p._ready = true;
  p.win = fakeWin;
  p._ensureReady = () => Promise.resolve(fakeWin);
  p._showWindow = () => {};
  sent = [];
  return p;
}

test('beginFlow 递增 flowSeq，pushStep 按 flowSeq 命名空间，跨轮同 id 不覆盖', async () => {
  const p = makePanel();
  p.beginFlow('第1轮');
  p.pushStep('trigger', { title: '触发', status: 'done' });
  p.beginFlow('第2轮');
  p.pushStep('trigger', { title: '触发2', status: 'done' });
  await new Promise((r) => setTimeout(r, 10));
  const steps = sent.filter((s) => s.ch === 'predict-panel:step' && /:trigger$/.test(s.data.id));
  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].data.id, '1:trigger');
  assert.strictEqual(steps[1].data.id, '2:trigger');
  assert.strictEqual(steps[0].data.title, '触发');
  assert.strictEqual(steps[1].data.title, '触发2');
});

test('同一 flowSeq 内同 id 推送 id 不变（渲染端原地更新）', async () => {
  const p = makePanel();
  p.beginFlow('轮');
  p.pushStep('vl', { title: '读图中', status: 'pending' });
  p.pushStep('vl', { title: '读图完成', status: 'done', detail: '10 字' });
  await new Promise((r) => setTimeout(r, 10));
  const steps = sent.filter((s) => s.ch === 'predict-panel:step' && /:vl$/.test(s.data.id));
  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].data.id, '1:vl');
  assert.strictEqual(steps[1].data.id, '1:vl');
  assert.strictEqual(steps[1].data.status, 'done');
});
