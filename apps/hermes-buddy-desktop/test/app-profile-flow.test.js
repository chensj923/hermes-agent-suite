'use strict';

/**
 * v4.11.0「应用画像 + 结晶」接入回归测试。
 *
 * 锁住的行为：
 *  1. 前台切到收录内的应用 → 直接给出这个应用最常用的 3 个行为（不再让远端盲猜）；
 *  2. 用户点某个行为 → 生成方向用该行为的 prompt；可插入的行为写进窗口；
 *  3. 游戏类：给出攻略/过程/任务三件套，且绝不往游戏窗口里打字节；
 *  4. 每次命中都记录行为模式，用户接受/拒绝记进结晶；
 *  5. 后台结晶能跑（淘汰 + 固化）；
 *  6. 每应用冷却生效，切回同一个应用不反复打扰。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');
const { PredictController } = require('../src/predict/predict-controller');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'appflow-')); }
function noopLogger() { return { info() {}, warn() {}, error() {}, debug() {} }; }

function makeController({ choice = 'later', generate = null } = {}) {
  const shown = [];
  const genCalls = [];
  const execCalls = [];
  const steps = [];
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: noopLogger(),
    capture: { captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600 }) },
    panel: {
      available: true,
      beginFlow() {},
      pushStep(id, o) { steps.push({ id, ...o }); },
      show: async (s) => { shown.push(s); return choice; },
      showThinking() {},
      cancelThinking() {},
      dismissAwaiting() {},
      destroy() {},
    },
    actionExecutor: { execute: async (a) => { execCalls.push(a); return { ok: true }; } },
    generateContentFn: async (payload, image) => {
      genCalls.push({ payload, image });
      return { content: generate || '这是生成出来的正文内容。' };
    },
  });
  ctrl.config.set({ enabled: true, authorized: true, model: 'remote', autoInsert: true });
  ctrl._enabled = true;
  return { ctrl, shown, genCalls, execCalls, steps };
}

test('命中 WPS：直接给出这个应用最常用的 3 个行为', async () => {
  const { ctrl, shown } = makeController({ choice: 'later' });
  await ctrl.onWindowChange({ exeName: 'wps.exe', title: '游戏运维总结 - WPS Office', windowClass: 'Wps_Application' });
  assert.strictEqual(shown.length, 1, '应弹出行为卡片');
  const s = shown[0];
  assert.strictEqual(s.appProfile.id, 'wps');
  assert.strictEqual(s.appProfile.categoryLabel, '办公文档');
  assert.strictEqual(s.behaviors.length, 3, '应给出 3 个行为');
  const names = s.behaviors.map((b) => b.name);
  assert.deepStrictEqual(names, ['起草正文', '润色改写', '列大纲']);
});

test('用户点「起草正文」：按该行为的方向生成，并写入窗口', async () => {
  const { ctrl, shown, genCalls, execCalls } = makeController({
    choice: { choice: 'behavior', behaviorId: 'draft', topic: '' },
  });
  await ctrl.onWindowChange({ exeName: 'wps.exe', title: '游戏运维总结' });
  assert.strictEqual(genCalls.length, 1, '应发起一次生成');
  // 生成方向必须是该行为自己的 prompt
  assert.ok(/根据窗口标题与屏幕内容确定主题/.test(genCalls[0].payload.direction),
    'direction 应是 draft 的 prompt，实际：' + genCalls[0].payload.direction);
  assert.strictEqual(genCalls[0].payload.rule, 'word_writing');
  // 可插入行为 → 真的往窗口里写
  assert.ok(execCalls.length >= 1, '应执行插入动作');
  assert.ok(!execCalls.some((a) => a.type === 'clipboard-keep'), '插入类行为应走打字/粘贴而不是只留剪贴板');
  // 拒绝/接受要记进结晶
  assert.strictEqual(ctrl.getCrystalSummary().patterns, 3, '3 个行为都应被记录');
});

test('游戏类：给攻略/过程/任务三件套，且绝不往游戏里打字', async () => {
  const { ctrl, shown, genCalls, execCalls } = makeController({
    choice: { choice: 'behavior', behaviorId: 'guide', topic: '' },
    generate: '这一关先清小怪再拉 boss，注意躲红圈。',
  });
  await ctrl.onWindowChange({ exeName: 'YuanShen.exe', title: '原神', windowClass: 'UnityWndClass' });
  const s = shown[0];
  assert.strictEqual(s.appProfile.isGame, true);
  assert.deepStrictEqual(s.behaviors.map((b) => b.name), ['攻略推荐', '过程推荐', '任务与养成建议']);
  assert.strictEqual(genCalls.length, 1);
  assert.ok(/资深游戏攻略作者/.test(genCalls[0].payload.direction), '应使用攻略行为的 prompt');
  // 关键：只写剪贴板 + 展示，绝不模拟输入
  assert.ok(execCalls.length >= 1);
  assert.ok(execCalls.every((a) => a.type === 'clipboard-keep'),
    '游戏里只能写剪贴板，实际动作：' + JSON.stringify(execCalls.map((a) => a.type)));
});

test('结晶：接受过 2 次以上的行为下次直接自动执行，不再问', async () => {
  const { ctrl, shown, genCalls } = makeController();
  const wi = { exeName: 'wps.exe', title: '游戏运维总结' };
  // 先手动把 draft 养成高频高接受率（模拟用了几次后的结晶结果）
  ctrl.crystal.record({ appId: 'wps', behaviorId: 'draft', intent: 'word_writing', text: '起草正文' });
  ctrl.crystal.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  ctrl.crystal.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  ctrl.crystal.crystallize();
  await ctrl.onWindowChange(wi);
  assert.strictEqual(shown.length, 0, '结晶出的常用行为应直接执行，不再弹确认框');
  assert.strictEqual(genCalls.length, 1, '应直接生成');
});

test('每应用冷却：短时间内切回同一应用不重复打扰', async () => {
  const { ctrl, shown } = makeController({ choice: 'later' });
  const wi = { exeName: 'chrome.exe', title: 'Hermes 文档' };
  await ctrl.onWindowChange(wi);
  await ctrl.onWindowChange(wi);
  assert.strictEqual(shown.length, 1, '冷却期内不应再弹');
});

test('未收录的应用：不弹画像卡片（交回原有链路）', async () => {
  const { ctrl, shown } = makeController({ choice: 'later' });
  await ctrl.onWindowChange({ exeName: 'some-random-tool.exe', title: 'x' });
  assert.strictEqual(shown.length, 0);
});

test('后台结晶：可强制执行并记录运行次数', async () => {
  const { ctrl } = makeController();
  await ctrl.onWindowChange({ exeName: 'wps.exe', title: '文档' });
  const before = ctrl.getCrystalSummary();
  const r = await ctrl.runBackgroundCrystal(true);
  assert.ok(r, '强制结晶应返回结果');
  const after = ctrl.getCrystalSummary();
  assert.strictEqual(after.runs, before.runs + 1);
});

test('结晶预测可被取用（按置信度排序）', async () => {
  const { ctrl } = makeController();
  for (let i = 0; i < 2; i++) {
    ctrl.crystal.record({ appId: 'wps', behaviorId: 'draft', text: '起草正文' });
    ctrl.crystal.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  }
  ctrl.crystal.crystallize();
  const preds = ctrl.getCrystalPredictions('wps');
  assert.strictEqual(preds.length, 1);
  assert.strictEqual(preds[0].behaviorId, 'draft');
  assert.ok(preds[0].confidence >= 0.6);
});
