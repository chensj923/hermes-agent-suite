'use strict';

/**
 * 本地媒体引擎（Whisper / ffmpeg）的状态检测与一键安装。
 *
 * 背景：语音/视频在 Win 端本地转写，需要 whisper.cpp + 模型 + ffmpeg。
 * 让用户自己去下载 zip、解压、配 PATH 太劝退，所以这里提供一键安装：
 *   1. 动态解析 whisper.cpp 最新构建（它的 release tag 是滚动的 b5130 这类，写死会 404）
 *   2. 多镜像顺序尝试（国内 ghfast / hf-mirror 优先，失败回落直连）
 *   3. 下载到 userData/media/_tmp，解压后只挑需要的文件放进 userData/media
 *   4. media-preprocess 的查找顺序（env → userData/media → PATH）会自动发现它们
 *
 * 安装位置固定为 <userData>/media，不走 PATH、不写注册表、不需要管理员权限。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

/** whisper.cpp release 列表（tag 是滚动构建号，必须动态查，不能写死一个版本）。 */
const WHISPER_RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=8';
/** API 挂了/被限流时的兜底：最后一个已知可用的滚动 tag。 */
const WHISPER_ZIP_FALLBACK = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip';
const MODEL_BASES = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
];
const FFMPEG_ZIP_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];
/** GitHub 链接在国内的加速前缀，逐个试。 */
const GITHUB_MIRRORS = [
  (u) => 'https://ghfast.top/' + u,
  (u) => u,
];

const MODELS = {
  tiny: { label: 'tiny（约 78 MB，最快、精度一般）', bytes: 78 * 1024 * 1024 },
  base: { label: 'base（约 148 MB，推荐）', bytes: 148 * 1024 * 1024 },
  small: { label: 'small（约 488 MB，精度更好、更慢）', bytes: 488 * 1024 * 1024 },
};

const DOWNLOAD_TIMEOUT = 30 * 1000;

/** 引擎现状。缺什么由 UI 决定要不要提示安装。 */
function getStatus(appDir) {
  const { findEngine, findWhisperModel, verifyWhisperModel } = require('./media-preprocess');
  const ffmpeg = findEngine('ffmpeg', appDir);
  const whisper = findEngine('whisper', appDir);
  const modelPath = findWhisperModel(appDir);
  // v4.12.18：光"文件存在"不算装好——下载截断的残file会一路装到 whisper 启动才炸。
  const key = modelPath ? (path.basename(modelPath).match(/^ggml-(.*)\.bin$/i) || [])[1] : '';
  const expected = key && MODELS[key] ? MODELS[key].bytes : 0;
  const v = modelPath ? verifyWhisperModel(modelPath, expected) : { ok: false, bytes: 0, reason: 'missing', detail: '' };
  return {
    dir: appDir ? path.join(appDir, 'media') : '',
    ffmpeg: { ok: !!ffmpeg, path: ffmpeg || '' },
    whisper: { ok: !!whisper, path: whisper || '' },
    model: {
      ok: !!modelPath && v.ok,
      path: modelPath || '',
      name: modelPath ? path.basename(modelPath) : '',
      bytes: v.bytes || 0,
      expectedBytes: expected,
      // 文件在但校验不过 → 提示"重新下载"而不是"已安装"
      damaged: !!modelPath && !v.ok,
      reason: v.reason || '',
      detail: v.detail || '',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 代理支持（v4.2.1）
 *
 * Electron 主进程的 https.get 不会自动走系统代理（Chromium 的代理设置
 * 只作用于 net.request / 渲染进程）。国内环境直连 api.github.com 会直接
 * 15s 超时，release 解析永远拿不到结果、只能回落到写死的 tag。
 * 所以这里读环境变量自建 CONNECT 隧道——零第三方依赖，避免打包遗漏。
 * ------------------------------------------------------------------ */

/**
 * 从环境变量解析代理，尊重 NO_PROXY。返回 null 表示直连。
 * @returns {{host:string,port:number,auth:string}|null}
 */
function resolveProxy(targetUrl) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  let host;
  try { host = new URL(targetUrl).hostname; } catch (_) { return null; }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  for (const entry of noProxy.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === '*') return null;
    const e = entry.replace(/^\./, '');
    if (host === e || host.endsWith('.' + e)) return null;
  }
  try {
    const p = new URL(raw);
    if (!p.hostname) return null;
    let auth = '';
    if (p.username) {
      auth = decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password);
    }
    return {
      host: p.hostname,
      port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80),
      auth,
    };
  } catch (_) {
    return null;
  }
}

