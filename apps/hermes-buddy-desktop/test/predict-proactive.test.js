'use strict';

/**
 * v4.2 主动预测 + 规则覆盖面回归。
 *  - predictNow()：不受冷却/规则限制；无模型时用窗口类型推断出有信息量的建议
 *  - _inferRuleFromContext()：窗口类/剪贴板/鼠标 → 场景
 *  - 通用兜底规则：WPS / 记事本 / 微信等未知应用里打字停顿也能触发（原来完全不触发）
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController, RULE_TEMPLATE } = require('../src/predict/predict-controller');
const { BehaviorEngine } = require('../src/predict/behavior-engine');
const { PredictConfig } = require('../src/predict/config');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pred-now-')); }
function noopLogger() { return { info() {}, warn() {}, error() {}, debug() {} }; }

/** 带注入 fake 的控制器。predictFn=null 时模拟「本地模型未安装」。 */
function makeController({ model = 'none', choice = 'generate', predictFn = null } = {}) {
  const appDir = tmpDir();
  const captured = { suggestion: null, analyzeCalls: 0, actionCalls: [] };
  const ctrl = new PredictController({
    appDir,
    logger: noopLogger(),
    capture: { captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600, source: 'screen' }) },
    panel: { available: true, show: async (s) => { captured.suggestion = s; return choice; }, destroy() {} },
    actionExecutor: { execute: async (a) => { captured.actionCalls.push(a); return { ok: true }; } },
    predictFn: predictFn || null,
  });
  ctrl.config.set({ model, enabled: true, authorized: true, confidenceThreshold: 0.6 });
  return { ctrl, captured, appDir };
}

test('predictNow：未启用/未授权时明确抛错（不静默）', async () => {
  const { ctrl } = makeController();
  ctrl.config.set({ authorized: false, enabled: true });
  await assert.rejects(() => ctrl.predictNow(), /未授权/);
  ctrl.config.set({ authorized: true, enabled: false });
  await assert.rejects(() => ctrl.predictNow(), /未启用/);
});

test('predictNow：模型未就绪也能弹窗（降级为窗口类型推断）', async () => {
  const { ctrl, captured } = makeController({ model: 'qwen2.5-vl-3b' });  // 无 predictFn → 本地模型不可用
  // 让上下文是 Excel：推断为 data_entry
  ctrl.engine.ctx.windowClass = 'XLMainClient';
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true, '主动预测必须给出反馈');
  assert.ok(captured.suggestion, '应弹出浮层');
  assert.strictEqual(captured.suggestion.intent, 'data_entry');
  assert.strictEqual(captured.suggestion.suggestion, RULE_TEMPLATE.data_entry);
  assert.ok(/降级|推断/.test(captured.suggestion.reason));
});

test('predictNow：有模型时走模型，不退化成模板', async () => {
  let gotCtx = null;
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    predictFn: async (ctx) => {
      gotCtx = ctx;
      return { intent: 'api_lookup', confidence: 0.9, suggestion: '把报错贴给我', reason: '反复切窗' };
    },
  });
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true);
  assert.strictEqual(r.suggestion, '把报错贴给我');
  assert.ok(gotCtx.proactive === true, '应标记 proactive');
  assert.ok(captured.suggestion.confidence === 0.9);
});

test('predictNow：不受冷却限制（冷却期内用户主动点也能出）', async () => {
  const { ctrl } = makeController({ model: 'none' });
  // 制造冷却：先拒绝一次
  await ctrl.triggerRule('word_writing');
  assert.ok(ctrl.engine.cooldownUntil > Date.now(), '应进入冷却');
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true, '主动预测应无视冷却');
});

test('_inferRuleFromContext：窗口类 → 场景映射', () => {
  const { ctrl } = makeController();
  const infer = (ctx) => ctrl._inferRuleFromContext(ctx);
  assert.strictEqual(infer({ windowClass: 'XLMainClient' }), 'data_entry');
  assert.strictEqual(infer({ windowClass: 'OpusApp' }), 'word_writing');
  assert.strictEqual(infer({ windowClass: 'PPTFrameClass' }), 'word_writing');
  assert.strictEqual(infer({ windowClass: 'WeChatMainWndForPC' }), 'word_writing');
  assert.strictEqual(infer({ windowClass: 'VSCodeIDE' }), 'api_lookup');
  assert.strictEqual(infer({ windowClass: 'CASCADIA_HOST' }), 'api_lookup');
  // 浏览器：复制大段 = 收集资料；否则阅读
  assert.strictEqual(infer({ windowClass: 'Chrome_WidgetWin_1', clipboard: { length: 900 } }), 'collecting_material');
  assert.strictEqual(infer({ windowClass: 'Chrome_WidgetWin_1' }), 'reading_or_thinking');
  // 无应用线索时的兜底
  assert.strictEqual(infer({ clipboard: { length: 800 } }), 'collecting_material');
  assert.strictEqual(infer({ mouseIdleMs: 5000 }), 'reading_or_thinking');
  assert.strictEqual(infer({ typedSincePause: 12 }), 'word_writing');
  assert.strictEqual(infer({}), null);
});

