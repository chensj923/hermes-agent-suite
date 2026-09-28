'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ExperienceCrystal } = require('../src/predict/experience-crystal');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-')); }
const T0 = 1_000_000;

test('script 分级：高频 + 高接受 + 低变体 → tier=script', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  for (let i = 0; i < 5; i++) c.record({ appId: 'wechat', behaviorId: 'reply', intent: 'message_reply', text: '收到，马上处理' });
  for (let i = 0; i < 4; i++) c.recordOutcome({ appId: 'wechat', behaviorId: 'reply', intent: 'message_reply' }, true);
  c.recordOutcome({ appId: 'wechat', behaviorId: 'reply', intent: 'message_reply' }, false);
  const r = c.crystallize();
  assert.strictEqual(r.added.length, 1);
  const ex = c.allExperiences()[0];
  assert.strictEqual(ex.tier, 'script');
  assert.strictEqual(ex.kind, 'reply');
  assert.ok(ex.artifact.script && ex.artifact.script.auto === true);
  assert.strictEqual(ex.acceptRate, 0.8);
});

test('model 分级：高频 + 高变体 → tier=model', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  const variants = ['回复A情况', '回复B另一', '回复C第三', '回复D第四', '回复E第五', '回复F第六'];
  for (let i = 0; i < 6; i++) c.record({ appId: 'mail', behaviorId: 'compose', intent: 'word_writing', text: variants[i] });
  for (let i = 0; i < 6; i++) c.recordOutcome({ appId: 'mail', behaviorId: 'compose', intent: 'word_writing' }, true);
  const r = c.crystallize();
  assert.strictEqual(r.added.length, 1);
  const ex = c.allExperiences()[0];
  assert.strictEqual(ex.tier, 'model');
  assert.ok(ex.artifact.modelPlan && /判断/.test(ex.artifact.modelPlan.prompt));
});

test('behavior 类：非生成意图归为 behavior', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  for (let i = 0; i < 4; i++) c.record({ appId: 'excel', behaviorId: 'fill', intent: 'fill_table', text: '按模板填充' });
  for (let i = 0; i < 4; i++) c.recordOutcome({ appId: 'excel', behaviorId: 'fill', intent: 'fill_table' }, true);
  c.crystallize();
  const ex = c.allExperiences()[0];
  assert.strictEqual(ex.kind, 'behavior');
  assert.strictEqual(ex.tier, 'script');
});

test('频率不足不结晶', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  c.record({ appId: 'x', behaviorId: 'y', intent: 'open_app' });
  c.record({ appId: 'x', behaviorId: 'y', intent: 'open_app' });
  const r = c.crystallize();
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(c.allExperiences().length, 0);
});

test('过期 pattern 触发经验淘汰', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  for (let i = 0; i < 5; i++) c.record({ appId: 'x', behaviorId: 'y', intent: 'open_app', text: '做X' });
  for (let i = 0; i < 5; i++) c.recordOutcome({ appId: 'x', behaviorId: 'y', intent: 'open_app' }, true);
  c.crystallize();
  assert.strictEqual(c.allExperiences().length, 1);
  // 直接把 pattern.lastAt 改旧，模拟长期未出现
  const d = c._load();
  const key = Object.keys(d.patterns)[0];
  d.patterns[key].lastAt = T0 - 31 * 24 * 60 * 60 * 1000;
  c._save();
  const r = c.crystallize();
  assert.strictEqual(r.retired.length, 1);
  assert.strictEqual(c.allExperiences().length, 0);
});

test('exportDoc 含分级结构且可同步', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  for (let i = 0; i < 4; i++) c.record({ appId: 'wechat', behaviorId: 'reply', intent: 'message_reply', text: '收到' });
  for (let i = 0; i < 4; i++) c.recordOutcome({ appId: 'wechat', behaviorId: 'reply', intent: 'message_reply' }, true);
  c.crystallize();
  const doc = c.exportDoc();
  assert.match(doc, /# Hermes 经验结晶/);
  assert.match(doc, /直接执行（脚本\/规则）/);
  assert.match(doc, /需判断（调用模型方案）/);
});

test('shouldCrystal：默认每天一次', () => {
  const c = new ExperienceCrystal({ dataDir: tmpDir(), now: () => T0 });
  c.record({ appId: 'a', behaviorId: 'b', intent: 'open_app', text: 't' });
  c.record({ appId: 'a', behaviorId: 'b', intent: 'open_app', text: 't' });
  assert.strictEqual(c.shouldCrystal(), true); // 首次且有≥2事件
  c.crystallize();
  assert.strictEqual(c.shouldCrystal(), false); // 刚结晶完
  c._now = () => T0 + 25 * 60 * 60 * 1000;
  c.record({ appId: 'a', behaviorId: 'b', intent: 'open_app', text: 't' });
  assert.strictEqual(c.shouldCrystal(), true); // 隔天后有新行为
});
