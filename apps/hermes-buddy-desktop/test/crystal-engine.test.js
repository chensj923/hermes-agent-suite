'use strict';

/**
 * v4.11.0 结晶引擎回归测试。
 * 锁住：记录行为模式 → 后台结晶（淘汰过期/低接受率 + 固化新预测）→ 按置信度取预测。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');
const { CrystalEngine, keyOf } = require('../src/predict/crystal-engine');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'crystal-')); }
function make(clockStart) {
  let t = clockStart || 1000000;
  const now = () => t;
  const c = new CrystalEngine({ dataDir: tmpDir(), now });
  return { c, advance: (ms) => { t += ms; }, now: () => t };
}

test('keyOf：appId 与 behaviorId 拼成稳定 key', () => {
  assert.strictEqual(keyOf('wps', 'draft'), 'wps::draft');
  assert.strictEqual(keyOf(undefined, undefined), 'unknown::unknown');
});

test('record：命中次数与最近时间累加，文案以最新为准', () => {
  const { c, advance } = make();
  c.record({ appId: 'wps', behaviorId: 'draft', intent: 'word_writing', text: '起草' });
  advance(1000);
  c.record({ appId: 'wps', behaviorId: 'draft', intent: 'word_writing', text: '起草正文' });
  const s = c.scoreOf('wps', 'draft');
  assert.strictEqual(s.hits, 2);
  const pred = c.predictionsFor('wps');
  assert.strictEqual(pred.length, 0, '未结晶前不应有预测');
});

test('recordOutcome：接受/拒绝计入接受率', () => {
  const { c } = make();
  c.record({ appId: 'wps', behaviorId: 'draft' });
  c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, false);
  const s = c.scoreOf('wps', 'draft');
  assert.strictEqual(s.accepts, 2);
  assert.strictEqual(s.rejects, 1);
  assert.ok(Math.abs(s.acceptRate - 2 / 3) < 1e-9);
});

test('冷启动：没有任何决策时给偏中性的置信度', () => {
  const { c } = make();
  c.record({ appId: 'chrome', behaviorId: 'summary' });
  const s = c.scoreOf('chrome', 'summary');
  assert.strictEqual(s.hits, 1);
  assert.ok(s.confidence > 0 && s.confidence <= 0.5, '冷启动分应 ≤0.5，实际 ' + s.confidence);
});

test('shouldCrystal：首次要攒够 2 条行为，之后按间隔', () => {
  const { c, advance } = make();
  assert.strictEqual(c.shouldCrystal(), false);
  c.record({ appId: 'wps', behaviorId: 'draft' });
  assert.strictEqual(c.shouldCrystal(), false, '仅 1 条行为不结晶');
  c.record({ appId: 'wps', behaviorId: 'draft' });
  assert.strictEqual(c.shouldCrystal(), true);
  c.crystallize();
  assert.strictEqual(c.shouldCrystal(), false, '刚结晶完且无新行为');
  c.record({ appId: 'wps', behaviorId: 'draft' });
  assert.strictEqual(c.shouldCrystal(), false, '新行为但间隔不够');
  // 过了结晶间隔后再产生一条新行为 → 应再次结晶
  advance(7 * 60 * 60 * 1000);
  c.record({ appId: 'wps', behaviorId: 'draft' });
  assert.strictEqual(c.shouldCrystal(), true, '超过 6 小时且有新行为应再结晶');
});

test('crystallize：高频高接受率模式固化成预测，并按置信度排序', () => {
  const { c } = make();
  // draft：3 次命中全接受
  for (let i = 0; i < 3; i++) { c.record({ appId: 'wps', behaviorId: 'draft', text: '起草正文' }); c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true); }
  // polish：3 次命中全拒绝 → 不该结晶
  for (let i = 0; i < 3; i++) { c.record({ appId: 'wps', behaviorId: 'polish', text: '润色' }); c.recordOutcome({ appId: 'wps', behaviorId: 'polish' }, false); }
  const r = c.crystallize();
  assert.ok(r.added.includes('wps::draft'), 'draft 应结晶：' + JSON.stringify(r.added));
  assert.ok(!r.added.includes('wps::polish'), 'polish 不该结晶');
  const preds = c.predictionsFor('wps');
  assert.strictEqual(preds.length, 1);
  assert.strictEqual(preds[0].confidence, 1);
  assert.strictEqual(preds[0].text, '起草正文');
});

test('crystallize：过期模式被淘汰（超过 21 天没再出现）', () => {
  const { c, advance } = make();
  for (let i = 0; i < 3; i++) { c.record({ appId: 'wps', behaviorId: 'draft' }); c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true); }
  c.crystallize();
  assert.strictEqual(c.predictionsFor('wps').length, 1);
  advance(22 * 24 * 60 * 60 * 1000);
  c.record({ appId: 'wps', behaviorId: 'polish' });
  const r = c.crystallize();
  const reason = (r.retired.find((x) => x.key === 'wps::draft') || {}).reason;
  assert.strictEqual(reason, 'expired', '过期模式应被淘汰：' + JSON.stringify(r.retired));
  assert.strictEqual(c.predictionsFor('wps').length, 0, '对应预测应一并失效');
});

test('crystallize：接受率过低的模式被淘汰（样本 ≥4 且 <0.25）', () => {
  const { c } = make();
  for (let i = 0; i < 5; i++) {
    c.record({ appId: 'wps', behaviorId: 'polish' });
    c.recordOutcome({ appId: 'wps', behaviorId: 'polish' }, i === 0); // 只接受 1 次
  }
  const r = c.crystallize();
  const item = r.retired.find((x) => x.key === 'wps::polish');
  assert.ok(item, '低接受率模式应被淘汰');
  assert.strictEqual(item.reason, 'low-accept-rate');
});

test('每应用最多保留 3 条预测', () => {
  const { c } = make();
  for (const b of ['draft', 'polish', 'outline', 'summary', 'translate']) {
    for (let i = 0; i < 2; i++) { c.record({ appId: 'wps', behaviorId: b }); c.recordOutcome({ appId: 'wps', behaviorId: b }, true); }
  }
  c.crystallize();
  assert.ok(c.predictionsFor('wps').length <= 3, '每应用预测上限 3，实际 ' + c.predictionsFor('wps').length);
});

test('落盘：重启后数据仍在', () => {
  const dir = tmpDir();
  const c1 = new CrystalEngine({ dataDir: dir });
  c1.record({ appId: 'wps', behaviorId: 'draft', text: '起草' });
  c1.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true);
  const c2 = new CrystalEngine({ dataDir: dir });
  assert.strictEqual(c2.scoreOf('wps', 'draft').accepts, 1);
  assert.strictEqual(c2.scoreOf('wps', 'draft').hits, 1);
});

test('reset：一键清空', () => {
  const { c } = make();
  c.record({ appId: 'wps', behaviorId: 'draft' });
  c.reset();
  assert.strictEqual(c.scoreOf('wps', 'draft').hits, 0);
});

test('summary：统计模式数/预测数/结晶次数', () => {
  const { c } = make();
  for (let i = 0; i < 2; i++) { c.record({ appId: 'wps', behaviorId: 'draft' }); c.recordOutcome({ appId: 'wps', behaviorId: 'draft' }, true); }
  c.crystallize();
  const s = c.summary();
  assert.strictEqual(s.predictions, 1);
  assert.strictEqual(s.runs, 1);
  assert.ok(s.lastCrystalAt > 0);
});

test('事件流水：只存元数据，不存窗口标题', () => {
  const dir = tmpDir();
  const c = new CrystalEngine({ dataDir: dir });
  c.record({ appId: 'wps', behaviorId: 'draft', title: '机密文档标题' });
  const raw = fs.readFileSync(path.join(dir, 'crystal.json'), 'utf8');
  assert.ok(!/机密文档标题/.test(raw), '窗口标题绝不能落盘');
});