/** 向代理发 CONNECT，打通到目标的裸 TCP 隧道。 */
function openTunnel(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode));
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.once('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.end();
  });
}

/**
 * 为 https 请求造 agent：有代理则走 CONNECT + TLS，否则返回 undefined（默认直连）。
 * @param {string} targetUrl
 * @param {number} timeoutMs
 */
function makeHttpsAgent(targetUrl, timeoutMs) {
  const proxy = resolveProxy(targetUrl);
  if (!proxy) return undefined;
  const agent = new https.Agent({ keepAlive: false, maxSockets: 2 });
  agent.createConnection = function createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    openTunnel(proxy, host, port, timeoutMs).then((socket) => {
      const secured = tls.connect({
        socket,
        servername: host,
        rejectUnauthorized: false,
      }, () => callback(null, secured));
      secured.once('error', (e) => callback(e));
    }, (e) => callback(e));
  };
  return agent;
}

/** 匿名调 GitHub API 拿 release 列表，失败返回 null（调用方回落兜底 URL）。 */
/**
 * @param {string} url
 * @param {number} [timeoutMs=30000] 单次超时。走代理时首次 TLS 握手实测接近 10s，
 *   15s 会稳定超时导致 release 解析永远拿不到结果（v4.2.1 修复）。
 */
function fetchJson(url, timeoutMs) {
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
  const doFetch = (useProxy) => new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const agent = useProxy ? makeHttpsAgent(url, t) : undefined;
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      timeout: t,
      rejectUnauthorized: false,
      agent,
      headers: {
        'User-Agent': 'hermes-buddy',
        Accept: 'application/vnd.github+json',
        // release 列表 JSON 未压缩可达数百 KB，走代理时容易把连接拖到超时
        'Accept-Encoding': 'gzip, deflate',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (_) {
          return resolve(null);
        }
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  // 代理与直连竞速：代理先发，直连稍后起步做后手。
  // 串行兜底（代理超时 30s 后再试直连）实测要 50s+，用户会以为卡死。
  // 谁先拿到有效结果谁赢；两边都失败才放弃（调用方回落兜底 URL）。
  return new Promise((resolve) => {
    let won = false;
    let remaining = 2;
    const attempt = (useProxy, delay) => setTimeout(() => {
      doFetch(useProxy).then((r) => {
        if (r != null && !won) { won = true; return resolve(r); }
        remaining -= 1;
        if (remaining <= 0 && !won) resolve(null);
      });
    }, delay);
    attempt(true, 0);
    attempt(false, 1200);
  });
}

/**
 * 找出 CPU 版 Windows x64 构建（whisper-bin-x64.zip）。
 * 排除 blas / cublas / vulkan 等带额外运行时依赖的变体——它们更大且不通用。
 */
async function resolveWhisperZip() {
  const releases = await fetchJson(WHISPER_RELEASES_API);
  if (Array.isArray(releases)) {
    for (const rel of releases) {
      const assets = Array.isArray(rel && rel.assets) ? rel.assets : [];
      const hit = assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name || ''));
      if (hit && hit.browser_download_url) return hit.browser_download_url;
    }
  }
  return WHISPER_ZIP_FALLBACK;
}

