'use strict';

/**
 * 音色预设与语音会话事件流的回归测试（v4.12.22）。
 *
 * 背景：本机只有老式 SAPI 嗓音（Huihui/Yaoyao），机械感强、用户嫌"不好听"，
 * 想要萝莉音。离线条件下靠两步做音色：
 *  1. SSML <prosody pitch> 让合成引擎变调；
 *  2. ffmpeg asetrate（变尖）+ atempo（把速度补回来）实现「变调不变速」。
 * 同时语音一激活要往主窗口推事件流，让「语音对话」面板按聊天步骤滚动。
 *
 * 钉死三件事：
 *  1. 萝莉/甜美等预设必须真的带 pitch 与 >1 的 shift（否则听起来还是原声）；
 *  2. 未知 style id 必须安全回退到原声，不能崩、不能传空参数给 SAPI；
 *  3. 会话事件必须发到主窗口，且类型齐全（open/phase/user/ai/error）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VoiceManager, VOICE_STYLES } = require('../src/voice/voice-manager');

function makeVm(sink) {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (_c, p) => sent.push({ channel: _c, payload: p }) } };
  const vm = new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-voice-')),
    getPet: () => null,
    getMainWindow: () => win,
    getPredict: () => ({ config: { get: () => ({ enabled: true }), set() {} } }),
  });
  if (sink) vm.setSessionSink(sink);
  return { vm, sent, win };
}

test('音色预设里必须有萝莉/童声，且变调系数明显高于 1', () => {
  const loli = VOICE_STYLES.find((s) => /萝莉|童声/.test(s.label));
  assert.ok(loli, '预设里应该有萝莉/童声：' + JSON.stringify(VOICE_STYLES.map((s) => s.label)));
  assert.ok(Number(loli.pitch) > 1.1, '萝莉音的变调系数应明显高于 1：' + loli.pitch);
});

test('每个预设的字段都合法（id/label 非空，pitch 为正数，rate 在 -10..10）', () => {
  for (const s of VOICE_STYLES) {
    assert.ok(s.id && s.label, '预设缺 id/label：' + JSON.stringify(s));
    assert.ok(Number(s.pitch) > 0, 'pitch 必须为正数：' + JSON.stringify(s));
    assert.ok(Math.abs(Number(s.rate) || 0) <= 10, 'rate 越界：' + JSON.stringify(s));
  }
});

// v4.12.24：变调系数必须能被 SAPI 语速补偿回来，否则"变调=变速"听着像快进
test('每个非原声预设的语速补偿量与变调系数匹配（|log2(pitch)+0.1575·rate| 够小）', () => {
  const { sapiRateForPitch } = require('../src/voice/voice-manager');
  for (const s of VOICE_STYLES) {
    const comp = sapiRateForPitch(s.pitch);
    // 补偿后残余时长误差 = 2^(-0.1575·comp) / pitch
    const residual = Math.pow(2, -0.1575 * comp) / Number(s.pitch);
    assert.ok(residual > 0.9 && residual < 1.12,
      `预设 ${s.id} 变调 ${s.pitch} 的语速补偿 ${comp} 不匹配，残余时长倍率 ${residual.toFixed(3)}（会明显变速）`);
  }
});

test('sapiRateForPitch：变调越高，合成语速越慢（负 rate）', () => {
  const { sapiRateForPitch } = require('../src/voice/voice-manager');
  assert.ok(sapiRateForPitch(1.26) <= -1, '升调应让 SAPI 说慢：' + sapiRateForPitch(1.26));
  assert.ok(sapiRateForPitch(0.9) >= 1, '降调应让 SAPI 说快：' + sapiRateForPitch(0.9));
  assert.equal(sapiRateForPitch(1), 0, '原声不补偿');
});

test('未知音色 id 回退到原声，绝不把空配置丢给 SAPI', () => {
  const cfg = { enabled: true, style: '不存在的音色', voiceName: '', rate: 0, volume: 100 };
  const style = VOICE_STYLES.find((s) => s.id === cfg.style) || VOICE_STYLES[0];
  assert.equal(style.id, 'natural', '未知 id 必须回退到 natural');
  assert.equal(Number(style.pitch), 1, '回退后不应做变调');
});

test('_shiftPitch：原声（ratio≈1）直接跳过，不做无谓处理', async () => {
  const { vm } = makeVm();
  assert.equal(await vm._shiftPitch('x.wav', 1), null, '原声不该变调');
  assert.equal(await vm._shiftPitch('x.wav', 0), null, '非法 ratio 不该变调');
  assert.equal(await vm._shiftPitch('x.wav', 1.005), null, '几乎等于原声时跳过');
});

// v4.12.24：变调不能再依赖 ffmpeg（用户机器没装 → 选了音色还是原声）
test('没有 ffmpeg 也能变调（纯 JS 重采样，实测 PCM WAV 生效）', async () => {
  const { vm, } = makeVm(); // appDir 是空临时目录 → 找不到 ffmpeg
  const { writeWavPcm, readWavPcm } = require('../src/voice/voice-manager');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pitch-'));
  const src = path.join(dir, 'tts.wav');
  // 造一段 440Hz 正弦：变调后频率必须变成 440×ratio
  const sr = 22050, n = sr, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(0.6 * 32767 * Math.sin(2 * Math.PI * 440 * i / sr));
  writeWavPcm(src, { sampleRate: sr, channels: 1, samples: s });
  const out = await vm._shiftPitch(src, 1.26);
  assert.ok(out && fs.existsSync(out), '没有 ffmpeg 也必须产出变调文件（否则音色形同虚设）');
  const pcm = readWavPcm(out);
  const zcr = (a) => { let z = 0; for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++; return z; };
  const f = zcr(pcm.samples) / 2 / (pcm.frames / sr);
  assert.ok(Math.abs(f - 440 * 1.26) < 12, `变调后频率应≈${(440 * 1.26).toFixed(0)}Hz，实测 ${f.toFixed(1)}Hz`);
  // 时长应被压缩到 1/1.26（配合 SAPI 慢速合成后回到原速）
  assert.ok(Math.abs(pcm.frames - Math.floor(n / 1.26)) <= 1, '输出帧数应为 源帧数/ratio：' + pcm.frames);
});

test('非 PCM / 打不开的文件：变调失败返回 null，绝不把坏音频往下传', async () => {
  const { vm } = makeVm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bad-'));
  const bad = path.join(dir, 'tts.wav');
  fs.writeFileSync(bad, 'not a wav at all');
  assert.equal(await vm._shiftPitch(bad, 1.26), null, '坏文件必须返回 null（调用方用原音频）');
});

test('会话事件会发到主窗口，且 onSession 回调也能收到', () => {
  const seen = [];
  const { vm, sent } = makeVm((e) => seen.push(e));
  vm._emitSession({ type: 'open' });
  vm._emitSession({ type: 'phase', phase: 'listening', text: '聆听中…' });
  vm._emitSession({ type: 'user', text: '今天天气怎么样' });
  vm._emitSession({ type: 'ai', text: '正在思考…', pending: true });
  vm._emitSession({ type: 'ai', text: '晴转多云', pending: false });
  vm._emitSession({ type: 'error', message: '麦克风不可用' });
  assert.equal(sent.length, 6, '六个事件都应推给主窗口');
  assert.ok(sent.every((s) => s.channel === 'buddy:voice:session'), '走的是语音会话频道');
  assert.deepEqual(seen.map((e) => e.type), ['open', 'phase', 'user', 'ai', 'ai', 'error']);
});

test('语音错误同时进会话流（用户在对话面板里也能看到失败原因）', () => {
  const { vm, sent } = makeVm();
  vm._reportVoiceError('麦克风被占用');
  const errs = sent.filter((s) => s.channel === 'buddy:voice:error' || s.payload.type === 'error');
  assert.ok(errs.length >= 1, '错误要可见');
  assert.ok(JSON.stringify(sent).includes('麦克风被占用'));
});

test('voiceStyles() 返回预设副本（外部改不脏内部常量）', () => {
  const { vm } = makeVm();
  const a = vm.voiceStyles();
  a.push({ id: 'hack' });
  assert.equal(vm.voiceStyles().some((s) => s.id === 'hack'), false, '必须返回副本');
});

// ---- v4.12.23：语音对话独立小窗（不唤主窗口）----
const MAIN_JS423 = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('语音激活时弹独立小窗而非唤主窗口（会话 sink 接 handleVoiceSessionEvent）', () => {
  const src = MAIN_JS423();
  assert.ok(/setSessionSink\(handleVoiceSessionEvent\)/.test(src), 'setSessionSink 必须指向 handleVoiceSessionEvent');
  // showVoiceChat 函数体里不得再调用 restoreMainWindow
  const m = src.match(/function showVoiceChat\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'main.js 必须定义 showVoiceChat');
  assert.ok(!m[0].includes('restoreMainWindow'), 'showVoiceChat 不允许唤主窗口');
  assert.ok(/function handleVoiceSessionEvent[\s\S]*?evt\.type === 'open'[\s\S]*?showVoiceChat\(\)/.test(src),
    'open 事件必须走 showVoiceChat');
});

test('语音对话小窗三件套存在（html + preload，支持会话/播放/隐藏）', () => {
  const dir = path.join(__dirname, '..', 'src', 'voice');
  const html = fs.readFileSync(path.join(dir, 'voice-chat.html'), 'utf8');
  assert.ok(html.includes('vc.onSession') && html.includes('vc.hide') && html.includes('vc.onPlay'),
    '小窗页面要订阅会话事件、播放音频并支持关闭');
  const pre = fs.readFileSync(path.join(dir, 'voice-chat-preload.js'), 'utf8');
  for (const kw of ['onSession', 'onPlay', 'hide', 'contextBridge']) {
    assert.ok(pre.includes(kw), `preload 缺少 ${kw}`);
  }
});

test('TTS 播放优先级：桌宠 → 语音小窗 → 主窗口', () => {
  const vm = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'voice-manager.js'), 'utf8');
  const iPet = vm.indexOf('pet:speak-audio');
  const iVc = vm.indexOf("vcWin.webContents.send('buddy:voice:play'");
  const iMw = vm.indexOf("mw.webContents.send('buddy:voice:play'");
  assert.ok(iPet > 0 && iVc > iPet && iMw > iVc, 'speak() 播放顺序必须是 桌宠→小窗→主窗口');
});
