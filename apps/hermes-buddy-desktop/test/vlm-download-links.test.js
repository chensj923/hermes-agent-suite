'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  VLM_MODELS, MODEL_SOURCES, modelUrls, downloadLinks,
} = require('../src/predict/llama-engine');

// 逐条实测过（HEAD 拿 content-range）的真实字节数，变了说明上游换文件了
const Q4_K_M_BYTES = 1929901056;
const MMPROJ_Q8_BYTES = 844757728;

test('默认模型是 qwen2.5-vl-3b 且主模型字节数与实测一致', () => {
  const spec = VLM_MODELS['qwen2.5-vl-3b'];
  assert.ok(spec, '缺少 qwen2.5-vl-3b 配置');
  assert.strictEqual(spec.gguf, 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf');
  assert.strictEqual(spec.bytes, Q4_K_M_BYTES);
});

test('v4.8：mmproj 用 Q8_0（806MB）而不是 f16（1.27GB）—— 省掉近一半下载量', () => {
  const spec = VLM_MODELS['qwen2.5-vl-3b'];
  assert.strictEqual(spec.mmproj, 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf');
  assert.strictEqual(spec.mmprojBytes, MMPROJ_Q8_BYTES);
  //  regression: 别再退回 f16
  assert.ok(!/f16/.test(spec.mmproj), 'mmproj 不该退回 f16（会多下 470MB）');
  assert.ok(spec.mmprojBytes < spec.bytes, 'mmproj 应明显小于主模型');
});

test('下载源：ModelScope 排第一（大陆优先），且三源齐全', () => {
  assert.ok(MODEL_SOURCES.length >= 3);
  assert.match(MODEL_SOURCES[0].base, /modelscope\.cn/);
  assert.strictEqual(MODEL_SOURCES[0].branch, 'master', 'ModelScope 分支是 master');
  for (const s of MODEL_SOURCES.slice(1)) assert.strictEqual(s.branch, 'main');
});

test('modelUrls：按源的分支名拼接，ModelScope 用 master、HF 用 main', () => {
  const urls = modelUrls('ggml-org/Qwen2.5-VL-3B-Instruct-GGUF', 'a.gguf');
  assert.strictEqual(urls.length, MODEL_SOURCES.length);
  assert.strictEqual(
    urls[0].url,
    'https://www.modelscope.cn/models/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/master/a.gguf'
  );
  assert.ok(urls[1].url.includes('hf-mirror.com') && urls[1].url.includes('/resolve/main/'));
  assert.ok(urls[2].url.includes('huggingface.co'));
});

test('downloadLinks：给设置页返回主模型 + mmproj，各自带全部候选源', () => {
  const links = downloadLinks('qwen2.5-vl-3b');
  assert.strictEqual(links.length, 2, '主模型 + 视觉投影两个文件');
  const [m, p] = links;
  assert.strictEqual(m.role, 'model');
  assert.strictEqual(m.file, 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf');
  assert.strictEqual(m.bytes, Q4_K_M_BYTES);
  assert.strictEqual(p.role, 'mmproj');
  assert.strictEqual(p.bytes, MMPROJ_Q8_BYTES);
  for (const f of links) {
    assert.ok(f.sources.length >= 3);
    for (const s of f.sources) assert.match(s.url, /^https:\/\//);
  }
});

test('downloadLinks：未知 key 返回空数组而不是抛错', () => {
  assert.deepStrictEqual(downloadLinks('nope'), []);
});

test('每个 VLM 模型的仓库/文件字段完整（避免上游改名后静默 404）', () => {
  for (const [key, spec] of Object.entries(VLM_MODELS)) {
    assert.ok(spec.hfRepo && /^.+\/.+$/.test(spec.hfRepo), key + ' 仓库名不合法');
    assert.ok(/\.gguf$/.test(spec.gguf), key + ' 主模型不是 gguf');
    if (spec.needsMmproj) assert.ok(/^mmproj.*\.gguf$/.test(spec.mmproj), key + ' mmproj 名不合法');
  }
});