// ---- 规则覆盖面（v4.2 通用兜底）----

function makeEngine(appClassMap) {
  // 注意：defaults 里不能放 undefined，否则 Object.assign 会把默认 appClassMap 覆盖成 undefined
  const defaults = { enabled: true };
  if (appClassMap) defaults.appClassMap = appClassMap;
  const cfg = new PredictConfig({ dataDir: tmpDir(), defaults });
  const engine = new BehaviorEngine({ config: cfg, db: null, logger: noopLogger() });
  return { cfg, engine };
}

test('通用兜底：WPS（不在原 appClassMap 里）打字停顿也能触发', () => {
  const { engine } = makeEngine();
  const t0 = 1000000;
  engine._nowFn = () => t0;
  // 敲 50 个字符
  for (let i = 0; i < 50; i += 1) engine.handleEvent({ type: 'keypress', windowClass: 'WpsUnknownClass' });
  // 停笔 9 秒后心跳（>8s 通用阈值）
  engine._nowFn = () => t0 + 9000;
  const r = engine.tick();
  assert.strictEqual(r.shouldScreenshot, true, '未知应用里打字停顿也应触发（v4.2 兜底）');
  assert.strictEqual(r.rule, 'word_writing');
});

test('通用兜底关闭后：未知应用不再触发（尊重 config 开关）', () => {
  const cfg = new PredictConfig({ dataDir: tmpDir(), defaults: { enabled: true, genericWritingFallback: false } });
  const engine = new BehaviorEngine({ config: cfg, db: null, logger: noopLogger() });
  const t0 = 1000000;
  engine._nowFn = () => t0;
  for (let i = 0; i < 50; i += 1) engine.handleEvent({ type: 'keypress', windowClass: 'WpsUnknownClass' });
  engine._nowFn = () => t0 + 9000;
  const r = engine.tick();
  assert.strictEqual(r.shouldScreenshot, false);
});

test('专用规则优先于通用兜底：Word 里 5s 停顿仍按 word_writing 精确命中', () => {
  const { engine } = makeEngine();
  const t0 = 1000000;
  engine._nowFn = () => t0;
  for (let i = 0; i < 40; i += 1) engine.handleEvent({ type: 'keypress', windowClass: 'OpusApp' });
  engine._nowFn = () => t0 + 5200;   // >5s（Word 专用阈值），<8s（通用阈值）
  const r = engine.tick();
  assert.strictEqual(r.shouldScreenshot, true);
  assert.strictEqual(r.rule, 'word_writing');
});

test('扩充后的 appClassMap：PPT / 微信 / 终端都能归到对应场景', () => {
  const { PredictConfig: PC } = require('../src/predict/config');
  const cfg = new PC({ dataDir: tmpDir() });
  const map = cfg.get('appClassMap');
  assert.ok(map.ppt.length > 0 && map.im.length > 0 && map.terminal.length > 0, '新增类别应存在');
  assert.ok(map.ide.includes('CASCADIA_HOST'));
  assert.ok(map.word.some((c) => /Wps|Notepad|OpusApp/.test(c)), '写作类应覆盖 WPS/记事本');
});

test('浏览器↔IDE 反复横跳 → 判为查接口/查资料', () => {
  const { engine } = makeEngine();
  const t0 = 1000000;
  engine._nowFn = () => t0;
  engine.handleEvent({ type: 'window_change', windowClass: 'VSCodeIDE' });
  engine.handleEvent({ type: 'window_change', windowClass: 'Chrome_WidgetWin_1' });
  engine._nowFn = () => t0 + 2000;
  // 第三次切窗即命中（命中后进入 TRIGGERED，故在这里断言返回值）
  const r = engine.handleEvent({ type: 'window_change', windowClass: 'VSCodeIDE' });
  assert.strictEqual(r.shouldScreenshot, true);
  assert.strictEqual(r.rule, 'api_lookup');
});
