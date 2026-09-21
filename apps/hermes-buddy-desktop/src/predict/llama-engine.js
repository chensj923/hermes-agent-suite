'use strict';

/**
 * 本地多模态（VLM）引擎的「查找 + 一键安装」。
 *
 * 复用 v3.7.0 media-engines.js 的下载/解压/挑选骨架（downloadFirstAvailable /
 * withMirrors / extractZip / placeFiles），只换引擎名与下载源：
 *   - llama.cpp 二进制：从 ggml-org/llama.cpp release 取 Windows AVX2 构建
 *     （llama-server.exe + mmproj.exe）
 *   - VLM 模型 GGUF + 视觉投影 mmproj：从 HuggingFace（hf-mirror 优先）取
 *
 * 安装位置固定为 <appDir>/vlm，与 whisper 的 <appDir>/media 隔离。
 * 查找约定与 media-preprocess 对齐：环境变量 → <appDir>/vlm → PATH。
 *
 * 注意（待真实环境 spike 验证）：
 *   - llama.cpp release tag 是滚动的 bXXXX，必须动态解析（不能写死）。
 *   - 个别版本 bundle 可能不含 mmproj.exe，需改用含 mmproj 的构建或单独下载。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const {
  downloadFirstAvailable, withMirrors, extractZip, placeFiles, fetchJson, makeHttpsAgent,
  DOWNLOAD_TIMEOUT,
} = require('../media-engines');

const LLAMA_RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8';
/**
 * Windows 资源按「依赖越少越优先」排序。
 * 重要：llama.cpp 早已停止发布 avx2-x64 构建，只剩 cpu / cuda / vulkan 等变体。
 * 旧代码只认 avx2-x64，永远匹配不到，只能回落到写死的 b6630（同样已不存在）→ 必然 404。
 */
const LLAMA_ASSET_PRIORITY = [
  /^llama-b\d+-bin-win-cpu-x64\.zip$/i,      // 无 GPU 依赖，最通用
  /^llama-b\d+-bin-win-avx2-x64\.zip$/i,     // 老构建命名，兼容保留
  /^llama-b\d+-bin-win-openvino-[\d.]+-x64\.zip$/i,
  /^llama-b\d+-bin-win-vulkan-x64\.zip$/i,
];
/** API 不可用时按同样优先级回落的已知构建（tag 会滚动，无法保证永久有效）。 */
const LLAMA_ZIP_FALLBACKS = [
  'https://github.com/ggml-org/llama.cpp/releases/download/b11039/llama-b11039-bin-win-cpu-x64.zip',
  'https://github.com/ggml-org/llama.cpp/releases/download/b6630/llama-b6630-bin-win-avx2-x64.zip',
];
/**
 * 模型下载源（按顺序尝试）。
 * ModelScope 在大陆直连最快且无需梯子，放最前；hf-mirror 次之；HF 直连兜底。
 * 注意 ModelScope 的分支名是 master，HF 是 main —— 由 modelUrls() 分别拼。
 */
const MODEL_SOURCES = [
  { name: 'ModelScope（国内，推荐）', base: 'https://www.modelscope.cn/models', branch: 'master' },
  { name: 'HF 镜像 hf-mirror', base: 'https://hf-mirror.com', branch: 'main' },
  { name: 'HuggingFace 直连', base: 'https://huggingface.co', branch: 'main' },
];

/**
 * v4.8 实测校正（逐条 HEAD 验证过文件大小）：
 *   - 主模型 Q4_K_M = 1.80 GiB
 *   - mmproj 原用 f16 = 1.25 GiB，几乎和主模型一样大，这才是「下载很久」的真因；
 *     改用 Q8_0 = 806 MB，视觉投影量化到 8bit 对识图几乎无感，总量从 3.1GB 降到 2.6GB。
 */
const VLM_MODELS = {
  'qwen2.5-vl-3b': {
    label: 'Qwen2.5-VL-3B-Instruct (Q4_K_M, 1.8GB, 默认推荐)',
    bytes: 1929901056,
    hfRepo: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
    gguf: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
    mmprojBytes: 844757728,
    needsMmproj: true,
  },
  'smolvlm2': {
    label: 'SmolVLM2 2.2B (Q8_0, ~2.3GB)',
    bytes: 2350 * 1024 * 1024,
    hfRepo: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
    gguf: 'SmolVLM2-2.2B-Instruct-Q8_0.gguf',
    mmproj: 'mmproj-SmolVLM2-2.2B-Instruct-f16.gguf',
    needsMmproj: true,
  },
};

