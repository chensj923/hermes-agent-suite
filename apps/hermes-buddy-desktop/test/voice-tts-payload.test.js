'use strict';

/**
 * TTS 播放载荷的回归测试（v4.12.20）。
 *
 * 背景：TTS 渲染出的 WAV 原先只以 file:// URL 交给渲染层播放。主窗口和桌宠窗口
 * 都是 file:// 源且开了 sandbox，Chromium 对 file:// 页面加载 file:// 媒体资源
 * 有访问限制，解码失败只抛 "Failed to load because no supported source was found."，
 * 表现为「点了试听没反应/报错」。改成内联 base64 data URL 后彻底绕开该限制。
 *
 * 这些用例钉死三件事：
 *  1. 正常 WAV 必须内联成 data URL（而不是 file:// URL）；
 *  2. 「空壳 WAV」（只有 44 字节文件头，没装语音时 SAPI 会写出这种）必须被拦下并说人话；
 *  3. speak() 面对空壳音频必须返回 ok:false + 可读原因，而不是假装成功。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VoiceManager } = require('../src/voice/voice-manager');

/** 造一个合法的 44 字节 WAV 头（PCM 22.05kHz/16bit/单声道）。 */
function wavHeader(dataBytes = 0) {
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);          // PCM
  b.writeUInt16LE(1, 22);          // 单声道
  b.writeUInt32LE(22050, 24);      // 采样率
  b.writeUInt32LE(44100, 28);      // 字节率
  b.writeUInt16LE(2, 32);          // blockAlign
  b.writeUInt16LE(16, 34);         // bits
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

function makeVm() {
  return new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tts-')),
    getPet: () => null,
    getMainWindow: () => null,
    getPredict: () => ({ config: { get: () => ({ enabled: true, speakerId: '' }) } }),
  });
}

test('正常 WAV → 内联成 data URL，且不再依赖 file:// 路径', () => {
  const vm = makeVm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tts-ok-'));
  const wav = path.join(dir, 'tts.wav');
  fs.writeFileSync(wav, wavHeader(4096));

  const p = vm._audioPayload(wav, { speakerId: '' });
  assert.ok(p.dataUrl.startsWith('data:audio/wav;base64,'), '必须内联成 data URL：' + p.dataUrl.slice(0, 40));
  assert.equal(p.path, '', '内联后不应再让渲染层去读文件');
  assert.equal(p.url, '', '内联后不应再给 file:// URL');
  assert.equal(p.bytes, 44 + 4096);
  // 内联后临时目录应该被清掉（之前每次朗读都在 %TEMP% 留一个目录）
  assert.equal(fs.existsSync(dir), false, '内联后临时 WAV 目录应被清理');
});

test('空壳 WAV（只有 44 字节头）→ 被拦下并说明"未生成有效音频"', () => {
  const vm = makeVm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tts-empty-'));
  const wav = path.join(dir, 'tts.wav');
  fs.writeFileSync(wav, wavHeader(0));

  assert.throws(
    () => vm._audioPayload(wav, { speakerId: '' }),
    /未生成有效音频/,
    '空壳音频必须被拦下，否则播放端只会报 "no supported source"'
  );
});

test('WAV 文件不存在 → 明确报错而不是静默', () => {
  const vm = makeVm();
  const missing = path.join(os.tmpdir(), 'hermes-tts-nope-' + Date.now(), 'tts.wav');
  assert.throws(() => vm._audioPayload(missing, {}), /不存在/);
});

test('超大音频（>4MB）→ 不内联，退回文件 URL 且保留文件', () => {
  const vm = makeVm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tts-big-'));
  const wav = path.join(dir, 'tts.wav');
  const fd = fs.openSync(wav, 'w');
  fs.writeSync(fd, wavHeader(0));
  fs.ftruncateSync(fd, 5 * 1024 * 1024);
  fs.closeSync(fd);

  const p = vm._audioPayload(wav, {});
  assert.equal(p.dataUrl, '', '超过内联上限就不该内联');
  assert.ok(p.url && p.url.startsWith('file:///'), '超大文件应退回文件 URL：' + p.url);
  assert.equal(fs.existsSync(wav), true, '退回文件 URL 时文件必须保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('speak() 遇到空壳音频返回 ok:false 且原因可读（不得假装成功）', async () => {
  const vm = makeVm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tts-speak-'));
  const wav = path.join(dir, 'tts.wav');
  fs.writeFileSync(wav, wavHeader(0));
  // 只替换渲染步骤，其余（校验 → 报错翻译）走真实代码
  vm._renderTts = async () => wav;
  vm.getVoices = async () => [];   // 模拟"系统没装语音"

  const r = await vm.speak('你好');
  assert.equal(r.ok, false, '空壳音频不能算成功');
  assert.ok(/未生成有效音频/.test(r.reason), '原因应说明音频无效：' + r.reason);
  assert.ok(/语音/.test(r.reason), '原因应给出可操作指引：' + r.reason);
  fs.rmSync(dir, { recursive: true, force: true });
});
