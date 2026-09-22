'use strict';

/**
 * v4.10.27：目标窗口捕获 + 主题输入（空白文档场景）链路测试。
 *
 * 覆盖两件事：
 *   1. 触发那一刻捕获到的 HWND 要一路传到注入动作上（否则内容插不到文档里）
 *   2. 屏幕没有正文时，用户在浮窗里填的主题要作为生成方向透传，并放行生成
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController } = require('../src/predict/predict-controller');
const {
  parseForegroundOutput,
  resolveForegroundScript,
} = require('../src/predict/target-window');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pred-target-'));
}

function makeCtrl({ choice = 'generate', obs = '', captureFn = null, generateRes = { content: '生成的正文' } } = {}) {
  const captured = { actionCalls: [], payloads: [], suggestion: null };
  const ctrl = new PredictController({
    appDir: tmpDir(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    capture: { captureActiveWindow: async () => ({ base64: 'X', width: 800, height: 600, source: 'screen' }) },
    panel: {
      available: true,
      show: async (s) => { captured.suggestion = s; return choice; },
      destroy() {},
    },
    actionExecutor: { execute: async (a) => { captured.actionCalls.push(a); return { ok: true, type: a.type }; } },
    generateContentFn: (p) => { captured.payloads.push(p); return Promise.resolve(generateRes); },
    captureTargetWindowFn: captureFn || (async () => ({ hwnd: 987654, pid: 4321, title: '季度总结 - WPS 文字' })),
  });
  ctrl.config.set({ model: 'none', enabled: true, authorized: true, confidenceThreshold: 0.6 });
  ctrl._lastObservation = obs;
  return { ctrl, captured };
}

// ---------- foreground.ps1 输出解析 ----------

test('parseForegroundOutput: 正常 JSON → 句柄/进程/标题', () => {
  const r = parseForegroundOutput('{"hwnd":123456,"pid":789,"title":"季度总结 - WPS 文字"}');
  assert.deepStrictEqual(r, { hwnd: 123456, pid: 789, title: '季度总结 - WPS 文字' });
});

test('parseForegroundOutput: null / 空 / 垃圾 → null（调用方回退 Z 序查找）', () => {
  assert.strictEqual(parseForegroundOutput('null'), null);
  assert.strictEqual(parseForegroundOutput(''), null);
  assert.strictEqual(parseForegroundOutput('   '), null);
  assert.strictEqual(parseForegroundOutput('不是 JSON'), null);
  assert.strictEqual(parseForegroundOutput('{"hwnd":0,"pid":1,"title":"x"}'), null, 'hwnd<=0 视为无效');
});

test('parseForegroundOutput: 夹带杂项输出时取最后一行的 JSON', () => {
  const raw = '前置警告\r\n{"hwnd":42,"pid":7,"title":"doc"}';
  assert.strictEqual(parseForegroundOutput(raw).hwnd, 42);
});

test('resolveForegroundScript: 源码态指向真实存在的 foreground.ps1', () => {
  const p = resolveForegroundScript();
  assert.ok(p.endsWith('foreground.ps1'), '应指向 foreground.ps1');
  assert.ok(fs.existsSync(p), '脚本文件应真实存在（PowerShell -File 才跑得起来）');
});

// ---------- 目标窗口句柄传递 ----------

// 生成+插入在流水线里是 fire-and-forget（不阻塞弹窗回收），断言前稍等一拍
function settle() { return new Promise((r) => setTimeout(r, 80)); }

test('触发时捕获到的目标窗口句柄会传到注入动作上', async () => {
  const { ctrl, captured } = makeCtrl({ choice: 'generate' });
  await ctrl.triggerRule('word_writing');
  await settle();
  assert.ok(captured.actionCalls.length >= 1, '应执行注入动作');
  const act = captured.actionCalls[0];
  assert.strictEqual(act.targetHwnd, 987654, '动作应带上触发时捕获的 HWND');
});

test('v4.10.33：捕获失败 → 不盲插，只写剪贴板（Z 序回退会猜错窗口）', async () => {
  const { ctrl, captured } = makeCtrl({ choice: 'generate', captureFn: async () => null });
  await ctrl.triggerRule('word_writing');
  await settle();
  assert.ok(captured.actionCalls.length >= 1);
  assert.strictEqual(captured.actionCalls[0].type, 'clipboard-keep', '没有可靠目标句柄时只写剪贴板，不执行注入');
});

// ---------- 主题输入（空白文档） ----------

test('_decorateSuggestion: 无观察 / 无正文 → 浮窗需要主题输入', () => {
  const { ctrl } = makeCtrl({});
  const a = ctrl._decorateSuggestion({ intent: 'word_writing' });
  assert.strictEqual(a.needTopic, true, '没有观察时应要求输入主题');
  assert.ok(a.topicHint && a.topicHint.length > 0);

  ctrl._lastObservation = '无正文：光标停在空白页，没有输入内容';
  assert.strictEqual(ctrl._decorateSuggestion({}).needTopic, true, '明确无正文时应要求输入主题');

  ctrl._lastObservation = '正在文档中写作，正文开头写着：数字化转型';
  assert.strictEqual(ctrl._decorateSuggestion({}).needTopic, undefined, '有正文时不应打扰用户');
});

test('无正文 + 没填主题 → 仍然拦截（不浪费一次远端生成）', async () => {
  const { ctrl, captured } = makeCtrl({
    choice: 'generate',
    obs: '无正文：空白文档，只有标题',
  });
  await ctrl._generateAndDeliver({ intent: 'word_writing', suggestion: '要我帮你写吗？' }, '');
  assert.strictEqual(captured.payloads.length, 0, '不应发起生成');
  assert.strictEqual(captured.actionCalls.length, 0, '不应插入任何内容');
});

test('无正文 + 用户填了主题 → 放行生成，主题作为最高优先级方向透传', async () => {
  const { ctrl, captured } = makeCtrl({
    choice: { choice: 'generate', topic: '2026 年数据安全治理方案' },
    obs: '无正文：空白文档，只有标题',
  });
  await ctrl._generateAndDeliver({ intent: 'word_writing', suggestion: '要我帮你写吗？' }, '2026 年数据安全治理方案');
  assert.strictEqual(captured.payloads.length, 1, '应发起一次生成');
  const p = captured.payloads[0];
  assert.strictEqual(p.topic, '2026 年数据安全治理方案');
  assert.ok(/2026 年数据安全治理方案/.test(p.direction), 'direction 应带上用户主题');
  assert.ok(/主题/.test(p.direction), 'direction 应明确要求围绕主题撰写');
  assert.strictEqual(captured.actionCalls.length, 1, '生成后应插入');
  assert.strictEqual(captured.actionCalls[0].targetHwnd, 987654);
});

test('_applyDecision 兼容旧的字符串决策（无 topic）', async () => {
  const { ctrl, captured } = makeCtrl({ choice: 'generate', obs: '正在文档中写作，写着：项目进展' });
  ctrl._applyDecision('generate', 'word_writing', { intent: 'word_writing', suggestion: '继续写' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(captured.payloads.length, 1, '字符串决策同样应触发生成');
  assert.strictEqual(captured.payloads[0].topic, '', '无主题时 topic 为空串');
});

test('_applyDecision 收到 {choice,topic} 时把主题带进生成', async () => {
  const { ctrl, captured } = makeCtrl({ choice: 'generate', obs: '' });
  ctrl._applyDecision({ choice: 'generate', topic: '季度总结' }, 'word_writing', { intent: 'word_writing', suggestion: '继续写' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(captured.payloads.length, 1);
  assert.ok(/季度总结/.test(captured.payloads[0].direction));
});
