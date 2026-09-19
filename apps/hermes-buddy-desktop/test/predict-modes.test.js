'use strict';

/**
 * v4.4 三档运行模式回归测试：local / remote / hybrid
 * 重点锁住：
 *  1. 旧的 model 值（纯规则 / 本地模型 id）能迁移到新模式语义；
 *  2. remote 模式必须真正调用通道（旧实现被 _hasModelPath 误判成无模型，从未调用过）；
 *  3. hybrid：本地小模型判断「该不该触发」，值得打扰才交给远端思考解答；
 *     本地不可用跳过筛选、远端不可用退回本地结论——两条降级都不静默。
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController } = require('../src/predict/predict-controller');
const { PredictConfig, normalizeModel } = require('../src/predict/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pred-mode-'));
}

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * @param {object} opts
 * @param {string} opts.model     运行模式
 * @param {function} [opts.predictFn]   本地小模型 fake
 * @param {object|null} [opts.channel]  远端通道 fake（null = 通道未连）
 */
function makeController({ model = 'hybrid', predictFn = null, channel = null, modelRunner = null } = {}) {
  const captured = { suggestion: null, analyzeCalls: 0, thinking: [] };
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: noopLogger(),
    capture: { captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600 }) },
    panel: {
      available: true,
      show: async (s) => { captured.suggestion = s; return 'generate'; },
      showThinking: (t) => { captured.thinking.push(t); },
      destroy() {},
    },
    actionExecutor: { execute: async () => ({ ok: true }) },
    predictFn,
    channel,
    modelRunner,
  });
  ctrl.config.set({ model, enabled: true, authorized: true, confidenceThreshold: 0.6 });
  return { ctrl, captured };
}

// ---------- 1. 配置迁移 ----------

test('normalizeModel：纯规则 / 本地模型 id → local，remote / hybrid 保留', () => {
  assert.strictEqual(normalizeModel('none'), 'local');
  assert.strictEqual(normalizeModel('qwen2.5-vl-3b'), 'local');
  assert.strictEqual(normalizeModel('smolvlm2'), 'local');
  assert.strictEqual(normalizeModel('remote'), 'remote');
  assert.strictEqual(normalizeModel('hybrid'), 'hybrid');
  assert.strictEqual(normalizeModel(undefined), 'local');
});

test('旧落盘配置（model=qwen2.5-vl-3b）加载后迁移为 local + vlmModel', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'qwen2.5-vl-3b' }), 'utf-8');
  const cfg = new PredictConfig({ dataDir: dir });
  assert.strictEqual(cfg.get('model'), 'local');
  assert.strictEqual(cfg.get('vlmModel'), 'qwen2.5-vl-3b');
});

test('默认模式为 hybrid，且 vlmModel 默认 qwen2.5-vl-3b', () => {
  const cfg = new PredictConfig({ dataDir: tmpDir() });
  assert.strictEqual(cfg.get('model'), 'hybrid');
  assert.strictEqual(cfg.get('vlmModel'), 'qwen2.5-vl-3b');
});

// ---------- 2. remote 模式 ----------

test('remote 模式：真正调用通道 predict（旧实现误判成无模型，从未调用）', async () => {
  const calls = [];
  const channel = {
    predict: async (ctx, img) => {
      calls.push({ ctx, img });
      return { intent: 'api_lookup', confidence: 0.9, suggestion: '把报错贴给我', reason: '远端判断' };
    },
  };
  const { ctrl, captured } = makeController({ model: 'remote', channel });
  await ctrl.triggerRule('api_lookup');
  assert.strictEqual(calls.length, 1, '远端通道应被调用一次');
  assert.strictEqual(calls[0].img, 'B64', '截图应传给远端');
  assert.strictEqual(captured.suggestion.intent, 'api_lookup');
  assert.ok(/远端/.test(captured.suggestion.reason), 'reason 应体现远端来源');
});

test('remote 模式 + 通道未连：降级为规则预判，仍然弹窗', async () => {
  const { ctrl, captured } = makeController({ model: 'remote', channel: null });
  await ctrl.triggerRule('word_writing');
  assert.ok(captured.suggestion, '通道没连也要弹窗（降级）');
  assert.ok(/远端通道未连接/.test(captured.suggestion.reason));
});

// ---------- 3. hybrid 模式 ----------

test('hybrid：本地判断置信度不足 → 到此为止，不惊动远端', async () => {
  let remoteCalls = 0;
  const channel = { predict: async () => { remoteCalls += 1; return { intent: 'x', confidence: 0.9, suggestion: 'y' }; } };
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel,
    predictFn: async () => ({ intent: 'none', confidence: 0.2, suggestion: '', reason: '没啥事' }),
  });
  await ctrl.triggerRule('reading_or_thinking');
  assert.strictEqual(remoteCalls, 0, '本地判断不该打扰时不应调用远端');
  assert.strictEqual(captured.suggestion, null, '不该弹窗');
});

test('hybrid：本地判断值得触发 → 交给远端思考，并把本地判断作为提示带上', async () => {
  const calls = [];
  const channel = {
    predict: async (ctx, img) => {
      calls.push({ ctx, img });
      return { intent: 'api_lookup', confidence: 0.95, suggestion: '这行报错的根因是…', reason: '远端分析' };
    },
  };
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel,
    predictFn: async () => ({ intent: 'api_lookup', confidence: 0.8, suggestion: '本地初判', reason: '切窗频繁' }),
  });
  await ctrl.triggerRule('api_lookup');
  assert.strictEqual(calls.length, 1, '应调用远端思考');
  assert.strictEqual(calls[0].ctx.localJudgment.intent, 'api_lookup', '应把本地判断作为提示带上');
  assert.strictEqual(calls[0].ctx.stage, 'deep_think');
  assert.strictEqual(captured.suggestion.suggestion, '这行报错的根因是…');
  assert.ok(/远端思考解答/.test(captured.suggestion.reason), 'reason 应写明 本地判断+远端思考');
});

