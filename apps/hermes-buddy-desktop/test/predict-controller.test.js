'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { PredictController, hasUsableSourceContent } = require('../src/predict/predict-controller');

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
  // v4.10.2：「生成并插入」走真生成，无生成函数时兜底回填也改为 clipboard-keep
  //（不被 8 秒恢复机制冲掉）
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard' || a.type === 'clipboard-keep' || a.type === 'clipboard-paste' || a.type === 'type-input');
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
  assert.ok(captured.actionCalls.find((a) => (a.type === 'clipboard' || a.type === 'clipboard-keep' || a.type === 'clipboard-paste' || a.type === 'type-input') && /报错/.test(a.text)), '应回填模型生成的建议');
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
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard' || a.type === 'clipboard-keep' || a.type === 'clipboard-paste' || a.type === 'type-input');
  assert.ok(clip, '降级模板也应走剪贴板动作');
});

// ---------------------------------------------------------------------------
// v4.10.22：无正文守卫。用户连续反馈「生成并插入粘贴出来的是模板」，根因是截图里
// 根本没有正文（在聊天输入框/空白页里触发），远端只能吐模板兜底。这里锁定：
// 源素材明确无正文时不生成、不写剪贴板、不粘贴。
// ---------------------------------------------------------------------------

test('hasUsableSourceContent：空观察放行（remote 模式没有本地 VL，不能误杀）', () => {
  assert.strictEqual(hasUsableSourceContent(''), true);
  assert.strictEqual(hasUsableSourceContent(null), true);
  assert.strictEqual(hasUsableSourceContent(undefined), true);
});

test('hasUsableSourceContent：结构化「无正文」标记 → 拦截', () => {
  assert.strictEqual(hasUsableSourceContent('无正文：正在 WorkBuddy 的聊天输入框，输入框为空。'), false);
});

test('hasUsableSourceContent：空白页 / 空输入框类描述 → 拦截', () => {
  assert.strictEqual(hasUsableSourceContent('正在编辑区中，光标在空白处，没有输入内容。'), false);
  assert.strictEqual(hasUsableSourceContent('正在编辑的 Word 文档，光标在空白处，没有输入内容。'), false);
  assert.strictEqual(hasUsableSourceContent('打开了一个空白文档，还没有写任何东西。'), false);
});

test('hasUsableSourceContent：有正文摘录的描述 → 放行（不误伤真实写作）', () => {
  assert.strictEqual(hasUsableSourceContent('正在文档中写作，文档标题是《季度总结》，开头写着：本季度我们完成了...'), true);
  assert.strictEqual(hasUsableSourceContent('正在文档中写作，光标停在段落中间，前面写着：综上所述。'), true);
  // 描述里同时提到「光标在空白处」但有真实摘录时，不能误判成无正文
  assert.strictEqual(hasUsableSourceContent('正在文档中写作，标题是《项目计划》，光标在空白处'), true);
});

test('v4.10.22：屏幕无正文时点「生成并插入」→ 不调远端、不写剪贴板、不粘贴', async () => {
  const { ctrl, captured } = makeController({ model: 'none', choice: 'generate' });
  let generateCalled = 0;
  ctrl._generateContentFn = async () => { generateCalled += 1; return { content: '【模板】不该出现' }; };
  // 模拟上一轮 VL 明确报告：屏幕上没有正文
  ctrl._lastObservation = '无正文：正在聊天输入框，输入框为空。';
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(generateCalled, 0, '源素材为空时不该调用远端生成');
  assert.strictEqual(captured.actionCalls.length, 0, '不该写剪贴板 / 粘贴');
  // 推理记录里要能看到这次拦截及原因
  const entries = ctrl.getLog ? ctrl.getLog() : [];
  const blocked = entries.find((e) => e.status === 'no-source-content');
  assert.ok(blocked, '推理记录应记一条 no-source-content');
});

test('v4.10.22：屏幕有正文时点「生成并插入」→ 正常生成并回填（守卫不误伤）', async () => {
  const { ctrl, captured } = makeController({ model: 'none', choice: 'generate' });
  let generateCalled = 0;
  ctrl._generateContentFn = async () => { generateCalled += 1; return { content: '这是一段真正生成的正文内容。' }; };
  ctrl._lastObservation = '正在文档中写作，文档标题是《季度总结》，开头写着：本季度我们完成了三项重点任务';
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(generateCalled, 1, '有正文时应调用远端生成');
  const clip = captured.actionCalls.find((a) => a.type === 'type-input' || a.type === 'clipboard-paste');
  assert.ok(clip, '应触发回填动作（直接输入或粘贴）');
  assert.strictEqual(clip.text, '这是一段真正生成的正文内容。');
});

test('v4.10.24：insertMode 默认直接输入（type-input），paste 模式走剪贴板粘贴', async () => {
  const a = makeController({ model: 'none', choice: 'generate' });
  a.ctrl._generateContentFn = async () => ({ content: '直接输入的正文。' });
  a.ctrl._lastObservation = '正在文档中写作，标题是《项目计划》，开头写着：本周进度如下';
  await a.ctrl.triggerRule('word_writing');
  assert.strictEqual(a.captured.actionCalls[0].type, 'type-input', '默认应为 type-input');

  const b = makeController({ model: 'none', choice: 'generate' });
  b.ctrl.config.set({ insertMode: 'paste' });
  b.ctrl._generateContentFn = async () => ({ content: '粘贴的正文。' });
  b.ctrl._lastObservation = '正在文档中写作，标题是《项目计划》，开头写着：本周进度如下';
  await b.ctrl.triggerRule('word_writing');
  assert.strictEqual(b.captured.actionCalls[0].type, 'clipboard-paste', 'insertMode=paste 应为 clipboard-paste');
});

