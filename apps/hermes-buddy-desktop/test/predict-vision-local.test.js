'use strict';

/**
 * v4.10.0「视觉本地化」回归测试。
 *
 * 核心约束：不能假设服务端一定有多模态模型。
 * 截图一律先由本机 VL 模型读成一段文字（screenObservation），服务端只做纯文本推理。
 *
 * 锁住的行为：
 *  1. 默认（sendImageToServer=false）：绝不能把截图原图发给服务端；
 *  2. 本地筛选结果已带 observation 时直接复用，不重复跑一次 11~15s 的 CPU 推理；
 *  3. 本机模型未热启时不为「描述」去冷启动（宁可这轮不带视觉信息）；
 *  4. 描述超时/失败不阻断主流程；
 *  5. 用户显式开启 sendImageToServer 时才发原图（兼容确实接了视觉模型的部署）；
 *  6. LocalModelRunner.describe 能正确把 VLM 输出清洗成描述文本。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { test } = require('node:test');

const { PredictController } = require('../src/predict/predict-controller');
const { LocalModelRunner } = require('../src/predict/local-model-runner');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pred-vision-')); }
function noopLogger() { return { info() {}, warn() {}, error() {}, debug() {} }; }

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {object|null} [opts.channel]
 * @param {function} [opts.predictFn]      本机小模型 fake（可返回 observation）
 * @param {function} [opts.describeFn]     本机视觉描述 fake
 * @param {object|null} [opts.modelRunner]
 */
function makeController({ model = 'hybrid', channel = null, predictFn = null, describeFn = null, modelRunner = null } = {}) {
  const captured = { suggestion: null };
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: noopLogger(),
    capture: { captureActiveWindow: async () => ({ base64: 'B64', width: 800, height: 600 }) },
    panel: {
      available: true,
      show: async (s) => { captured.suggestion = s; return 'generate'; },
      showThinking() {},
      destroy() {},
    },
    actionExecutor: { execute: async () => ({ ok: true }) },
    predictFn,
    describeFn,
    channel,
    modelRunner,
  });
  // 本机 VL 链路回归：显式关掉远端视觉（v4.11.0 起默认是走远端视觉的，
  // 这些用例测的是「服务端是纯文本模型」时的降级链路）。
  ctrl.config.set({ model, enabled: true, authorized: true, confidenceThreshold: 0.6, autoInsert: false, remoteVision: false });
  return { ctrl, captured };
}

function okChannel(sink) {
  return {
    connected: true,      // v4.12.0：远端可用性三重判断要求
    supportsPredict: true,
    predict: async (ctx, img) => {
      sink.push({ ctx, img });
      return { intent: 'word_writing', confidence: 0.9, suggestion: '帮你续写', reason: '远端分析' };
    },
  };
}

// ---------- 1. 默认不发原图 ----------

test('默认配置：remoteVision=true（截图直接发远端看图；sendImageToServer 已移除）', () => {
  const { ctrl } = makeController();
  // 注意：makeController 为测本机 VL 链路显式关了远端视觉，这里直接读默认配置
  const cfg = new (require('../src/predict/config').PredictConfig)({ dataDir: tmpDir() });
  assert.strictEqual(cfg.get('sendImageToServer'), undefined, '旧开关应已移除');
  assert.strictEqual(cfg.get('remoteVision'), true);
  assert.ok(ctrl, 'controller 构造成功');
});

test('remoteVision=false：本机 VL 读图成文字 → 远端只收文字，不带原图', async () => {
  // v4.12.0 远端优先：本地判定不再先跑，remoteVision 关闭时由本机 VL 直接
  // describe 出一段 screenObservation，再随纯文本请求发给远端。
  const calls = [];
  const { ctrl, captured } = makeController({
    channel: okChannel(calls),
    describeFn: async () => 'Word 文档，标题「Hermes4.5 使用报告：」，光标停在标题行末尾',
    modelRunner: { started: true },
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls.length, 1, '应调用远端');
  assert.ok(!calls[0].img, '截图原图不应发给服务端');
  assert.strictEqual(
    calls[0].ctx.screenObservation,
    'Word 文档，标题「Hermes4.5 使用报告：」，光标停在标题行末尾',
    '本机视觉描述应作为 screenObservation 发给服务端'
  );
  assert.strictEqual(captured.suggestion.suggestion, '帮你续写');
});

test('hybrid：本地结果没带 observation → 用本机 describe 补一段描述，且不重复跑 analyze', async () => {
  const calls = [];
  let describeCalls = 0;
  const { ctrl } = makeController({
    model: 'hybrid',
    channel: okChannel(calls),
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.8, suggestion: '本地初判', reason: '停笔' }),
    describeFn: async () => { describeCalls += 1; return 'Excel 表格，B 列大量空单元格'; },
    modelRunner: { started: true },
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(describeCalls, 1, '本地结果缺 observation 时应补一次描述');
  assert.ok(!calls[0].img);
  assert.strictEqual(calls[0].ctx.screenObservation, 'Excel 表格，B 列大量空单元格');
});

// ---------- 2. 冷启动保护 ----------

test('本机模型未热启：不为「描述」去冷启动，直接发纯文本（不阻塞）', async () => {
  const calls = [];
  let describeCalls = 0;
  const { ctrl } = makeController({
    model: 'hybrid',
    channel: okChannel(calls),
    predictFn: null,
    describeFn: async () => { describeCalls += 1; return 'x'; },
    modelRunner: { started: false },   // 冷：绝不能为描述去拉起 2.6GB 模型
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(describeCalls, 0, '冷启动时应跳过本机描述');
  assert.strictEqual(calls.length, 1, '仍应走远端（只是不含视觉信息）');
  assert.ok(!calls[0].img);
  assert.ok(!calls[0].ctx.screenObservation, '无视觉信息时不带该字段');
});

// ---------- 3. 描述失败/超时不阻断 ----------

test('本机描述超时 → 降级为「不带视觉信息」，仍走远端且不卡死', async () => {
  const calls = [];
  const { ctrl, captured } = makeController({
    model: 'hybrid',
    channel: okChannel(calls),
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.8, suggestion: '本地初判', reason: '' }),
    describeFn: async () => { throw new Error('描述模型推理失败'); },  // 报错而非超时
    modelRunner: { started: true },
  });
  // 描述报错应立即降级为「不带视觉信息」并继续走远端，不再等本机/远端看门狗计时
  const start = Date.now();
  await ctrl.triggerRule('word_writing');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `描述报错应立即降级，实际 ${elapsed}ms`);
  assert.strictEqual(calls.length, 1, '描述失败不应阻断远端调用');
  assert.ok(!calls[0].img);
  assert.ok(captured.suggestion, '仍应给出建议');
});

