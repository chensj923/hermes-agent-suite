'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { PredictConfig } = require('../src/predict/config');
const { BehaviorDB } = require('../src/predict/behavior-db');
const { BehaviorEngine } = require('../src/predict/behavior-engine');

function makeEngine(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-pred-'));
  const config = new PredictConfig({ dataDir: path.join(tmp, 'cfg') });
  config.set(Object.assign({ enabled: true, authorized: true, model: 'qwen2.5-vl-3b' }, overrides));
  const db = new BehaviorDB({ dataDir: path.join(tmp, 'db') });
  let t = 1000000;
  const engine = new BehaviorEngine({ config, db, now: () => t });
  return { tmp, config, db, engine, advance: (ms) => { t += ms; } };
}

test('rule1 word_writing 命中', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress', windowClass: 'OpusApp' });
  advance(6000);
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, true);
  assert.strictEqual(r.rule, 'word_writing');
});

test('rule1 不停笔不命中', () => {
  const { engine } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress', windowClass: 'OpusApp' });
  const r = engine.handleEvent({ type: 'tick' }); // 没 advance，停顿=0
  assert.strictEqual(r.shouldScreenshot, false);
});

test('rule3 excel 数据输入', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'XLMainClient' });
  for (let i = 0; i < 25; i++) engine.handleEvent({ type: 'keypress' });
  advance(4000);
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.rule, 'data_entry');
});

test('rule2 浏览器复制大段', () => {
  const { engine } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'Chrome_WidgetWin_1' });
  const r = engine.handleEvent({ type: 'clipboard', clipboardType: 'text', clipboardLength: 800 });
  assert.strictEqual(r.rule, 'collecting_material');
});

test('rule4 IDE 频繁切窗', () => {
  const { engine } = makeEngine();
  let r;
  for (let i = 0; i < 3; i++) r = engine.handleEvent({ type: 'window_change', windowClass: 'VisualStudioIDE' });
  assert.strictEqual(r.rule, 'api_lookup');
});

test('rule5 鼠标编辑区停留', () => {
  const { engine } = makeEngine();
  const r = engine.handleEvent({ type: 'mouse', mouseIdleMs: 5000, inEditArea: true });
  assert.strictEqual(r.rule, 'reading_or_thinking');
});

test('未启用不触发', () => {
  const { engine, advance } = makeEngine({ enabled: false });
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, false);
});

test('冷却：拒绝后冷却期内不再触发，到期后再触发', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  let r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, true);
  engine.screenshotTaken();
  engine.modelResult({ intent: 'x', confidence: 0.9 });
  assert.strictEqual(engine.state, 'SUGGESTING');
  engine.userDecision(false); // 拒绝 → COOLDOWN
  assert.strictEqual(engine.state, 'COOLDOWN');

  advance(60 * 1000); // 1 分钟，仍在 5 分钟冷却内
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, false);

  advance(11 * 60 * 1000); // 跨过冷却（拒绝后冷却已翻倍为 10 分钟）
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, true);
});

test('接受重置冷却（接受后短期仍被拦）', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  let r = engine.handleEvent({ type: 'tick' });
  engine.screenshotTaken();
  engine.modelResult({ confidence: 0.9 });
  engine.userDecision(true);
  assert.strictEqual(engine.state, 'IDLE');

  advance(60 * 1000); // < 5 分钟初始冷却
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, false);
});

test('连续拒绝 3 次且接受率低 → 退休', () => {
  const { engine, db, advance } = makeEngine();
  for (let round = 0; round < 3; round++) {
    engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
    for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
    advance(6000);
    const r = engine.handleEvent({ type: 'tick' });
    assert.strictEqual(r.shouldScreenshot, true, 'round ' + round + ' 应触发');
    engine.screenshotTaken();
    engine.modelResult({ confidence: 0.9 });
    engine.userDecision(false);
    advance(31 * 60 * 1000); // 跨过冷却（最大 30 分钟）
  }
  // 第 4 次：应因 retired 不再触发
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, false);
  assert.strictEqual(r.retired, true);
  assert.strictEqual(db.isRetired('word_writing'), true);
});

test('模型置信度不足不弹窗', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000);
  engine.handleEvent({ type: 'tick' });
  engine.screenshotTaken();
  const mr = engine.modelResult({ confidence: 0.3 });
  assert.strictEqual(mr.suggest, false);
  assert.strictEqual(engine.state, 'IDLE');
});

test('灵敏度放大更易触发', () => {
  const { engine, advance } = makeEngine({ sensitivity: 2 });
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 20; i++) engine.handleEvent({ type: 'keypress' }); // 默认不达标(30)
  advance(3000); // 默认不达标(5000)
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, true); // sensitivity=2 降低阈值 → 命中
});

test('v4.10.31 上下文切换：切到工作应用且已在工作 → 触发 context_switch', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'Chrome_WidgetWin_1' });
  for (let i = 0; i < 10; i++) engine.handleEvent({ type: 'keypress' }); // 证明"正在工作"
  advance(2000); // 切换前已停笔 >1.2s（真实 alt-tab 不会在打字中），护栏放行
  const r = engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' }); // 切到 Word
  assert.strictEqual(r.shouldScreenshot, true);
  assert.strictEqual(r.rule, 'context_switch');
});

test('v4.10.31 上下文切换：切到非工作应用（桌面/资源管理器）不触发', () => {
  const { engine } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'Chrome_WidgetWin_1' });
  const r = engine.handleEvent({ type: 'window_change', windowClass: 'Progman' }); // 桌面，非工作类
  assert.strictEqual(r.shouldScreenshot, false);
});

test('v4.10.31 上下文切换：同一应用内反复轮询不重复触发', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 10; i++) engine.handleEvent({ type: 'keypress' });
  advance(2000); // 停笔后再切，护栏放行
  const r1 = engine.handleEvent({ type: 'window_change', windowClass: 'XLMainClient' }); // 切到 Excel（创作类）
  assert.strictEqual(r1.rule, 'context_switch');
  engine.screenshotTaken();
  engine.modelResult({ intent: 'context_switch', confidence: 0.75 });
  engine.userDecision(false); // 进入冷却
  // 冷却期内再切回 Word 也不应触发
  const r2 = engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  assert.strictEqual(r2.shouldScreenshot, false);
});

test('v4.10.31 护栏：正在打字（停顿<1.2s）时不触发任何规则', () => {
  const { engine, advance } = makeEngine();
  engine.handleEvent({ type: 'window_change', windowClass: 'OpusApp' });
  for (let i = 0; i < 40; i++) engine.handleEvent({ type: 'keypress' });
  advance(6000); // 满足 word_writing 的停顿阈值
  // 此刻"又敲了一下" → 立刻处于打字中（停顿=0），护栏应压制
  engine.handleEvent({ type: 'keypress' });
  const r = engine.handleEvent({ type: 'tick' });
  assert.strictEqual(r.shouldScreenshot, false);
});
