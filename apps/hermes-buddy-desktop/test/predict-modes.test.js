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

test('v4.12.6 懒启动：远端可用时不拉起本地模型，远端断线时才启动兜底', async () => {
  // 远端可用：start 不应被调用
  let started1 = 0;
  const runner1 = { started: false, start: async () => { started1++; } };
  const { ctrl: c1 } = makeController({
    modelRunner: runner1,
    channel: channelThat(async () => ({ text: 'x' })),
  });
  const r1 = await c1.warmLocalModel();
  assert.strictEqual(started1, 0, '远端可用时不应自动启动本地模型');
  assert.strictEqual(r1.ok, false, '应返回未启动（懒启动）');

  // 远端不可用（channel=null）：start 应被调用
  let started2 = 0;
  const runner2 = { started: false, start: async () => { started2++; } };
  const { ctrl: c2 } = makeController({ modelRunner: runner2, channel: null });
  c2._enabled = true;
  const r2 = await c2.warmLocalModel();
  assert.strictEqual(started2, 1, '远端断线时应立即启动本地模型兜底');
  assert.strictEqual(r2.ok, true);
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

// ---------- 7. v4.12.1：sendImageToServer 残留清理 ----------

test('v4.12.1：旧落盘 sendImageToServer=false → 加载后删除该键（不再冷启动本机读图）', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sendImageToServer: false }), 'utf-8');
  const cfg = new PredictConfig({ dataDir: dir });
  cfg.load();
  assert.strictEqual(cfg.get('sendImageToServer'), undefined, '旧开关应被删除');
  assert.strictEqual(cfg.get('remoteVision'), true, '发图改由 remoteVision 默认 true 决定');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!('sendImageToServer' in onDisk), '落盘里也应清除旧键');
});

// ---------- 8. v4.12.1：窗口处理不重入 ----------

test('v4.12.1：onWindowChange 上一张卡片未返回时，新切窗事件被忽略（不重复起流水线）', async () => {
  let entered = 0;
  // 第一张卡片的 show 永不立即返回（卡在等待用户点击）
  const hangPanel = {
    available: true,
    show: () => new Promise(() => { entered += 1; }),
    destroy() {},
  };
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: noopLogger(),
    panel: hangPanel,
    actionExecutor: { execute: async () => ({ ok: true }) },
  });
  ctrl.config.set({ enabled: true, authorized: true });
  ctrl._enabled = true;
  // 第一次进入：命中场景规则、卡片挂起（不等它返回，模拟新切窗事件紧接着到来）
  const first = ctrl.onWindowChange({ exeName: 'wps', title: '文档1' });
  await Promise.resolve();
  assert.strictEqual(ctrl._windowHandling, true, '第一次窗口处理应持锁');
  // 第二次切窗事件：必须被忽略
  const before = entered;
  await ctrl.onWindowChange({ exeName: 'wechat', title: '微信' });
  assert.strictEqual(entered, before, '锁未释放时新切窗事件不应再处理');
});

// ---------- 9. v4.12.1：主动预测明确意图直接出正文 ----------

test('v4.12.1：主动点猫 + 远端回 message_reply → 直接生成正文，不停在确认框', async () => {
  const calls = [];
  const channel = channelThat(async () => ({
    intent: 'message_reply', confidence: 0.75,
    suggestion: '微信回复卡住了？', reason: '在斟酌回复',
  }));
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: noopLogger(),
    capture: { captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600 }) },
    panel: {
      available: true,
      show: async () => { throw new Error('明确意图不应停在确认框'); },
      showThinking() {},
      armThinkingTimeout() {},
      cancelThinking() {},
      destroy() {},
    },
    actionExecutor: { execute: async (a) => { calls.push(a); return { ok: true, type: a.type }; } },
    channel,
    generateContentFn: async () => ({ content: '好的，我稍后回复你。' }),
  });
  ctrl.config.set({ enabled: true, authorized: true, autoInsert: true });
  ctrl._enabled = true;
  const r = await ctrl.predictNow();
  assert.strictEqual(r.intent, 'message_reply');
  assert.strictEqual(r.choice, 'auto-generate', '应自动生成正文');
  const type = calls.find((a) => a.type === 'type-input' || a.type === 'clipboard-paste');
  assert.ok(type, '回复正文应被投递');
  assert.strictEqual(type.text, '好的，我稍后回复你。');
});
