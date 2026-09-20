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

test('predictNow：模型低置信度判「不打扰」时也必须给答案（v4.9.2 场景规则兜底）', async () => {
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    predictFn: async () => ({ intent: 'none', confidence: 0.2, suggestion: '', reason: '无明显卡顿' }),
  });
  ctrl.engine.ctx.windowClass = 'OpusApp';  // Word → 推断为 word_writing
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true, '用户主动点击的预测必须给出答案，不许沉默');
  assert.strictEqual(captured.suggestion.intent, 'word_writing', '模型不确定时应退回场景规则');
  assert.strictEqual(captured.suggestion.suggestion, RULE_TEMPLATE.word_writing);
  assert.ok(/场景/.test(captured.suggestion.reason), 'reason 应注明按场景兜底');
});

test('predictNow：服务端降级泛化话术 → 换成场景规则模板（v4.9.3 router_exhausted 场景）', async () => {
  // 服务端上游失败时返回 { intent: rule, confidence: 0.5, suggestion: '需要我帮你做点什么吗？' }
  // 0.5 过不了 0.6 门槛，但 intent 非空且 ≥0.3，v4.9.2 的 weakIntent 兜底不触发，
  // 会把这句空话原样弹窗——必须替换成针对性模板。
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    predictFn: async () => ({
      intent: 'word_writing', confidence: 0.5,
      suggestion: '需要我帮你做点什么吗？',
      reason: '远端推断失败（router_exhausted），已降级',
    }),
  });
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true);
  assert.strictEqual(captured.suggestion.suggestion, RULE_TEMPLATE.word_writing,
    '服务端降级的泛化话术必须换成场景规则模板');
  assert.ok(/远端推断失败/.test(captured.suggestion.reason), 'reason 应保留真实失败原因');
});

test('predictNow：不受冷却限制（冷却期内用户主动点也能出）', async () => {
  const { ctrl } = makeController({ model: 'none' });
  // 制造冷却：先拒绝一次
  await ctrl.triggerRule('word_writing');
  assert.ok(ctrl.engine.cooldownUntil > Date.now(), '应进入冷却');
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true, '主动预测应无视冷却');
});

test('predictNow：主动点猫（OS 前台是桌宠）时，用截到的真实 WPS 窗口标题反推身份 → word_writing', async () => {
  // 复现线上 bug：用户正在 WPS 写 "Hermes-buddy4.5使用结论："，主动点猫触发预测。
  // 此时 OS 前台是桌宠自己（resolveWindow 返回 Hermes Buddy），若直接用它会误判成
  // reading_or_thinking 给出泛化话术；正确做法是读 capture 截到的 WPS 窗口标题。
  const { ctrl, captured } = makeController({ model: 'none' });
  ctrl.capture = {
    captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600, source: 'Hermes-buddy4.5使用结论： - WPS 文字' }),
  };
  ctrl.resolveWindow = async () => ({ windowClass: 'Chrome_WidgetWin_1', title: 'Hermes Buddy', exeName: 'Hermes Buddy' });
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true, '主动预测必须给出反馈');
  assert.strictEqual(captured.suggestion.intent, 'word_writing', '应识别 WPS 写作场景，而非误判成 reading_or_thinking');
  assert.strictEqual(captured.suggestion.suggestion, RULE_TEMPLATE.word_writing);
  // 若身份仍被误判成桌宠（Chrome_WidgetWin_1→browser→reading_or_thinking），
  // 这里 intent 会是 'none' 而非 'word_writing'，上面断言即回归保护。
});

test('predictNow：主动点猫但只截到整屏时，回落到 OS 前台真实身份（非桌宠）', async () => {
  // 整屏截图拿不到窗口标题，此时 OS 前台若是真实应用（如 Word）仍可正确归档。
  const { ctrl, captured } = makeController({ model: 'none' });
  ctrl.capture = {
    captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600, source: 'Screen 1' }),
  };
  ctrl.resolveWindow = async () => ({ windowClass: 'OpusApp', title: '季度报告.docx - Word', exeName: 'WINWORD' });
  const r = await ctrl.predictNow();
  assert.strictEqual(r.shown, true);
  assert.strictEqual(captured.suggestion.intent, 'word_writing');
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

