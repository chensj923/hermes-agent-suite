'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { DEFAULT_SCENE_RULES, normalizeSceneRules, matchRule, createSceneWatcher } = require('../src/predict/scene-rules');
const { PredictController } = require('../src/predict/predict-controller');

function makeController({ choice = 'later' } = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rules-'));
  const captured = { suggestion: null, actionCalls: [] };
  const fakePanel = { available: true, show: async (s) => { captured.suggestion = s; return choice; }, destroy() {} };
  const fakeAction = { execute: async (a) => { captured.actionCalls.push(a); return { ok: true, type: a.type }; } };
  const ctrl = new PredictController({
    appDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    panel: fakePanel,
    actionExecutor: fakeAction,
  });
  // v4.11.0：应用画像（100+ 软件 × 3 行为）默认优先于场景规则；
  // 本文件测的是场景规则本身，显式关掉画像让它走旧路径。
  ctrl.config.set({ model: 'none', enabled: true, authorized: true, appProfilesEnabled: false });
  return { ctrl, captured };
}

test('默认场景规则：WPS 新文档（无扩展名标题）命中，已有文档命中润色规则', () => {
  const rules = normalizeSceneRules(DEFAULT_SCENE_RULES);
  // 新文档：标题无 .docx 扩展名 → 命中 scene-wps-new，排除规则不挡
  const newDoc = rules.find((r) => r.id === 'scene-wps-new');
  assert.strictEqual(matchRule(newDoc, { exeName: 'wps', title: '新建 文档' }), true);
  // 已有文档：标题含 .docx → scene-wps-new 被 titleExclude 排除，润色规则命中
  assert.strictEqual(matchRule(newDoc, { exeName: 'wps', title: '运维年终报告.docx - WPS Office' }), false);
  const polish = rules.find((r) => r.id === 'scene-wps-polish');
  assert.strictEqual(matchRule(polish, { exeName: 'wps', title: '运维年终报告.docx - WPS Office' }), true);
  assert.strictEqual(matchRule(polish, { exeName: 'wps', title: '新建 文档' }), false);
});

test('默认场景规则：微信/QQ 规则默认禁用（社交场景须显式开启），启用后命中', () => {
  const rules = normalizeSceneRules(DEFAULT_SCENE_RULES);
  const im = rules.find((r) => r.id === 'scene-im-reply');
  assert.strictEqual(im.enabled, false, 'IM 自动回复默认应关闭');
  assert.strictEqual(matchRule(im, { exeName: 'WeChat', title: '微信' }), false, '禁用状态不命中');
  const enabled = { ...im, enabled: true };
  assert.strictEqual(matchRule(enabled, { exeName: 'WeChat', title: '微信' }), true);
  assert.strictEqual(matchRule(enabled, { exeName: 'qq', title: 'QQ' }), true);
  assert.strictEqual(matchRule(enabled, { exeName: 'chrome', title: '微信网页版' }), false);
});

test('createSceneWatcher：命中后进冷却，冷却期内同规则不重复命中', () => {
  let ts = 1000000;
  const watcher = createSceneRules([
    { id: 'a', enabled: true, exeNames: ['wps'], intent: 'word_writing', suggestion: '写吗？', cooldownMin: 10 },
  ], { now: () => ts });
  const hit1 = watcher.feed({ exeName: 'wps', title: '报告' });
  assert.ok(hit1, '首次应命中');
  assert.strictEqual(watcher.feed({ exeName: 'wps', title: '报告' }), null, '冷却期内不重复命中');
  ts += 10 * 60 * 1000 + 1;
  const hit2 = watcher.feed({ exeName: 'wps', title: '报告' });
  assert.ok(hit2, '冷却过后应再次命中');
  function createSceneRules(list, opts) { return createSceneWatcher(list, opts); }
});

test('onWindowChange：命中场景规则 → 直接弹浮窗（不截图不推断）', async () => {
  const { ctrl, captured } = makeController({ choice: 'later' });
  ctrl._enabled = true; // 模拟 enable() 后状态（enable() 会启动真实钩子，测试环境不可用）
  await ctrl.onWindowChange({ exeName: 'wps', title: '运维年终报告.docx - WPS Office' });
  assert.ok(captured.suggestion, '应直接展示建议');
  assert.strictEqual(captured.suggestion.intent, 'word_writing');
  assert.ok(/场景规则/.test(captured.suggestion.reason));
  // 推理记录里应有一条 scene 触发
  const entries = ctrl.getLog();
  assert.ok(entries.some((e) => e.rule && String(e.rule).startsWith('scene:')), '应记录 scene 触发');
});

test('onWindowChange：点「生成并插入」→ 场景提示词方向随生成请求上行', async () => {
  const { ctrl } = makeController({ choice: 'generate' });
  ctrl._enabled = true;
  let payload = null;
  ctrl._generateContentFn = async (p) => { payload = p; return { content: '生成的内容。' }; };
  ctrl._lastObservation = '';
  await ctrl.onWindowChange({ exeName: 'wps', title: '项目方案.docx - Word' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(payload, '生成函数应被调用');
  const polish = normalizeSceneRules(DEFAULT_SCENE_RULES).find((r) => r.id === 'scene-wps-polish');
  assert.strictEqual(payload.direction, polish.prompt, 'direction 必须是场景规则的 prompt');
});

test('v4.11.0：开启应用画像时，画像优先于场景规则（给出 3 个行为而不是一句场景话术）', async () => {
  const { ctrl, captured } = makeController({ choice: 'later' });
  ctrl.config.set({ appProfilesEnabled: true });   // 默认策略
  ctrl._enabled = true;
  await ctrl.onWindowChange({ exeName: 'wps', title: '运维年终报告.docx - WPS Office' });
  assert.ok(captured.suggestion, '应展示建议');
  assert.ok(/应用画像/.test(captured.suggestion.reason), 'reason 应来自应用画像，实际：' + captured.suggestion.reason);
  assert.strictEqual(captured.suggestion.behaviors.length, 3);
});

test('normalizeSceneRules：非法条目剔除 + id 去重', () => {
  const out = normalizeSceneRules([
    { id: 'x', exeNames: 'wps' },
    { id: 'x', exeNames: 'qq' },      // 重复 id，丢弃
    { exeNames: 'no-id' },             // 无 id，丢弃
    null,
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'x');
});
