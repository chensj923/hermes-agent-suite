'use strict';

/**
 * v4.12.18 回归测试：语音模型完整性。
 * 事故：ggml-base.bin 下载被截断，只剩 8.8 MB（应 ~148 MB），但魔数仍是 ggml，
 * findWhisperModel 直接当"已安装"。结果 whisper 启动才炸：
 *   "ERROR not all tensors loaded from model file - expected 245, got 3"
 * 用户看到这行完全不知道要干嘛。
 *
 * 守住三点：
 *  1) 截断/错误页的文件不能被判为可用；
 *  2) 引擎状态要能报出"文件在但已损坏"，让 UI 提示重新下载；
 *  3) whisper 那句天书报错要翻译成"去重新下载模型"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pre = require('../src/media-preprocess');
const { VoiceManager } = require('../src/voice/voice-manager');

const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67]); // "ggml"
const MB = 1024 * 1024;

/** 造一个带指定魔数、指定体积的文件（truncate 是稀疏的，不会真写 60MB）。 */
function makeModel(magic, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mdl-'));
  const file = path.join(dir, 'ggml-base.bin');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, magic);
  fs.closeSync(fd);
  fs.truncateSync(file, bytes);
  return { dir, file };
}

test('verifyWhisperModel：截断的模型（魔数对但只有 9MB）判为不可用', () => {
  const { dir, file } = makeModel(GGML_MAGIC, Math.round(8.8 * MB));
  const r = pre.verifyWhisperModel(file, 148 * MB);
  assert.equal(r.ok, false, '9MB 的 base 模型必须判坏，否则 whisper 启动才炸');
  assert.equal(r.reason, 'truncated');
  assert.ok(/8\.8 MB/.test(r.detail), '应带上实际体积便于提示：' + r.detail);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyWhisperModel：HTML 错误页（体积够但魔数不对）判为不可用', () => {
  const { dir, file } = makeModel(Buffer.from('<htm', 'ascii'), 60 * MB);
  const r = pre.verifyWhisperModel(file, 148 * MB);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-magic');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyWhisperModel：完整的 ggml 模型判为可用', () => {
  const { dir, file } = makeModel(GGML_MAGIC, 148 * MB);
  const r = pre.verifyWhisperModel(file, 148 * MB);
  assert.equal(r.ok, true, '完整模型不该被误杀：' + JSON.stringify(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyWhisperModel：GGUF 格式同样接受', () => {
  const { dir, file } = makeModel(Buffer.from('GGUF', 'ascii'), 200 * MB);
  assert.equal(pre.verifyWhisperModel(file, 0).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyWhisperModel：文件不存在 → missing', () => {
  const r = pre.verifyWhisperModel(path.join(os.tmpdir(), 'nope-ggml.bin'), 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

test('getStatus：模型文件在但被截断 → damaged=true（UI 才能提示重新下载）', () => {
  const { getStatus } = require('../src/media-engines');
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-appdir-'));
  const mediaDir = path.join(appDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const { file } = makeModel(GGML_MAGIC, Math.round(8.8 * MB));
  fs.copyFileSync(file, path.join(mediaDir, 'ggml-base.bin'));

  const st = getStatus(appDir);
  assert.equal(st.model.path !== '', true, '应找到模型文件');
  assert.equal(st.model.damaged, true, '截断文件必须标记 damaged');
  assert.equal(st.model.ok, false, '不能算已安装');
  assert.ok(st.model.bytes > 0 && st.model.bytes < 20 * MB);
  assert.equal(st.model.expectedBytes, 148 * MB);

  fs.rmSync(appDir, { recursive: true, force: true });
});

test('模型损坏时 transcribe 报"重新下载模型"而不是引擎未安装', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-badmdl-'));
  const mediaDir = path.join(appDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const { file } = makeModel(GGML_MAGIC, Math.round(8.8 * MB));
  fs.copyFileSync(file, path.join(mediaDir, 'ggml-base.bin'));
  // 造出"引擎已装"的假象（findEngine 只看文件是否存在），这样才会走到模型校验这一关
  fs.writeFileSync(path.join(mediaDir, 'whisper-cli.exe'), '');
  fs.writeFileSync(path.join(mediaDir, 'ffmpeg.exe'), '');

  const vm = new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir,
    getPet: () => null,
    getMainWindow: () => null,
    getPredict: () => null,
  });
  assert.equal(vm.engineReady(), false, '模型坏了就不该算引擎就绪');

  await assert.rejects(
    () => vm.transcribe(Buffer.from('x').toString('base64'), 'audio/webm'),
    (err) => {
      assert.ok(/重新下载模型/.test(err.message), '应明确指向重新下载：' + err.message);
      return true;
    }
  );
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('whisper 的 "not all tensors loaded" 被翻译成人话', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tr-'));
  const mediaDir = path.join(appDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const { file } = makeModel(GGML_MAGIC, Math.round(8.8 * MB));
  fs.copyFileSync(file, path.join(mediaDir, 'ggml-base.bin'));

  const vm = new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir,
    getPet: () => null,
    getMainWindow: () => null,
    getPredict: () => null,
  });
  const raw = new Error([
    'Command failed: whisper-cli.exe -m ggml-base.bin',
    'whisper_model_load: ERROR not all tensors loaded from model file - expected 245, got 3',
    'error: failed to initialize whisper context',
  ].join('\n'));
  const friendly = vm._friendlySttError(raw);
  assert.ok(/重新下载模型/.test(friendly.message), '应指向重新下载：' + friendly.message);
  assert.ok(/8\.8 MB/.test(friendly.message), '应带上实际体积：' + friendly.message);
  assert.ok(friendly.message.length < 200, '不该把整段 whisper 日志甩给用户：' + friendly.message.length);
  fs.rmSync(appDir, { recursive: true, force: true });
});
