'use strict';

/**
 * VLM / 媒体引擎安装的回归测试（v4.2.1）。
 *
 * 背景：用户报「安装失败：fetchJson is not a function」。真实根因有三个，
 * 全是"静默失效"类型，靠人眼 review 很难发现，所以在这里全部锁死：
 *   1. media-engines 定义了 fetchJson / withMirrors / downloadTo /
 *      downloadFirstAvailable / extractZip，但没导出 → llama-engine 拿到
 *      undefined，安装第一步就抛 "fetchJson is not a function"。
 *   2. Electron 主进程 https.get 不走系统代理 → 国内直连 api.github.com
 *      必然超时，release 解析永远拿不到结果。
 *   3. llama.cpp 早已不发布 avx2-x64 构建（现为 cpu-x64 / cuda / vulkan），
 *      旧正则永远匹配不到 → 回落写死的 b6630（同样已不存在）→ 下载 404。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const media = require('../src/media-engines');
const llama = require('../src/predict/llama-engine');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-install-'));
}

test('media-engines 导出 VLM 安装所需的全部下载骨架（防 fetchJson is not a function 回归）', () => {
  for (const name of ['fetchJson', 'withMirrors', 'downloadTo', 'downloadFirstAvailable', 'extractZip', 'walk', 'placeFiles']) {
    assert.strictEqual(typeof media[name], 'function', `media-engines 必须导出 ${name}(), 实际是 ${typeof media[name]}`);
  }
});

test('resolveProxy：读环境变量并尊重 NO_PROXY', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
  try {
    process.env.NO_PROXY = '';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    const p = media.resolveProxy('https://api.github.com/x');
    assert.ok(p, '应解析出代理');
    assert.strictEqual(p.host, '127.0.0.1');
    assert.strictEqual(p.port, 7890);

    process.env.NO_PROXY = 'github.com';
    assert.strictEqual(media.resolveProxy('https://api.github.com/x'), null, 'NO_PROXY 命中时应直连');

    process.env.NO_PROXY = '.example.com, localhost';
    assert.ok(media.resolveProxy('https://api.github.com/x'), 'NO_PROXY 未命中时仍走代理');
    assert.strictEqual(media.resolveProxy('http://localhost:8080/x'), null, 'localhost 应直连');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('resolveProxy：无代理环境变量时返回 null（直连）', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy,
  };
  try {
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    assert.strictEqual(media.resolveProxy('https://api.github.com/x'), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test('makeHttpsAgent：无代理时返回 undefined（不强行走代理）', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy,
  };
  try {
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    assert.strictEqual(media.makeHttpsAgent('https://api.github.com/x', 1000), undefined);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test('llama 资源优先级：cpu-x64 排在 avx2 / vulkan 之前', () => {
  const pats = llama.LLAMA_ASSET_PRIORITY;
  const idxOf = (re) => pats.findIndex((p) => p.source === re.source);
  const cpu = idxOf(/^llama-b\d+-bin-win-cpu-x64\.zip$/i);
  const avx2 = idxOf(/^llama-b\d+-bin-win-avx2-x64\.zip$/i);
  const vulkan = idxOf(/^llama-b\d+-bin-win-vulkan-x64\.zip$/i);
  assert.ok(cpu >= 0, '必须支持 cpu-x64（llama.cpp 现行构建命名）');
  assert.ok(cpu < avx2, 'cpu 应优先于 avx2');
  assert.ok(cpu < vulkan, 'cpu 应优先于 vulkan（vulkan 需要 GPU 驱动）');
});

test('resolveLlamaZip：优先返回 cpu-x64 构建，且兜底包含 cpu（防 avx2-only 导致必然 404）', async () => {
  const t0 = Date.now();
  const urls = await llama.resolveLlamaZip();
  // 这个用例走真实网络；拿不到 release 列表时也必须返回兜底数组而不是抛错
  assert.ok(Array.isArray(urls), '应返回候选 URL 数组');
  assert.ok(urls.length > 0, '至少一个候选');
  const hasCpuFallback = llama.LLAMA_ZIP_FALLBACKS.some((u) => /win-cpu-x64\.zip$/i.test(u));
  assert.ok(hasCpuFallback, '兜底列表必须含 cpu-x64 构建（avx2 已不再发布）');
  console.log(`    [live] resolveLlamaZip 得到 ${urls.length} 个候选，首选 ${urls[0]}（${Date.now() - t0}ms）`);
  if (!/github\.com.*\/releases\/download\//i.test(urls[0])) {
    // API 不可用时应是兜底 URL
    assert.ok(llama.LLAMA_ZIP_FALLBACKS.includes(urls[0]), 'API 不可用时首选应是兜底 URL');
  } else {
    assert.ok(/win-(cpu|avx2|openvino|vulkan)-x64\.zip$/i.test(urls[0]), '首选应是 Windows x64 构建');
  }
});

test('findMmproj：认 mmproj-*.gguf（现代 llama.cpp 用 --mmproj 参数，不再有 mmproj.exe）', () => {
  const dir = tmpDir();
  const vlm = path.join(dir, 'vlm');
  fs.mkdirSync(vlm);
  assert.strictEqual(llama.findMmproj(dir), '', '空目录应找不到');
  fs.writeFileSync(path.join(vlm, 'mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf'), 'x');
  const hit = llama.findMmproj(dir);
  assert.ok(hit && /mmproj.*\.gguf$/i.test(hit), '应找到 mmproj gguf，实际：' + hit);
});

test('findVlmModel：不会把 mmproj 误判为主模型', () => {
  const dir = tmpDir();
  const vlm = path.join(dir, 'vlm');
  fs.mkdirSync(vlm);
  fs.writeFileSync(path.join(vlm, 'mmproj-model-f16.gguf'), 'x');
  assert.strictEqual(llama.findVlmModel(dir, 'qwen2.5-vl-3b'), '', '只有 mmproj 时不能判为主模型已装');

  const spec = llama.VLM_MODELS['qwen2.5-vl-3b'];
  fs.writeFileSync(path.join(vlm, spec.gguf), 'y');
  const found = llama.findVlmModel(dir, 'qwen2.5-vl-3b');
  assert.ok(found && found.endsWith(spec.gguf), '应找到主模型：' + found);
});

test('getStatus：主模型与视觉投影分别独立判定', () => {
  const dir = tmpDir();
  const vlm = path.join(dir, 'vlm');
  fs.mkdirSync(vlm);
  fs.writeFileSync(path.join(vlm, llama.VLM_MODELS['qwen2.5-vl-3b'].gguf), 'x');
  const st = llama.getStatus(dir, 'qwen2.5-vl-3b');
  assert.strictEqual(st.model.ok, true, '主模型应判为已装');
  assert.strictEqual(st.mmproj.ok, false, '未下 mmproj 时不能判为已装');
  assert.strictEqual(st.llamaServer.ok, false);
});
