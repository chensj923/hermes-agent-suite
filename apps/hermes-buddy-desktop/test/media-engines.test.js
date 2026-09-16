'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getStatus, install, placeFiles, resolveWhisperZip, MODELS } = require('../src/media-engines');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('getStatus 返回完整结构，缺引擎时 ok 为 false', () => {
  const appDir = tmpDir('hermes-eng-empty-');
  const s = getStatus(appDir);
  assert.equal(typeof s.dir, 'string');
  for (const key of ['whisper', 'model', 'ffmpeg']) {
    assert.equal(typeof s[key].ok, 'boolean', `${key}.ok 应是布尔`);
    assert.equal(typeof s[key].path, 'string', `${key}.path 应是字符串`);
  }
  assert.equal(s.whisper.ok, false, '空目录里不应找到 whisper');
  assert.equal(s.model.ok, false, '空目录里不应找到模型');
});

test('install 缺少 appDir 时应报错而不是静默失败', async () => {
  await assert.rejects(() => install({ appDir: '', components: ['whisper'] }), /userData|目录/);
});

test('placeFiles 只挑 whisper-cli 与 dll，忽略无关 exe', () => {
  const src = tmpDir('hermes-eng-src-');
  const dest = tmpDir('hermes-eng-dest-');
  // 模拟 whisper.cpp 官方 zip 的目录结构：bin/ 下有主程序和一堆工具
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'bin', 'whisper-cli.exe'), 'x');
  fs.writeFileSync(path.join(src, 'bin', 'whisper-server.exe'), 'x');   // 不该被当成主程序
  fs.writeFileSync(path.join(src, 'bin', 'ggml-base.dll'), 'x');        // 必须一起带走
  fs.writeFileSync(path.join(src, 'LICENSE'), 'x');

  const copied = placeFiles(src, dest, {
    exes: [/^whisper-cli\.exe$/i, /^main\.exe$/i, /^whisper\.exe$/i],
    wantDll: true,
    targetName: 'whisper-cli.exe',
  });

  assert.ok(fs.existsSync(path.join(dest, 'whisper-cli.exe')), '应复制 whisper-cli.exe');
  assert.ok(fs.existsSync(path.join(dest, 'ggml-base.dll')), 'dll 必须和 exe 同目录');
  assert.ok(!fs.existsSync(path.join(dest, 'whisper-server.exe')), '无关 exe 不应被复制');
  assert.ok(copied.indexOf('whisper-cli.exe') !== -1);
});

test('placeFiles 取 ffmpeg 时不带 dll', () => {
  const src = tmpDir('hermes-ff-src-');
  const dest = tmpDir('hermes-ff-dest-');
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'bin', 'ffmpeg.exe'), 'x');
  fs.writeFileSync(path.join(src, 'bin', 'ffprobe.exe'), 'x');
  fs.writeFileSync(path.join(src, 'bin', 'some.dll'), 'x');

  placeFiles(src, dest, { exes: [/^ffmpeg\.exe$/i], wantDll: false, targetName: 'ffmpeg.exe' });

  assert.ok(fs.existsSync(path.join(dest, 'ffmpeg.exe')));
  assert.ok(!fs.existsSync(path.join(dest, 'ffprobe.exe')), '不该复制 ffprobe');
  assert.ok(!fs.existsSync(path.join(dest, 'some.dll')), 'ffmpeg essentials 是静态链接，不该带 dll');
});

test('resolveWhisperZip 永远返回一个 zip 地址（API 挂了要回落兜底）', async () => {
  const url = await resolveWhisperZip();
  assert.equal(typeof url, 'string');
  assert.ok(/^https:\/\//.test(url), '应是 https 地址');
  assert.ok(/\.zip$/i.test(url), '应是 zip 包');
});

test('模型档位齐备，且带体积说明', () => {
  for (const key of ['tiny', 'base', 'small']) {
    assert.ok(MODELS[key], `缺少模型档位 ${key}`);
    assert.ok(MODELS[key].bytes > 0);
    assert.equal(typeof MODELS[key].label, 'string');
  }
});
