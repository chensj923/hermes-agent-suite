'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

// v4.10.39：把两处「等待操作自身超时」压到几十毫秒，便于用永不返回的 fake
// 验证挂起点会被超时打破（正常立即返回的 fake 不受影响）。必须在 require 控制器前设置。
process.env.HERMES_PANEL_SHOW_TIMEOUT_MS = '30';
process.env.HERMES_CAPTURE_TIMEOUT_MS = '50';

const { PredictController, hasUsableSourceContent } = require('../src/predict/predict-controller');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pred-ctrl-'));
  return d;
}

/** 构造一个带注入 fake 的控制器（不碰真实 electron / 模型 / 杀软）。 */
// v4.12.0：运行模式已移除，不再接收 model；远端通道未注入即视为断线，
// 思考/解答由本机模型（predictFn / localGenerate）兜底。
function makeController({ choice = 'generate', predictFn = null, localGenerate = null } = {}) {
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
  if (typeof localGenerate === 'function') ctrl._localGenerateFn = localGenerate;
  ctrl.config.set({ enabled: true, authorized: true, confidenceThreshold: 0.6 });
  return { ctrl, captured, appDir };
}

// v4.12.0：远端断线、本机分析引擎也未安装 → 先降级为规则模板弹窗；
// 用户点「生成」后不再把建议话术塞进剪贴板，而是用本机离线生文兜底投递。
const CLIPBOARD_ACTIONS = ['clipboard', 'clipboard-keep', 'clipboard-paste', 'type-input'];