/** 某个模型文件的全部候选下载直链（供下载 + 供 UI 展示给用户手动下载）。 */
function modelUrls(repo, file) {
  return MODEL_SOURCES.map((s) => ({
    name: s.name,
    url: `${s.base}/${repo}/resolve/${s.branch}/${file}`,
  }));
}
/** GB 级 GGUF 的空闲超时：huggingface 偶发限速，30s 默认会把大文件误判为超时。 */
const BIG_FILE_TIMEOUT = 5 * 60 * 1000;

/**
 * 支持的本地 VLM 模型。
 *
 * v4.2.1 实测校正：原先写的 hfRepo 全是臆测值，实际请求返回 404 ——
 * 装到 2GB 那一步才失败，用户只会看到"安装失败"却不知道为什么。
 * 现在只保留**已通过 HF API 逐个核对存在**的仓库与文件名，
 * 并统一到 llama.cpp 官方转换仓库 ggml-org/*（自带配套 mmproj）。
 */

function vlmDir(appDir) { return appDir ? path.join(appDir, 'vlm') : ''; }

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

/** 与 media-preprocess.findEngine 同约定的查找。 */
function findLlamaServer(appDir) {
  const envVal = (process.env.BUDDY_LLAMA_SERVER_BIN || '').trim();
  if (envVal) return envVal;
  const dir = vlmDir(appDir);
  if (dir) {
    for (const c of [path.join(dir, 'llama-server.exe'), path.join(dir, 'llama-server')]) {
      if (fs.existsSync(c)) return c;
    }
  }
  try {
    const r = spawnSync('llama-server', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    if (!r.error) return 'llama-server';
  } catch (_) {}
  return '';
}

/**
 * 视觉投影（mmproj）。
 * 现代 llama.cpp 已移除独立的 mmproj.exe，改为 llama-server 的
 * `--mmproj <file>.gguf` 参数，所以要找的是 gguf 文件；只有很老的构建
 * 才有可执行文件，放在后面做兼容。
 */
function findMmproj(appDir, override) {
  // v4.7：用户在设置里指定的本地 mmproj 优先（存在才用，路径失效自动回落）
  if (override && fs.existsSync(override)) return override;
  const dir = vlmDir(appDir);
  if (dir && fs.existsSync(dir)) {
    const hit = fs.readdirSync(dir).find((f) => /^mmproj.*\.gguf$/i.test(f));
    if (hit) return path.join(dir, hit);
  }
  if (dir) {
    for (const c of [path.join(dir, 'mmproj.exe'), path.join(dir, 'mmproj')]) {
      if (fs.existsSync(c)) return c;
    }
  }
  return '';
}

function findVlmModel(appDir, modelKey, override) {
  // v4.7：用户在设置里指定的本地 GGUF 优先（存在才用，路径失效自动回落）
  if (override && fs.existsSync(override)) return override;
  const spec = VLM_MODELS[modelKey];
  const dir = vlmDir(appDir);
  if (!dir || !fs.existsSync(dir)) return '';
  // 排除 mmproj：否则主模型还没下时，会误把视觉投影当成主模型判为"已安装"
  const files = fs.readdirSync(dir)
    .filter((f) => /\.gguf$/i.test(f) && !/^mmproj/i.test(f));
  if (spec) {
    const hit = files.find((f) => f.toLowerCase() === spec.gguf.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  // 退而求其次：任意一个 gguf
  return files.length ? path.join(dir, files[0]) : '';
}

/** 引擎现状。缺什么由 UI 决定要不要提示安装。
 * @param {object} [opts] {modelPath,mmprojPath} 用户指定的本地文件（v4.7）
 */
function getStatus(appDir, modelKey = 'qwen2.5-vl-3b', opts = {}) {
  const server = findLlamaServer(appDir);
  const mmproj = findMmproj(appDir, opts.mmprojPath);
  const model = findVlmModel(appDir, modelKey, opts.modelPath);
  return {
    dir: vlmDir(appDir),
    llamaServer: { ok: !!server, path: server || '' },
    mmproj: { ok: !!mmproj, path: mmproj || '' },
    model: { ok: !!model, path: model || '', key: modelKey, custom: Boolean(opts.modelPath) },
  };
}

/**
 * 动态解析 llama.cpp 的 Windows 构建 zip，返回**候选 URL 列表**（按优先级）。
 * 返回数组而不是单个 URL：构建命名会随上游版本变化，多候选交给
 * downloadFirstAvailable 逐个尝试，避免"解析成功但下载 404"的假成功。
 * @returns {Promise<string[]>}
 */
async function resolveLlamaZip() {
  const releases = await fetchJson(LLAMA_RELEASES_API);
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  if (Array.isArray(releases)) {
    // 外层变体、内层版本：保证"cpu 最新版"排在"vulkan 最新版"之前
    for (const pat of LLAMA_ASSET_PRIORITY) {
      for (const rel of releases) {
        const assets = Array.isArray(rel && rel.assets) ? rel.assets : [];
        const hit = assets.find((a) => pat.test(a.name || ''));
        if (hit && hit.browser_download_url) push(hit.browser_download_url);
      }
    }
  }
  for (const u of LLAMA_ZIP_FALLBACKS) push(u);
  return urls;
}

/** HEAD 探测：返回 HTTP 状态码，不可达返回 0。 */
function probeHead(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(0); }
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'HEAD',
      agent: makeHttpsAgent(url, timeoutMs),
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'hermes-buddy' },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

/** 依次尝试各下载源（ModelScope → hf-mirror → HF）。 */
async function downloadHf(repo, file, dest, onTick) {
  const urls = modelUrls(repo, file).map((s) => s.url);
  // 先探测哪个源真的有这个文件：GB 级下载不该浪费在 404 上，
  // 而且失败时要说清"仓库/文件名不对"，而不是让用户对着超时发呆。
  let primary = null;
  for (const u of urls) {
    const code = await probeHead(u, 20000);
    // 200=直出；3xx=重定向到 CDN（hf-mirror 的常态，downloadTo 会跟随），
    // 两者都说明文件存在，不能只认 200 否则会跳过国内更快的镜像。
    if (code === 200 || (code >= 300 && code < 400)) { primary = u; break; }
  }
  if (!primary) {
    throw new Error(`模型文件不可用：${repo}/${file}（所有镜像均未返回 200，可能仓库或文件名已变更）`);
  }
  const ordered = [primary, ...urls.filter((u) => u !== primary)];
  return downloadFirstAvailable(ordered, dest, ({ received, total }) => {
    if (onTick) onTick({ received, total: total || 0, message: `正在下载 ${file}… ${mb(received)}${total ? ' / ' + mb(total) : ''}` });
  }, BIG_FILE_TIMEOUT);
}

/**
 * 确保引擎齐全：缺 llama-server 则装二进制；缺模型/mmproj 则下载。
 * @param {object} opts
 * @param {string} opts.appDir
 * @param {string} [opts.model='qwen2.5-vl-3b']
 * @param {(p:object)=>void} [opts.onProgress]
 */
async function ensure({ appDir, model = 'qwen2.5-vl-3b', modelPath = '', mmprojPath = '', onProgress } = {}) {
  if (!appDir) throw new Error('缺少 userData 目录，无法安装');
  const spec = VLM_MODELS[model];
  if (!spec) throw new Error('未知 VLM 模型：' + model);
  const dir = vlmDir(appDir);
  fs.mkdirSync(dir, { recursive: true });
  const report = (p) => { if (typeof onProgress === 'function') onProgress(p); };

  // 1) llama.cpp 二进制
  if (!findLlamaServer(appDir)) {
    report({ component: 'llama', phase: 'resolve', message: '正在查找 llama.cpp 最新构建…' });
    const zipUrls = await resolveLlamaZip();
    const zipFile = path.join(dir, '_llama.zip');
    // 每个候选再展开镜像（ghfast 优先、直连兜底）
    const candidates = [];
    for (const u of zipUrls) candidates.push(...withMirrors(u));
    report({ component: 'llama', phase: 'download', message: `正在下载 llama.cpp（约 30 MB，共 ${candidates.length} 个候选源）…` });
    await downloadFirstAvailable(candidates, zipFile, ({ received, total }) => {
      report({ component: 'llama', phase: 'download', received, total, message: `正在下载 llama.cpp… ${mb(received)}${total ? ' / ' + mb(total) : ''}` });
    }, DOWNLOAD_TIMEOUT);
    report({ component: 'llama', phase: 'extract', message: '正在解压 llama.cpp…' });
    const outDir = path.join(dir, '_tmp');
    extractZip(zipFile, outDir);
    // wantDll 必须为 true：llama-server.exe 依赖 ggml-base.dll / ggml-cpu-*.dll，
    // 不同目录 Windows 加载不到，装完也起不来（v4.2.1 修复）。
    const srv = placeFiles(outDir, dir, { exes: [/^llama-server\.exe$/i], wantDll: true, targetName: 'llama-server.exe' });
    if (!srv.length) throw new Error('压缩包里没找到 llama-server.exe');
    if (spec.needsMmproj) {
      // dll 上面已随 llama-server 一起复制，这里不再重复拷
      const mm = placeFiles(outDir, dir, { exes: [/^mmproj\.exe$/i], wantDll: false, targetName: 'mmproj.exe' });
      if (!mm.length) {
        // 现代构建已不含 mmproj.exe，视觉投影走 --mmproj <gguf> 参数，属正常情况
        report({ component: 'llama', phase: 'warn', message: '该构建不含 mmproj.exe（正常），视觉投影将使用 mmproj GGUF' });
      }
    }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipFile); } catch (_) {}
  } else {
    report({ component: 'llama', phase: 'skip', message: 'llama-server 已存在' });
  }

  // 2) 主模型 GGUF（v4.7：已指定本地文件则跳过 2GB 下载）
  if (!findVlmModel(appDir, model, modelPath)) {
    const dest = path.join(dir, spec.gguf);
    report({ component: 'model', phase: 'download', message: `正在下载模型 ${model}（约 ${mb(spec.bytes)}）…` });
    await downloadHf(spec.hfRepo, spec.gguf, dest, (t) => report(Object.assign({ component: 'model' }, t)));
  } else {
    report({ component: 'model', phase: 'skip', message: '模型已存在' });
  }

  // 3) 视觉投影 mmproj
  if (spec.needsMmproj && spec.mmproj && !findMmproj(appDir, mmprojPath)) {
    const dest = path.join(dir, spec.mmproj);
    report({ component: 'mmproj', phase: 'download', message: `正在下载视觉投影 ${spec.mmproj}…` });
    await downloadHf(spec.hfRepo, spec.mmproj, dest, (t) => report(Object.assign({ component: 'mmproj' }, t)));
  }

  report({ phase: 'done', message: 'VLM 引擎就绪' });
  return getStatus(appDir, model, { modelPath, mmprojPath });
}