/** 给 GitHub 直链生成「镜像优先、直连兜底」的候选列表。 */
function withMirrors(url) {
  if (!/^https:\/\/github\.com\//i.test(url)) return [url];
  return GITHUB_MIRRORS.map((f) => f(url));
}

/**
 * @param {string} url
 * @param {string} destFile
 * @param {(p:{received:number,total:number})=>void} [onTick]
 * @param {number} [timeoutMs] 空闲超时（socket 空闲超过这么久才算超时，持续有数据不会触发）。
 *   默认 DOWNLOAD_TIMEOUT；GB 级模型建议传更大值（如 5 分钟）。
 */
function downloadTo(url, destFile, onTick, timeoutMs) {
  const idleTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DOWNLOAD_TIMEOUT;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('非法下载地址')); }
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      timeout: idleTimeout,
      rejectUnauthorized: false,
      agent: makeHttpsAgent(url, idleTimeout),
      headers: { 'User-Agent': 'hermes-buddy' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadTo(next, destFile, onTick, idleTimeout).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      const ws = fs.createWriteStream(destFile);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onTick) onTick({ received, total });
      });
      res.on('error', reject);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve({ received, total })));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
  });
}

/** 依次尝试每个候选源，全失败才抛错（把最后一个错误抛出去）。 */
async function downloadFirstAvailable(urls, destFile, onTick, timeoutMs) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await downloadTo(url, destFile, onTick, timeoutMs);
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(destFile); } catch (_) {}
    }
  }
  throw lastError || new Error('没有可用的下载地址');
}

/**
 * 解压 zip。优先用系统自带的 tar.exe（bsdtar，Win10+ 支持 zip），
 * 失败再回落 PowerShell 的 Expand-Archive。
 */
function extractZip(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const tar = spawnSync('tar', ['-xf', zipFile, '-C', outDir], {
    windowsHide: true, timeout: 5 * 60 * 1000, stdio: 'ignore',
  });
  if (!tar.error && tar.status === 0) return;
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive', '-LiteralPath', zipFile, '-DestinationPath', outDir, '-Force',
  ], { windowsHide: true, timeout: 5 * 60 * 1000, stdio: 'ignore' });
  if (ps.error || ps.status !== 0) {
    throw new Error('解压失败（tar 与 PowerShell Expand-Archive 都没成功）');
  }
}

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * 从解压目录里挑出需要的文件，平铺到 mediaDir。
 * 返回复制过去的文件名列表，方便 UI 展示"装了什么"。
 */
function placeFiles(srcRoot, mediaDir, { exes, wantDll, targetName }) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const copied = [];
  const files = walk(srcRoot);
  for (const f of files) {
    const base = path.basename(f);
    if (exes.some((re) => re.test(base))) {
      const dest = path.join(mediaDir, targetName);
      fs.copyFileSync(f, dest);
      copied.push(targetName);
    } else if (wantDll && /\.dll$/i.test(base)) {
      // whisper 的 dll 必须和 exe 同目录，Windows 才会加载
      const dest = path.join(mediaDir, base);
      fs.copyFileSync(f, dest);
      copied.push(base);
    }
  }
  return copied;
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 安装引擎。
 * @param {object} opts
 * @param {string} opts.appDir    userData 目录（引擎装到 <appDir>/media）
 * @param {string[]} opts.components  'whisper' | 'model' | 'ffmpeg'
 * @param {string} [opts.model]  tiny | base | small
 * @param {(p:object)=>void} [opts.onProgress]
 */
/** 安装互斥锁：同时只允许一个安装任务（用户常在设置页连点两处按钮，
 *  两个 install 并发会互踩共享的 _tmp 目录，出现互相删除对方 zip 的鬼现象）。 */
let installRunning = false;