test('远端断线 + 本机分析未就绪 → 降级弹窗记接受，本机离线生文兜底投递', async () => {
  const { ctrl, captured } = makeController({ choice: 'generate' });
  // 本机离线生文兜底（v4.12.0 新增能力）
  ctrl._localGenerateFn = async () => '本机离线生成的正文内容。';
  // 用「动作执行信号」接住 fire-and-forget 的生成投递，避免时序竞态
  let resolveAction;
  const actionPromise = new Promise((r) => { resolveAction = r; });
  ctrl.actionExecutor = {
    execute: async (a) => { captured.actionCalls.push(a); resolveAction(); return { ok: true, type: a.type }; },
  };
  await ctrl.triggerRule('word_writing');
  assert.ok(captured.suggestion, '应展示降级建议');
  assert.strictEqual(captured.suggestion.intent, 'word_writing');
  // 引擎回到 IDLE，且 word_writing 记了一次接受
  assert.strictEqual(ctrl.engine.state, 'IDLE');
  assert.strictEqual(ctrl.db.getStats('word_writing').accepts, 1);
  // 等待后台投递真正完成
  await actionPromise;
  const clip = captured.actionCalls.find((a) => CLIPBOARD_ACTIONS.includes(a.type));
  assert.ok(clip, '本机离线生文应触发投递动作');
  assert.strictEqual(clip.text, '本机离线生成的正文内容。', '投递的必须是本机生成正文，而非建议话术');
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

test('predictFn 高置信度 + 用户生成 → 经 capture 截图分析，本机离线生文投递', async () => {
  const { ctrl, captured } = makeController({
    choice: 'generate',
    predictFn: async (ctx, img) => {
      captured.analyzeCalls += 1;
      assert.ok(img === 'BASE64FAKE', '应把截图 base64 传给本机模型');
      return { intent: 'api_lookup', confidence: 0.9, suggestion: '把这段报错贴给我', reason: '反复切窗查文档' };
    },
  });
  // 远端断线：生成阶段用本机离线生文兜底（产出含报错线索的正文）
  ctrl._localGenerateFn = async () => '排查步骤：先把这段完整报错复制下来再定位。';
  let resolveAction;
  const actionPromise = new Promise((r) => { resolveAction = r; });
  ctrl.actionExecutor = {
    execute: async (a) => { captured.actionCalls.push(a); resolveAction(); return { ok: true, type: a.type }; },
  };
  await ctrl.triggerRule('api_lookup');
  assert.strictEqual(captured.analyzeCalls, 1, '应调用一次本机分析模型');
  await actionPromise;
  const clip = captured.actionCalls.find((a) => CLIPBOARD_ACTIONS.includes(a.type));
  assert.ok(clip, '本机离线正文应触发投递');
  assert.ok(/报错/.test(clip.text), '投递正文应围绕报错线索，而非把建议问句当正文');
});

test('远端断线 + 本机分析与生成都未就绪 → 降级弹窗且明确报错，绝不盲插建议话术', async () => {
  // 复现线上 bug：本机 VLM 引擎未安装，_analyze 抛「本地模型未就绪」，
  // 旧行为 modelTimeout()+return 导致一次都不弹；v4.8.5 起降级为规则模板弹窗，
  // v4.12.0 进一步规定：点生成后远端与本机都生不出正文时明确报错、零投递，
  // 绝不把「需要我帮你做点什么吗」这类话术当正文插进文档。
  const { ctrl, captured } = makeController({ choice: 'generate' });
  let resolveFail;
  const failPromise = new Promise((r) => { resolveFail = r; });
  ctrl._notifyGenerateFailed = (d) => { resolveFail(String(d || '')); };
  await ctrl.triggerRule('api_lookup');
  assert.ok(captured.suggestion, '模型失败也必须弹窗（降级模板）');
  assert.strictEqual(captured.suggestion.intent, 'api_lookup');
  assert.ok(/降级/.test(captured.suggestion.reason), 'reason 应注明降级原因');
  assert.ok(/未就绪/.test(captured.suggestion.reason), 'reason 应包含引擎未就绪信息');
  // 确定性等待后台生文兜底的最终失败通知
  const notifiedFail = await failPromise;
  const clip = captured.actionCalls.find((a) => CLIPBOARD_ACTIONS.includes(a.type));
  assert.strictEqual(clip, undefined, '本机也生不出正文时不应有任何投递动作');
  assert.ok(notifiedFail, '必须明确通知生成失败，而非静默或谎报成功');
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

// ---------------------------------------------------------------------------
// v4.10.39：永久挂起回归。线上 22:06:57 场景规则、22:07:01 主动预测两次触发后
// 35 分钟无任何日志、进程却还在——根因是 await panel.show() / await getSources()
// 无超时、且兜底安全定时器在它们之后才安装。这里用「永不返回」的 fake 锁定：
// 两处挂起点都必须被自身超时打破，调用方能返回，不永久卡死。
// ---------------------------------------------------------------------------

test('v4.10.39：场景浮窗 show 永不返回 → 超时打破、强制了结，onWindowChange 能返回', async () => {
  let dismissed = 0;
  const hangPanel = {
    available: true,
    show: () => new Promise(() => {}),          // 模拟窗口创建/setSize 卡死，永不返回
    dismissAwaiting() { dismissed += 1; },
    cancelThinking() {},
    destroy() {},
  };
  const appDir = tmpDir();
  const ctrl = new PredictController({
    appDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    capture: { captureActiveWindow: async () => ({ base64: 'X', width: 800, height: 600 }) },
    panel: hangPanel,
    actionExecutor: { execute: async (a) => ({ ok: true, type: a.type }) },
  });
  ctrl.config.set({ enabled: true, authorized: true });
  ctrl._enabled = true;   // isEnabled() 依赖运行态标志
  // 命中内置场景规则 scene-wps-new（exeName=wps）
  await ctrl.onWindowChange({ exeName: 'wps', title: '文档1 - WPS Office' });
  assert.strictEqual(dismissed, 1, '浮窗挂起超时后应强制了结内部等待并收窗');
});

test('v4.10.39：截图 getSources 永不返回 → 超时后主动预测仍降级给建议，不卡死', async () => {
  let shown = null;
  const immediatePanel = {
    available: true,
    show: async (s) => { shown = s; return 'later'; },
    showThinking: async () => {},
    cancelThinking() {},
    destroy() {},
  };
  const appDir = tmpDir();
  const ctrl = new PredictController({
    appDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    capture: { captureActiveWindow: () => new Promise(() => {}) },  // 模拟 getSources 挂死
    panel: immediatePanel,
    actionExecutor: { execute: async (a) => ({ ok: true, type: a.type }) },
  });
  // remote 但无通道：截图超时只记 warn（imageBase64 保持 null），analyze 再因无通道
  // 降级为规则模板，最终仍弹窗——关键是整个 predictNow 能返回而非永久 await。
  ctrl.config.set({ model: 'remote', enabled: true, authorized: true });
  const result = await ctrl.predictNow();
  assert.strictEqual(result.shown, true, '截图挂起超时后也应降级给出可见建议');
  assert.ok(shown, '应展示降级建议浮窗');
});

// v4.10.41 回归：截图失败但前台是 WPS/Word 时，远端盲猜 reading_or_thinking 不可靠，
// 应把意图修正为 word_writing 并触发自动生成。
test('截图失败但前台是 WPS → 修正为写作意图并自动生成', async () => {
  let analyzedIntent = '';
  let generatedIntent = '';
  let generatedTopic = '';
  const predictFn = async (ctx) => {
    analyzedIntent = ctx._forceWriting ? 'reading_or_thinking' : 'word_writing';
    return {
      intent: 'reading_or_thinking',
      confidence: 0.25,
      suggestion: '需要我帮你梳理思路或找资料吗？',
      reason: '无截图，行为元数据偏阅读',
    };
  };
  const { ctrl } = makeController({ model: 'local', predictFn });
  ctrl.config.set({ autoInsert: true });
  ctrl.resolveWindow = async () => ({ exeName: 'wps', title: '标题 2 - WPS 文字', windowClass: 'Wps_Application' });
  ctrl.capture = { captureActiveWindow: async () => { throw new Error('截图超时'); } };
  ctrl._generateContentFn = async (req) => {
    generatedIntent = req.rule;
    generatedTopic = req.topic || '';
    return { content: '这是根据标题生成的正文内容。' };
  };
  await ctrl.triggerRule('word_writing');
  assert.strictEqual(analyzedIntent, 'reading_or_thinking', '预测函数仍被调用且看到 _forceWriting 标记');
  assert.strictEqual(generatedIntent, 'word_writing', '最终生成时应按 word_writing 意图');
  assert.ok(generatedTopic.includes('标题 2') || generatedTopic.includes('WPS'), '应用窗口标题应作为生成主题兜底');
});

// v4.10.41 回归：截图失败但前台不是 WPS/Word 时，不强制修正意图。
test('截图失败且前台非 Word → 保持远端意图不兜底', async () => {
  let generated = false;
  const predictFn = async () => ({
    intent: 'reading_or_thinking',
    confidence: 0.25,
    suggestion: '需要我帮你梳理思路或找资料吗？',
    reason: '无截图',
  });
  const { ctrl } = makeController({ model: 'local', predictFn });
  ctrl.config.set({ autoInsert: true });
  ctrl.resolveWindow = async () => ({ exeName: 'chrome', title: '哔哩哔哩 - 个人主页', windowClass: 'Chrome_WidgetWin_1' });
  ctrl.capture = { captureActiveWindow: async () => { throw new Error('截图超时'); } };
  ctrl._generateContentFn = async () => { generated = true; return { content: 'x' }; };
  await ctrl.triggerRule('reading_or_thinking');
  assert.strictEqual(generated, false, '非写作应用不应强制生成');
});

// v4.10.42 回归：远端生成返回空 content / error 时，不能把建议文案当正文插入。
test('远端生成返回空 content → 不插入任何内容', async () => {
  const { ctrl, captured } = makeController({ model: 'none', choice: 'generate' });
  ctrl._generateContentFn = async () => ({ content: '', error: 'empty', reason: '模型返回空内容' });
  await ctrl.triggerRule('word_writing');
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard' || a.type === 'clipboard-keep' || a.type === 'clipboard-paste' || a.type === 'type-input');
  assert.strictEqual(clip, undefined, '生成失败时不应写剪贴板/粘贴');
  const entries = ctrl.getLog ? ctrl.getLog() : [];
  const failed = entries.find((e) => e.status === 'no-content');
  assert.ok(failed, '推理记录应记 no-content');
  assert.strictEqual(failed.error, 'empty', '应透传服务端 error 字段');
});

test('远端生成抛异常 → 不插入任何内容', async () => {
  const { ctrl, captured } = makeController({ model: 'none', choice: 'generate' });
  ctrl._generateContentFn = async () => { throw new Error('上游请求超时'); };
  await ctrl.triggerRule('word_writing');
  const clip = captured.actionCalls.find((a) => a.type === 'clipboard' || a.type === 'clipboard-keep' || a.type === 'clipboard-paste' || a.type === 'type-input');
  assert.strictEqual(clip, undefined, '生成失败时不应写剪贴板/粘贴');
});

// v4.12.9 回归：触发链路远端识别为游戏（game_live），用户点生成 → 只给建议、
// 保留到剪贴板，绝不把 310 字建议敲进游戏窗口（旧 bug：suggestion 未设 noInsert）。
test('触发链路 game_live → 只保留剪贴板给建议，绝不注入游戏', async () => {
  const advice = '1. 先出对子压住；\n2. 保留顺子应对；\n3. 当前优先选左侧那张牌。';
  const { ctrl, captured } = makeController({
    choice: 'generate',
    predictFn: async () => ({
      intent: 'game_live',
      confidence: 0.8,
      suggestion: '需要我看着当前画面给即时建议吗？',
      reason: '识别到棋类对局',
    }),
  });
  ctrl._generateContentFn = async () => ({ content: advice });
  // 接住 fire-and-forget 的投递动作，避免时序竞态
  let resolveAction;
  const actionPromise = new Promise((r) => { resolveAction = r; });
  ctrl.actionExecutor = {
    execute: async (a) => { captured.actionCalls.push(a); resolveAction(); return { ok: true, type: a.type }; },
  };
  await ctrl.triggerRule('game_live');
  assert.strictEqual(captured.suggestion.intent, 'game_live', '应展示 game_live 建议');
  assert.strictEqual(captured.suggestion.noInsert, true, '触发链路也应按意图元数据标记不写入');
  await actionPromise;
  const injected = captured.actionCalls.find((a) => a.type === 'type-input' || a.type === 'clipboard-paste');
  assert.strictEqual(injected, undefined, '游戏场景绝不注入/粘贴到窗口');
  const keep = captured.actionCalls.find((a) => a.type === 'clipboard-keep');
  assert.ok(keep, '建议应保留到剪贴板供用户自取');
  assert.strictEqual(keep.text, advice, '保留的必须是完整游玩建议（含分条换行，不截断）');
});

// v4.12.25 回归：语音问具体问题要先截图，并把预测进度同步到语音小窗。
test('voicePrompt 先截图、按序汇报进度、并把图传给生成函数', async () => {
  const { ctrl } = makeController({ model: 'none', choice: 'generate' });
  let generateCalled = 0;
  let generateImage = null;
  let generatePayload = null;
  ctrl._generateContentFn = async (payload, image) => {
    generateCalled += 1;
    generateImage = image;
    generatePayload = payload;
    return { content: '这是结合屏幕内容给出的回复。' };
  };
  const progress = [];
  const reply = await ctrl.voicePrompt('帮我判断现在该回什么', { title: '微信 - 陈' }, (step) => {
    progress.push({ phase: step.phase, text: step.text });
  });
  assert.strictEqual(reply, '这是结合屏幕内容给出的回复。');
  assert.strictEqual(generateCalled, 1, '必须先截图再调用生成');
  assert.strictEqual(generateImage, 'BASE64FAKE', '远端视觉开启时应把截图 base64 直接传给生成函数');
  assert.ok(generatePayload, '生成 payload 必须存在');
  assert.strictEqual(generatePayload.rule, 'voice_command');
  assert.strictEqual(generatePayload.windowTitle, '微信 - 陈');
  assert.ok(/不要再说"看不到屏幕"/.test(generatePayload.direction), 'direction 必须提示模型不要复读看不到');
  assert.deepStrictEqual(progress.map((s) => s.phase), ['capturing', 'generating'], '进度顺序应为截图→生成');
  assert.ok(/看屏幕/.test(progress[0].text), 'capturing 阶段文案应明确在看屏幕');
});

test('voicePrompt remoteVision=false 时用本机 VL 描述并写入 screenObservation', async () => {
  const { ctrl } = makeController({ model: 'none', choice: 'generate' });
  ctrl.config.set({ remoteVision: false });
  // 模拟本机 VL：把 base64 前缀作为观察返回
  ctrl._describeFn = async (_ctx, imageBase64) => '屏幕内容是：' + (imageBase64 ? '有图' : '无图');
  // 让 _localVisionToText 认为本机已热启，否则为避免冷启动会直接跳过描述
  ctrl._predictFn = async () => ({ observation: '' });
  let generatePayload = null;
  ctrl._generateContentFn = async (payload) => {
    generatePayload = payload;
    return { content: '已读屏后的回复。' };
  };
  const reply = await ctrl.voicePrompt('这个窗口里写了什么');
  assert.strictEqual(reply, '已读屏后的回复。');
  assert.ok(generatePayload, '生成 payload 必须存在');
  assert.ok(/屏幕内容是：有图/.test(generatePayload.screenObservation), 'remoteVision=false 时应把本机 VL 描述写进 screenObservation');
});
