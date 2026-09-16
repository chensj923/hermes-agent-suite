'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { needsWav, condenseError, cleanTranscript } = require('../src/media-preprocess');

test('needsWav：WAV 不需要转码，压缩音频需要', () => {
  assert.equal(needsWav('audio/wav', 'a.wav'), false);
  assert.equal(needsWav('audio/x-wav', 'a.wav'), false);
  assert.equal(needsWav('', '录音.wav'), false);
  assert.equal(needsWav('audio/webm', '录音-202609161715.webm'), true);
  assert.equal(needsWav('audio/mp4', 'a.m4a'), true);
  assert.equal(needsWav('audio/mpeg', 'a.mp3'), true);
  assert.equal(needsWav('', ''), true, '未知格式按需要转码处理，交给 ffmpeg 兜底');
});

test('condenseError：取 stderr 尾部而不是头部的 load_backend 噪音', () => {
  const err = new Error([
    'Command failed: whisper-cli.exe -m ggml-base.bin -f a.webm',
    'load_backend: loaded CPU backend from C:\\media\\ggml-cpu-alderlake.dll',
    'whisper_init_from_file_with_params_no_state: loading model',
    'error: failed to open audio file',
    'read_audio_data: failed to decode audio',
  ].join('\n'));
  err.code = 1;
  const out = condenseError(err);
  assert.ok(out.includes('failed to decode audio'), '应包含真正的失败原因: ' + out);
  assert.ok(out.includes('failed to open audio file'));
  assert.ok(out.includes('exit 1'));
  assert.ok(!out.includes('load_backend'), '不该被头部噪音占据');
});

test('condenseError：空输入也能给出兜底文案', () => {
  assert.equal(typeof condenseError(null), 'string');
  assert.ok(condenseError(null).length > 0);
});

test('cleanTranscript：剥掉时间戳与非语音标记', () => {
  const raw = [
    '[00:00:00.000 --> 00:00:02.920]   (crickets chirping)',
    '[00:00:02.920 --> 00:00:05.000]   你好，帮我看一下这个需求',
    '[BLANK_AUDIO]',
    '[00:00:05.000 --> 00:00:08.000]   把表格导出成 CSV',
  ].join('\n');
  const out = cleanTranscript(raw);
  assert.ok(!out.includes('crickets'), '环境音标记应被剔除');
  assert.ok(!out.includes('BLANK_AUDIO'));
  assert.ok(!out.includes('00:00'), '时间戳应被剔除');
  assert.ok(out.includes('你好，帮我看一下这个需求'));
  assert.ok(out.includes('把表格导出成 CSV'));
});

test('cleanTranscript：全是环境音时返回空串（由调用方提示"未识别到有效内容"）', () => {
  assert.equal(cleanTranscript('[00:00:00.000 --> 00:00:02.000]   (silence)\n[BLANK_AUDIO]'), '');
});