async function install({ appDir, components = ['whisper', 'model', 'ffmpeg'], model = 'base', onProgress } = {}) {
  if (installRunning) throw new Error('已有安装任务在进行，请等它完成后再试');
  installRunning = true;
  try {
    return await _installInner({ appDir, components, model, onProgress });
  } finally {
    installRunning = false;
  }
}

async function _installInner({ appDir, components = ['whisper', 'model', 'ffmpeg'], model = 'base', onProgress } = {}) {
  if (!appDir) throw new Error('缺少 userData 目录，无法安装');
  const { verifyWhisperModel } = require('./media-preprocess');
  const mediaDir = path.join(appDir, 'media');
  const tmpDir = path.join(mediaDir, '_tmp');
  fs.mkdirSync(mediaDir, { recursive: true });
  removeDir(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });

  const report = (p) => { if (typeof onProgress === 'function') onProgress(p); };
  const want = (c) => components.indexOf(c) !== -1;
  const installed = [];

  try {
    if (want('whisper')) {
      report({ component: 'whisper', phase: 'resolve', message: '正在查找最新 Whisper 构建…' });
      const zipUrl = await resolveWhisperZip();
      const zipFile = path.join(tmpDir, 'whisper.zip');
      const outDir = path.join(tmpDir, 'whisper');
      report({ component: 'whisper', phase: 'download', message: '正在下载 Whisper（约 8 MB）…' });
      await downloadFirstAvailable(withMirrors(zipUrl), zipFile, ({ received, total }) => {
        report({
          component: 'whisper', phase: 'download',
          received, total,
          message: `正在下载 Whisper… ${mb(received)}${total ? ' / ' + mb(total) : ''}`,
        });
      });
      report({ component: 'whisper', phase: 'extract', message: '正在解压 Whisper…' });
      extractZip(zipFile, outDir);
      const copied = placeFiles(outDir, mediaDir, {
        exes: [/^whisper-cli\.exe$/i, /^main\.exe$/i, /^whisper\.exe$/i],
        wantDll: true,
        targetName: 'whisper-cli.exe',
      });
      if (!copied.length) throw new Error('压缩包里没找到 whisper-cli.exe');
      installed.push('whisper-cli.exe');
    }

    if (want('model')) {
      const key = MODELS[model] ? model : 'base';
      const file = `ggml-${key}.bin`;
      const dest = path.join(mediaDir, file);
      const expectBytes = MODELS[key].bytes;
      // v4.12.18：先清掉已存在的坏文件（截断/错误页），否则会被误判成"已安装"而跳过。
      if (fs.existsSync(dest)) {
        const before = verifyWhisperModel(dest, expectBytes);
        if (!before.ok) {
          report({ component: 'model', phase: 'repair', message: `已存在的模型不完整（${mb(before.bytes)}），清除后重新下载…` });
          try { fs.unlinkSync(dest); } catch (_) {}
        } else {
          report({ component: 'model', phase: 'skip', message: `模型 ${key} 已存在且完整（${mb(before.bytes)}），跳过下载` });
          installed.push(file);
        }
      }
      if (!fs.existsSync(dest)) {
        report({ component: 'model', phase: 'download', message: `正在下载语音模型 ${key}（约 ${mb(expectBytes)}）…` });
        const urls = MODEL_BASES.map((b) => `${b}/${file}`);
        // 中途断流时 downloadTo 不报错、只留一个残缺文件，所以下完校验不过就重下一次
        let after = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          await downloadFirstAvailable(urls, dest, ({ received, total }) => {
            report({
              component: 'model', phase: 'download',
              received, total: total || expectBytes,
              message: `正在下载模型 ${key}… ${mb(received)} / ${mb(total || expectBytes)}${attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : ''}`,
            });
          });
          after = verifyWhisperModel(dest, expectBytes);
          if (after.ok) break;
          try { fs.unlinkSync(dest); } catch (_) {}
          if (attempt < 2) report({ component: 'model', phase: 'retry', message: `模型不完整（${mb(after.bytes)}），重试下载…` });
        }
        if (!after.ok) {
          try { fs.unlinkSync(dest); } catch (_) {}
          throw new Error(`模型下载不完整（${mb(after.bytes)} / 应约 ${mb(expectBytes)}）${after.detail ? '：' + after.detail : ''}。请重试，或换用镜像源。`);
        }
        report({ component: 'model', phase: 'verify', message: `模型校验通过（${mb(after.bytes)}）` });
        installed.push(file);
        // v4.12.19：顺手清掉其他**损坏**的 ggml-*.bin。用户目录里常同时躺着
        // 之前下载截断的坏模型（如 76MB 的 base），findWhisperModel 挑完好的
        // 已经不会被它骗了，但留着只会让状态页反复报"模型损坏"，徒增困惑。
        try {
          for (const f of fs.readdirSync(mediaDir)) {
            if (!/^ggml-.*\.bin$/i.test(f) || f === file) continue;
            const other = path.join(mediaDir, f);
            const otherKey = (f.match(/^ggml-(.*)\.bin$/i) || [])[1] || '';
            const otherExp = MODELS[otherKey] ? MODELS[otherKey].bytes : 0;
            const v2 = verifyWhisperModel(other, otherExp);
            if (!v2.ok) {
              report({ component: 'model', phase: 'cleanup', message: `清理损坏的旧模型 ${f}（${mb(v2.bytes)}）` });
              try { fs.unlinkSync(other); } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }

    if (want('ffmpeg')) {
      const zipFile = path.join(tmpDir, 'ffmpeg.zip');
      const outDir = path.join(tmpDir, 'ffmpeg');
      report({ component: 'ffmpeg', phase: 'download', message: '正在下载 ffmpeg（约 111 MB）…' });
      await downloadFirstAvailable(FFMPEG_ZIP_URLS, zipFile, ({ received, total }) => {
        report({
          component: 'ffmpeg', phase: 'download',
          received, total,
          message: `正在下载 ffmpeg… ${mb(received)}${total ? ' / ' + mb(total) : ''}`,
        });
      });
      report({ component: 'ffmpeg', phase: 'extract', message: '正在解压 ffmpeg…' });
      extractZip(zipFile, outDir);
      const copied = placeFiles(outDir, mediaDir, {
        exes: [/^ffmpeg\.exe$/i],
        wantDll: false,          // gyan essentials 是静态链接，不带 dll
        targetName: 'ffmpeg.exe',
      });
      if (!copied.length) throw new Error('压缩包里没找到 ffmpeg.exe');
      installed.push('ffmpeg.exe');
    }
  } finally {
    removeDir(tmpDir);
  }

  report({ phase: 'done', message: '安装完成' });
  return { installed, status: getStatus(appDir) };
}

/** 打开 media 目录，方便用户自己放引擎/模型。 */
function openDir(appDir) {
  const dir = appDir ? path.join(appDir, 'media') : '';
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('explorer', [dir], { windowsHide: true, stdio: 'ignore' });
  return true;
}

module.exports = {
  getStatus, install, openDir, MODELS, resolveWhisperZip,
  // placeFiles 导出是为了能单测"从压缩包里挑出哪些文件"这条关键逻辑
  placeFiles,
  // v4.2.1：以下为 predict/llama-engine.js（VLM 一键安装）复用的下载骨架。
  // 之前漏导出导致 llama-engine 拿到 undefined，安装第一步就抛
  // "fetchJson is not a function"。导出后再补锁死回归测试。
  fetchJson, withMirrors, downloadTo, downloadFirstAvailable, extractZip, walk,
  // 导出以便单测"代理解析"这条在国内网络下决定成败的逻辑
  resolveProxy, makeHttpsAgent,
  // v4.10.28：llama-engine.js 复用此常量，避免"DOWNLOAD_TIMEOUT is not defined"
  DOWNLOAD_TIMEOUT,
};