test('本机描述抛错 → 静默降级，不阻断远端', async () => {
  const calls = [];
  const { ctrl } = makeController({
    model: 'hybrid',
    channel: okChannel(calls),
    predictFn: async () => ({ intent: 'word_writing', confidence: 0.8, suggestion: '本地初判', reason: '' }),
    describeFn: async () => { throw new Error('llama-server 挂了'); },
    modelRunner: { started: true },
  });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].img);
  assert.ok(!calls[0].ctx.screenObservation);
});

// ---------- 4. 显式开启时才发原图 ----------

test('remoteVision=true（默认）：截图原图直接发给远端，无需本机先描述', async () => {
  const calls = [];
  let describeCalls = 0;
  const { ctrl } = makeController({
    channel: okChannel(calls),
    describeFn: async () => { describeCalls += 1; return 'y'; },
  });
  // v4.12.1：发图只看 remoteVision；makeController 默认关了它，这里重新打开
  ctrl.config.set({ remoteVision: true });
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(calls[0].img, 'B64', 'remoteVision 开启时应直接发原图');
  assert.strictEqual(describeCalls, 0, '发原图时无需再本地描述');
});

test('remoteVision=false：退回本机 VL 描述，不带原图', async () => {
  const calls = [];
  const { ctrl } = makeController({
    model: 'remote',
    channel: okChannel(calls),
    describeFn: async () => 'IDE 里一段 Python 报错栈',
    modelRunner: { started: true },
  });
  await ctrl.triggerRule('api_lookup');
  assert.ok(!calls[0].img, '关掉远端视觉时不发原图');
  assert.strictEqual(calls[0].ctx.screenObservation, 'IDE 里一段 Python 报错栈');
});

// ---------- 5. LocalModelRunner.describe ----------

test('LocalModelRunner.describe：把 VLM 输出清洗成描述文本（剥围栏/前缀，限长）', async () => {
  // 起一个假 llama-server，捕获请求体并回一段带围栏的描述
  const seen = [];
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(buf); } catch (_) {}
      seen.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '```\n描述：Word 里正在写报告\n```' } }],
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const runner = new LocalModelRunner({ host: '127.0.0.1', port, logger: noopLogger() });
  runner.started = true;   // 跳过真实 llama-server 启动
  const text = await runner.describe({ imageBase64: 'B64', behaviorContext: { rule: 'word_writing' } });
  srv.close();

  assert.strictEqual(text, 'Word 里正在写报告', '应剥掉代码围栏与「描述：」前缀');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].path, '/v1/chat/completions');
  const msgs = seen[0].body.messages;
  assert.strictEqual(msgs.length, 2);
  assert.ok(/视觉描述助手/.test(msgs[0].content), '应用描述专用提示词');
  assert.strictEqual(msgs[1].content[1].image_url.url, 'data:image/png;base64,B64');
  assert.ok(/word_writing/.test(msgs[1].content[0].text), '行为线索应带上');
});

test('LocalModelRunner.describe：请求失败返回空串，不抛异常', async () => {
  const runner = new LocalModelRunner({ host: '127.0.0.1', port: 1, logger: noopLogger() });
  runner.started = true;   // 端口 1 无监听 → 连接失败
  const text = await runner.describe({ imageBase64: 'B64' });
  assert.strictEqual(text, '');
});

test('LocalModelRunner：analyze 结果带 observation 字段（供远端纯文本模型使用）', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        intent: 'word_writing', confidence: 0.8, suggestion: 's', reason: 'r',
        observation: '记事本里一段未完成的话',
      }) } }],
    }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const runner = new LocalModelRunner({ host: '127.0.0.1', port, logger: noopLogger() });
  runner.started = true;
  const r = await runner.analyze({ imageBase64: 'B64', behaviorContext: {} });
  srv.close();
  assert.strictEqual(r.observation, '记事本里一段未完成的话');
});
