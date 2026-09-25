'use strict';

/**
 * v4.12.0 统一链路回归（运行模式已彻底移除）：
 *  - 触发永远由本地确定性规则决定，模型只负责触发后的思考/解答；
 *  - 远端通道可用 → 走远端大模型（默认带原图，远程视觉优先）；
 *  - 远端未连 / 报错 → 自动退回本机模型，全程无感、不静默；
 *  - 配置迁移：旧落盘里的 model 键被丢弃，旧本地模型 id 保留到 vlmModel。
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController } = require('../src/predict/predict-controller');
const { PredictConfig } = require('../src/predict/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pred-mode-'));
}

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * @param {object} opts
 * @param {function} [opts.predictFn]   本机分析 fake
 * @param {object|null} [opts.channel]  远端通道 fake（null = 通道未连）
 * @param {object} [opts.modelRunner]   本机 runner fake
 */
function makeController({ predictFn = null, channel = null, modelRunner = null } = {}) {
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
  ctrl.config.set({ enabled: true, authorized: true, confidenceThreshold: 0.6, autoInsert: false });
  return { ctrl, captured };
}

function channelThat(fn, extra = {}) {
  return Object.assign({ connected: true, supportsPredict: true, predict: fn }, extra);
}

// ---------- 1. 配置迁移 ----------

test('旧落盘 model=qwen2.5-vl-3b：加载后丢弃 model 键，本地模型 id 保留到 vlmModel', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'qwen2.5-vl-3b' }), 'utf-8');
  const cfg = new PredictConfig({ dataDir: dir });
  assert.strictEqual(cfg.get('model'), undefined, 'model 字段应被移除');
  assert.strictEqual(cfg.get('vlmModel'), 'qwen2.5-vl-3b');
});

test('旧落盘 model=hybrid/remote/none：加载后丢弃 model 键，vlmModel 用默认', () => {
  for (const m of ['hybrid', 'remote', 'none']) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: m }), 'utf-8');
    const cfg = new PredictConfig({ dataDir: dir });
    assert.strictEqual(cfg.get('model'), undefined, m + ' 的 model 键应被丢弃');
    assert.strictEqual(cfg.get('vlmModel'), 'qwen2.5-vl-3b');
  }
});

test('set() 即便误传 model 也会被丢弃', () => {
  const cfg = new PredictConfig({ dataDir: tmpDir() });
  cfg.set({ model: 'remote', sensitivity: 1.2 });
  assert.strictEqual(cfg.get('model'), undefined);
  assert.strictEqual(cfg.get('sensitivity'), 1.2);
});

// ---------- 2. 远端在线：远端优先 ----------

test('远端通道可用：真正调用通道 predict，并默认带截图原图', async () => {
  const calls = [];
  const channel = channelThat(async (ctx, img) => {
    calls.push({ ctx, img });
    return { intent: 'api_lookup', confidence: 0.9, suggestion: '把报错贴给我', reason: '远端判断' };
  });
  const { ctrl, captured } = makeController({ channel });
  await ctrl.triggerRule('api_lookup');
  assert.strictEqual(calls.length, 1, '远端通道应被调用一次');
  assert.strictEqual(calls[0].img, 'B64', '远程视觉优先：默认把原图发给服务端');
  assert.strictEqual(captured.suggestion.intent, 'api_lookup');
});

test('远端对象存在但 connected=false → 视为不可用，退回本机', async () => {
  const channel = channelThat(
    async () => { throw new Error('不应被调用'); },
    { connected: false }
  );
  const { ctrl, captured } = makeController({
    channel,
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.85, suggestion: '本机续写', reason: '本机判断' }),
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(captured.suggestion.suggestion, '本机续写', '断线应退回本机结论');
});

// ---------- 3. 远端不可用/报错：退回本机 ----------

test('远端通道未连：退回本机模型，仍然弹窗', async () => {
  const { ctrl, captured } = makeController({
    channel: null,
    predictFn: async () => ({ intent: 'data_entry', confidence: 0.85, suggestion: '这个字段我帮你填', reason: '本机判断' }),
  });
  await ctrl.triggerRule('data_entry');
  assert.ok(captured.suggestion, '通道没连也要弹窗（本机兜底）');
  assert.strictEqual(captured.suggestion.suggestion, '这个字段我帮你填');
});

test('远端模型报错：快速退回本机结论（不无限等待、不卡死）', async () => {
  const start = Date.now();
  const channel = channelThat(async () => { throw new Error('模型推理失败'); });
  const { ctrl, captured } = makeController({
    channel,
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.8, suggestion: '本机初判', reason: '切窗' }),
  });
  await ctrl.triggerRule('word_writing');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10000, `远端报错应快速退回本机，实际 ${elapsed}ms`);
  assert.ok(captured.suggestion, '远端报错后应仍有本机建议');
  assert.strictEqual(captured.suggestion.suggestion, '本机初判');
});

test('远端与本机都不可用：降级为规则模板弹窗，不静默丢弃', async () => {
  const { ctrl, captured } = makeController({ channel: null, predictFn: null });
  await ctrl.triggerRule('api_lookup');
  assert.ok(captured.suggestion, '两层都挂也要降级弹窗');
});

// ---------- 4. 思考中 loading ----------

test('分析时先弹「思考中」加载态，再换成建议', async () => {
  const channel = channelThat(async () => ({
    intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: 'x',
  }));
  const { ctrl, captured } = makeController({ channel });
  await ctrl.triggerRule('word_writing');
  assert.deepStrictEqual(captured.thinking, ['思考中…'], '分析前应先弹思考中');
  assert.ok(captured.suggestion, '分析完应换成建议');
});

// ---------- 5. 本机模型预热 ----------

test('warmLocalModel：已热启时直接返回，未安装时返回未安装', async () => {
  const warm = { started: true, stop() {}, analyze() {} };
  const { ctrl } = makeController({ modelRunner: warm });
  const r1 = await ctrl.warmLocalModel();
  assert.strictEqual(r1.ok, true, '已热启应直接返回 ok');
  assert.ok(/已就绪/.test(r1.reason));

  const { ctrl: ctrl2 } = makeController({ modelRunner: null });
  const r2 = await ctrl2.warmLocalModel();
  assert.strictEqual(r2.ok, false, '无 runner 且无 buildRunner 应返回未安装');
  assert.ok(/未安装/.test(r2.reason));
});

// ---------- 6. 思考安全网 ----------

test('onThinkingTimeout：面板安全网触发时降级为规则模板弹窗', async () => {
  const { ctrl, captured } = makeController();
  ctrl.engine.state = 'ANALYZING';
  ctrl.engine._pending = { rule: 'word_writing', reason: 'generic_pause', context: ctrl.engine._snapshot() };
  ctrl._processing = true;
  await ctrl.onThinkingTimeout();
  assert.strictEqual(ctrl._processing, false, '_processing 应被重置');
  assert.ok(captured.suggestion, '面板超时应降级弹窗');
  assert.strictEqual(captured.suggestion.suggestion, '要不要我帮你续写或润色这段文字？');
  assert.ok(/模型响应超时/.test(captured.suggestion.reason));
});