test('hybrid：本地模型不可用（没装引擎）→ 跳过筛选，直接问远端', async () => {
  const calls = [];
  const channel = {
    predict: async (ctx) => { calls.push(ctx); return { intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: 'ok' }; },
  };
  const { ctrl, captured } = makeController({ model: 'hybrid', channel, predictFn: null });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls.length, 1, '本地不可用时仍应走远端');
  assert.strictEqual(captured.suggestion.suggestion, '帮你续写');
});

test('hybrid：远端不可用 → 退回本地结论，仍弹窗', async () => {
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel: null,           // 通道未连 → 远端不可用
    predictFn: async () => ({ intent: 'data_entry', confidence: 0.85, suggestion: '这个字段我帮你填', reason: '本地判断' }),
  });
  await ctrl.triggerRule('data_entry');
  assert.ok(captured.suggestion, '远端不可用也要给结论');
  assert.strictEqual(captured.suggestion.suggestion, '这个字段我帮你填');
});

// ---------- 4. 思考中 loading ----------

test('走模型分析时先弹「思考中」加载态，再换成建议', async () => {
  const { ctrl, captured } = makeController({
    model: 'local',
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: 'x' }),
  });
  await ctrl.triggerRule('word_writing');
  assert.deepStrictEqual(captured.thinking, ['思考中…'], '分析前应先弹思考中');
  assert.ok(captured.suggestion, '分析完应换成建议');
});

// ---------- 5. v4.8.2 hybrid 冷启动优化 ----------

test('hybrid：本地模型未热启 → 跳过筛选直接问远端', async () => {
  const calls = [];
  const channel = {
    predict: async (ctx) => { calls.push(ctx); return { intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: 'ok' }; },
  };
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel,
    predictFn: null,
    modelRunner: { started: false },
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls.length, 1, '本地未热启时应直接走远端');
  assert.strictEqual(captured.suggestion.suggestion, '帮你续写');
  assert.ok(!('localJudgment' in calls[0]), '跳过本地筛选时不应带 localJudgment');
});

test('hybrid：本地模型热启但超时 → 跳过筛选直接问远端', async () => {
  const calls = [];
  const channel = {
    predict: async (ctx) => { calls.push(ctx); return { intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: 'ok' }; },
  };
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel,
    predictFn: async () => new Promise(() => {}), // 永远挂起
    modelRunner: { started: true },
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls.length, 1, '本地筛选超时时应直接走远端');
  assert.strictEqual(captured.suggestion.suggestion, '帮你续写');
});

test('warmLocalModel：已热启时直接返回，未安装时返回未安装', async () => {
  const warm = { started: true, stop() {}, analyze() {} };
  const { ctrl } = makeController({ model: 'hybrid', modelRunner: warm });
  const r1 = await ctrl.warmLocalModel();
  assert.strictEqual(r1.ok, true, '已热启应直接返回 ok');
  assert.ok(/已就绪/.test(r1.reason));

  const { ctrl: ctrl2 } = makeController({ model: 'hybrid', modelRunner: null, buildRunner: null });
  const r2 = await ctrl2.warmLocalModel();
  assert.strictEqual(r2.ok, false, '无 runner 且无 buildRunner 应返回未安装');
  assert.ok(/未安装/.test(r2.reason));
});

// ---------- 6. v4.8.4 思考超时与弹窗前置 ----------

test('hybrid：远端模型 30s 未响应 → 控制器超时降级为规则模板', async () => {
  const start = Date.now();
  const channel = {
    predict: async () => new Promise(() => {}), // 永远挂起，触发控制器 30s 超时
  };
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel,
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.8, suggestion: '本地初判', reason: '切窗' }),
  });
  await ctrl.triggerRule('word_writing');
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 29000 && elapsed <= 34000, `应在 30s 左右降级，实际 ${elapsed}ms`);
  assert.ok(captured.suggestion, '超时后应降级弹窗');
  assert.ok(/模型响应超时/.test(captured.suggestion.reason), 'reason 应注明模型响应超时');
});

test('remote：远端 30s 未响应 → 降级为规则预判，不永久卡住', async () => {
  const channel = {
    predict: async () => new Promise(() => {}),
  };
  const { ctrl, captured } = makeController({ model: 'remote', channel });
  await ctrl.triggerRule('api_lookup');
  assert.ok(captured.suggestion, '远端超时应降级弹窗');
  assert.ok(/远端模型响应超时/.test(captured.suggestion.reason));
});

test('onThinkingTimeout：面板安全网触发时降级为规则模板弹窗', async () => {
  const { ctrl, captured } = makeController({ model: 'hybrid' });
  ctrl.engine.state = 'ANALYZING';
  ctrl.engine._pending = { rule: 'word_writing', reason: 'generic_pause', context: ctrl.engine._snapshot() };
  ctrl._processing = true;
  await ctrl.onThinkingTimeout();
  assert.strictEqual(ctrl._processing, false, '_processing 应被重置');
  assert.ok(captured.suggestion, '面板超时应降级弹窗');
  assert.strictEqual(captured.suggestion.suggestion, '要不要我帮你续写或润色这段文字？');
  assert.ok(/模型响应超时/.test(captured.suggestion.reason));
});
