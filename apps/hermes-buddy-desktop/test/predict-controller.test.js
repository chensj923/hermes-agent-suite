'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController } = require('../src/predict/predict-controller');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pred-ctrl-'));
  return d;
}

/** 构造一个带注入 fake 的控制器（不碰真实 electron / 模型 / 杀软）。 */
function makeController({ model = 'none', choice = 'generate', predictFn = null } = {}) {
  const appDir = tmpDir();
  const captured = { suggestion: null, analyzeCalls: 0, actionCalls: [] };
  const fakeCapture = {
    captureActiveWindow: async () => ({ base64: 'BASE64FAKE', width: 800, height: 600, source: 'screen' }),
  };
  const fakePanel = {
    available: true,
    show: async (s) => { captured.suggestion = s; return choice; },
    destroy() {},
  };
  const fakeAction = {
    execute: async (a) => { captured.actionCalls.push(a); return { ok: true, type: a.type, message: 'ok' }; },
  };
  const ctrl = new PredictController({
    appDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    capture: fakeCapture,
    panel: fakePanel,
    actionExecutor: fakeAction,
    predictFn: predictFn || null,
  });
  ctrl.config.set({ model, enabled: true, authorized: true, confidenceThreshold: 0.6 });
  return { ctrl, captured, appDir };
}

test('model=none + 用户点「生成并插入」→ 剪贴板动作执行 + 引擎记接受', async () => {
  const { ctrl, captured } = makeController({ model: 'none', choice: 'generate' });
  await ctrl.triggerRule('word_writing');
  assert.ok(captured.suggestion, '应展示建议');
  assert.strictEqual(captured.suggestion.intent, 'word_writing');
  assert.ok(captured.actionCalls.length >= 1, '应执行至少一个动作');
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard');
  assert.ok(clip, '应触发剪贴板回填');
  assert.ok(clip.text && clip.text.length > 0, '回填文本非空');
  // 引擎回到 IDLE，且 word_writing 记了一次接受
  assert.strictEqual(ctrl.engine.state, 'IDLE');
  const stats = ctrl.db.getStats('word_writing');
  assert.strictEqual(stats.accepts, 1);
});

test('用户点「不再提示」→ 规则退休并存盘', async () => {
  const { ctrl } = makeController({ model: 'none', choice: 'never' });
  await ctrl.triggerRule('data_entry');
  const stats = ctrl.db.getStats('data_entry');
  assert.strictEqual(stats.rejects, 1);
  assert.strictEqual(stats.retired, true, '规则应被退休');
  // 退休已持久化：引擎在规则命中时会识别 retired（这里直接验证 db 层）
  assert.strictEqual(ctrl.db.isRetired('data_entry'), true, '退休状态应已落盘');
});

test('predictFn 低置信度 → 不弹窗、不计入拒绝，回到 IDLE', async () => {
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    choice: 'generate',
    predictFn: async () => ({ intent: 'none', confidence: 0.2, suggestion: '', reason: '没把握' }),
  });
  await ctrl.triggerRule('reading_or_thinking');
  assert.strictEqual(captured.suggestion, null, '低置信度不应展示浮窗');
  assert.strictEqual(ctrl.engine.state, 'IDLE');
  assert.strictEqual(captured.actionCalls.length, 0);
});

test('predictFn 高置信度 + 用户生成 → 经 capture 截图并回填', async () => {
  const { ctrl, captured } = makeController({
    model: 'qwen2.5-vl-3b',
    choice: 'generate',
    predictFn: async (ctx, img) => {
      captured.analyzeCalls += 1;
      assert.ok(img === 'BASE64FAKE', '应把截图 base64 传给模型');
      return { intent: 'api_lookup', confidence: 0.9, suggestion: '把这段报错贴给我', reason: '反复切窗查文档' };
    },
  });
  await ctrl.triggerRule('api_lookup');
  assert.strictEqual(captured.analyzeCalls, 1, '应调用一次模型');
  assert.ok(captured.actionCalls.find((a) => a.type === 'clipboard' && /报错/.test(a.text)), '应回填模型生成的建议');
});

test('本地模型未就绪（无 predictFn/buildRunner）→ 降级规则模板仍弹窗，不静默丢弃', async () => {
  // 复现线上 bug：选了本地 VLM 但引擎未安装，_analyze 抛「本地模型未就绪」，
  // 旧行为 modelTimeout()+return 导致一次都不弹；修复后必须降级为规则模板弹窗。
  const { ctrl, captured } = makeController({ model: 'qwen2.5-vl-3b', choice: 'generate' });
  await ctrl.triggerRule('api_lookup');
  assert.ok(captured.suggestion, '模型失败也必须弹窗（降级模板）');
  assert.strictEqual(captured.suggestion.intent, 'api_lookup');
  assert.ok(/降级/.test(captured.suggestion.reason), 'reason 应注明降级原因');
  assert.ok(/未就绪/.test(captured.suggestion.reason), 'reason 应包含引擎未就绪信息');
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard');
  assert.ok(clip, '降级模板也应走剪贴板动作');
});

test('一键关闭 → enabled/authorized 落盘为 false', async () => {
  const { ctrl } = makeController({ model: 'none' });
  await ctrl.oneClickOff();
  assert.strictEqual(ctrl.config.get('enabled'), false);
  assert.strictEqual(ctrl.config.get('authorized'), false);
  assert.strictEqual(ctrl.isEnabled(), false);
});

test('未授权时 enable() 抛错（无降级）', async () => {
  const { ctrl } = makeController({ model: 'none' });
  ctrl.config.set({ authorized: false, enabled: true });
  await assert.rejects(() => ctrl.enable(), /未授权/);
});