// ---- v4.10.13：自动触发（_onTrigger）身份纠正 + 低置信度兜底 ----

test('_onTrigger：OS 前台是桌宠时也用截图源标题纠正身份（不再发 Hermes Buddy自身）', async () => {
  // 复现线上「推理弹没了/没反应」：用户正在 WPS 写文档，但 OS 前台被识别成桌宠自己，
  // 旧的自动触发路径不纠正身份 → 远端拿到 exeName="Hermes Buddy自身" → 回低置信度「不打扰」
  // → 被 0.6 门槛拦下 → 思考气泡闪一下就消失。修复后自动路径也要跑 _applyScreenIdentity。
  let gotCtx = null;
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    predictFn: async (ctx) => {
      gotCtx = ctx;
      // 模拟服务端：身份正确（wps）才给高置信度写作建议；仍是桌宠则低置信度「不打扰」
      if (ctx.exeName === 'wps') {
        return { intent: 'word_writing', confidence: 0.9, suggestion: '需要我帮你续写吗？', reason: '前台为WPS文档编辑器' };
      }
      return { intent: 'reading_or_thinking', confidence: 0.55, suggestion: '需要我帮你梳理思路吗？', reason: 'exeName与windowClass为Hermes Buddy自身' };
    },
  });
  ctrl.capture = {
    captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600, source: 'Hermes-buddy4.5使用结论： - WPS 文字' }),
  };
  ctrl.resolveWindow = async () => ({ windowClass: 'Chrome_WidgetWin_1', title: 'Hermes Buddy', exeName: 'Hermes Buddy' });
  await ctrl.triggerRule('word_writing');
  assert.ok(gotCtx, '应调用模型');
  assert.strictEqual(gotCtx.exeName, 'wps', '自动路径也必须把桌宠前台纠正成真实 WPS 身份');
  assert.ok(captured.suggestion, '应弹出浮层（不再无反应）');
  assert.strictEqual(captured.suggestion.intent, 'word_writing');
  assert.strictEqual(captured.suggestion.confidence, 0.9);
});

test('_onTrigger：模型低置信度「不打扰」但行为规则已命中时，退回场景规则模板弹窗（不再静默）', async () => {
  // 兜底验证「思考闪一下就消失」被消除：即便服务端因身份问题回了低置信度，
  // 只要行为规则已命中（用户在明确场景），自动触发也要给建议，而不是安静退出。
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    predictFn: async () => ({ intent: 'reading_or_thinking', confidence: 0.5, suggestion: '需要我帮你梳理思路吗？', reason: '信息较模糊，低置信度不打扰' }),
  });
  // 模拟身份仍误判成桌宠、且截图源标题无法反推（titleToApp 返回 null）
  ctrl.capture = {
    captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600, source: '某未知文档' }),
  };
  ctrl.resolveWindow = async () => ({ windowClass: 'Chrome_WidgetWin_1', title: 'Hermes Buddy', exeName: 'Hermes Buddy' });
  ctrl.engine.ctx.exeName = 'Hermes Buddy';
  ctrl.engine.ctx.windowClass = 'Chrome_WidgetWin_1';
  await ctrl.triggerRule('word_writing');
  assert.ok(captured.suggestion, '低置信度但规则命中也应弹窗，不能无反应');
  assert.strictEqual(captured.suggestion.intent, 'word_writing', '应退回场景规则模板');
  assert.strictEqual(captured.suggestion.suggestion, RULE_TEMPLATE.word_writing);
  assert.ok(/场景/.test(captured.suggestion.reason), 'reason 应注明按场景兜底');
});

