'use strict';

/**
 * v4.12.17 回归测试。
 * 事故：voice-manager.js 里 `pre.toWav16k(...)` / `pre.runTranscribe(...)` 报
 * 「is not a function」——因为 media-preprocess 只导出了 needsWav/condenseError/
 * cleanTranscript，这两个函数**有定义但没进 module.exports**。
 * 表现是「麦克风采集成功、一停就崩」，用户只看到一行 TypeError。
 *
 * 这里用两道闸门守住：
 *  1) 静态扫描 voice-manager.js 里所有 `pre.xxx` 调用，断言 media-preprocess 确实导出了；
 *  2) 真跑一次 VoiceManager.transcribe，断言缺引擎时报的是业务错误而不是 TypeError。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pre = require('../src/media-preprocess');
const { VoiceManager } = require('../src/voice/voice-manager');

const SRC = path.join(__dirname, '..', 'src');

test('media-preprocess 必须导出语音链路用到的 toWav16k / runTranscribe', () => {
  assert.equal(typeof pre.toWav16k, 'function', 'toWav16k 未导出会导致收音后转写崩溃');
  assert.equal(typeof pre.runTranscribe, 'function', 'runTranscribe 未导出会导致收音后转写崩溃');
});

test('voice-manager.js 里所有 pre.xxx 调用都必须在 media-preprocess 的导出里', () => {
  const src = fs.readFileSync(path.join(SRC, 'voice', 'voice-manager.js'), 'utf8');
  const used = new Set();
  const re = /\bpre\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) used.add(m[1]);
  assert.ok(used.size > 0, '没扫到任何 pre.* 调用，正则或文件路径有问题');
  for (const name of used) {
    assert.equal(
      typeof pre[name], 'function',
      `voice-manager.js 调用了 pre.${name}，但 media-preprocess 没有导出它（v4.12.17 事故同款）`
    );
  }
});

test('buildWhisperArgs：cpp 分支带 -l zh，python 分支带 --language zh', () => {
  const cpp = pre.buildWhisperArgs('cpp', 'a.wav', 'D:/tmp', 'D:/m.bin', 'zh');
  assert.ok(cpp.includes('-m') && cpp.includes('D:/m.bin'), 'cpp 必须给模型: ' + cpp.join(' '));
  assert.ok(cpp.includes('-otxt'), 'cpp 必须 -otxt');
  assert.deepEqual(cpp.slice(-2), ['-l', 'zh'], 'cpp 应在末尾追加 -l zh: ' + cpp.join(' '));

  const py = pre.buildWhisperArgs('python', 'a.wav', 'D:/tmp', 'D:/m.bin', 'zh');
  assert.deepEqual(py.slice(-2), ['--language', 'zh'], 'python 版应追加 --language zh: ' + py.join(' '));

  const noLang = pre.buildWhisperArgs('cpp', 'a.wav', 'D:/tmp', 'D:/m.bin', '');
  assert.ok(!noLang.includes('-l'), '不传语言时不应带 -l: ' + noLang.join(' '));
});

test('缺引擎时 transcribe 报业务错误，而不是 TypeError', async () => {
  const vm = new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-noengine-')),
    getPet: () => null,
    getMainWindow: () => null,
    getPredict: () => null,
  });
  await assert.rejects(
    () => vm.transcribe(Buffer.from('x').toString('base64'), 'audio/webm'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!/is not a function/.test(err.message), '不该再出现 is not a function: ' + err.message);
      assert.ok(/引擎/.test(err.message), '应给出「语音引擎未安装」这类可读提示: ' + err.message);
      return true;
    }
  );
});

test('getSettings 默认带上识别语言 lang=zh', () => {
  const vm = new VoiceManager({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir: '',
    getPet: () => null,
    getMainWindow: () => null,
    getPredict: () => null,
  });
  assert.equal(vm.getSettings().lang, 'zh');
});