test('v4.10.23：生成请求必须带上窗口标题（windowTitle）——文档名是最可靠的主题锚点', async () => {
  const { ctrl } = makeController({ model: 'none', choice: 'generate' });
  let payload = null;
  ctrl._generateContentFn = async (p) => { payload = p; return { content: '围绕文档主题生成的正文。' }; };
  ctrl._lastObservation = '正在文档中写作，文档标题是《项目计划》，开头写着：本周进度如下';
  ctrl._lastWindowTitle = 'Hermes-buddy4.5 使用结论.docx - Word';
  await ctrl.triggerRule('word_writing');
  assert.ok(payload, '生成函数应被调用');
  assert.strictEqual(payload.windowTitle, 'Hermes-buddy4.5 使用结论.docx - Word',
    'windowTitle 必须随生成请求上行');
  assert.strictEqual(payload.screenObservation, ctrl._lastObservation);
});

test('v4.10.36：直接输入+自动粘贴均未送达 → 内容留剪贴板并提示手动 Ctrl+V，不谎报成功', async () => {
  const { ctrl } = makeController({ model: 'none' });
  const calls = [];
  // 模拟 type-input 与其回退的 clipboard-paste 都没能把内容送进目标窗口
  ctrl.actionExecutor = {
    execute: async (a) => {
      calls.push(a.type);
      return { ok: false, type: a.type, delivered: false, message: '请手动 Ctrl+V' };
    },
  };
  ctrl._targetWindow = { hwnd: 12345, title: '文档1 - WPS Office' };
  ctrl._targetCaptureAttempted = false;
  ctrl._lastObservation = '正在文档中写作，文档标题是《运维规划》，开头写着：本规划旨在保障服务连续';
  ctrl._generateContentFn = async () => ({ content: '这是真正生成的正文内容。' });
  let notified = false;
  ctrl._notifyClipboardFallback = () => { notified = true; };
  ctrl._notifyGenerated = () => { throw new Error('未送达时不应弹"已生成并输入"通知'); };
  await ctrl._generateAndDeliver({ intent: 'word_writing', suggestion: '' });
  assert.deepStrictEqual(calls, ['type-input'], '应先尝试直接输入（其内部回退由 executor 负责）');
  assert.ok(notified, '两种方式都未送达时，必须通知用户手动粘贴');
});

test('v4.10.38：明确写作意图 + autoInsert → 直接生成并插入，不停在确认框', async () => {
  const { ctrl } = makeController({ model: 'remote', choice: 'generate' });
  let autoGenerated = 0;
  let panelShowCalled = 0;
  let thinkingShown = '';
  // stub _analyze：远端已识别出明确写作意图（绕过真实通道）
  ctrl._analyze = async () => ({
    intent: 'word_writing',
    confidence: 0.85,
    suggestion: '在《运维规划》卡住了？帮你续写下一段。',
    reason: '写作停顿',
  });
  ctrl._generateAndDeliver = async () => { autoGenerated += 1; };
  // panel：记录是否走了「停在确认框」的 show，以及思考态文案
  ctrl.panel = {
    available: true,
    show: async () => { panelShowCalled += 1; return 'later'; },
    showThinking: (t) => { thinkingShown = t; },
    armThinkingTimeout() {},
    cancelThinking() {},
  };
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(panelShowCalled, 0, '自动插入不应停在确认框等点击');
  assert.strictEqual(autoGenerated, 1, '应直接触发生成并插入');
  assert.ok(/正在生成/.test(thinkingShown), '生成期间浮窗应显示「正在生成…」');
});

test('v4.10.38：autoInsert=false → 回到先确认再生成（停在确认框）', async () => {
  const { ctrl } = makeController({ model: 'remote', choice: 'generate' });
  ctrl.config.set({ autoInsert: false });
  let autoGenerated = 0;
  let panelShowCalled = 0;
  ctrl._analyze = async () => ({
    intent: 'word_writing',
    confidence: 0.85,
    suggestion: '帮你续写下一段。',
    reason: '写作停顿',
  });
  ctrl._generateAndDeliver = async () => { autoGenerated += 1; };
  ctrl.panel = {
    available: true,
    show: async () => { panelShowCalled += 1; return 'generate'; },
    showThinking() {},
    armThinkingTimeout() {},
    cancelThinking() {},
  };
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(panelShowCalled, 1, '关闭自动插入后应停在确认框');
  assert.strictEqual(autoGenerated, 1, '用户确认后才生成');
});

test('v4.10.38：模糊意图 reading_or_thinking 即使 autoInsert 开启也不自动写', () => {
  const { ctrl } = makeController({ model: 'none' });
  assert.strictEqual(ctrl._shouldAutoInsert('word_writing'), true);
  assert.strictEqual(ctrl._shouldAutoInsert('reading_or_thinking'), false);
  ctrl.config.set({ autoInsert: false });
  assert.strictEqual(ctrl._shouldAutoInsert('word_writing'), false);
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