/**
 * 设置页用：某模型各文件的下载直链（每个文件给出全部候选源）。
 * 用户可以自己用迅雷/浏览器下完，再用「指定本地 GGUF」导入，跳过内置下载器。
 */
function downloadLinks(modelKey = 'qwen2.5-vl-3b') {
  const spec = VLM_MODELS[modelKey];
  if (!spec) return [];
  const files = [{ role: 'model', file: spec.gguf, bytes: spec.bytes }];
  if (spec.needsMmproj && spec.mmproj) {
    files.push({ role: 'mmproj', file: spec.mmproj, bytes: spec.mmprojBytes || 0 });
  }
  return files.map((f) => Object.assign({}, f, { sources: modelUrls(spec.hfRepo, f.file) }));
}

/** 打开 vlm 目录，方便高级用户手动放置引擎/模型。 */
function openDir(appDir) {
  const dir = vlmDir(appDir);
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('explorer', [dir], { windowsHide: true, stdio: 'ignore' });
  return true;
}

module.exports = {
  VLM_MODELS, getStatus, ensure, openDir,
  findLlamaServer, findMmproj, findVlmModel,
  // 导出以便单测"构建资源解析"这条逻辑（上游命名一变就会静默回落 404）
  resolveLlamaZip, LLAMA_ASSET_PRIORITY, LLAMA_ZIP_FALLBACKS,
  // v4.8：给设置页提供"手动下载"直链
  MODEL_SOURCES, modelUrls, downloadLinks,
};
