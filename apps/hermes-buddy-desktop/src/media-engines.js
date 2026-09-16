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
  const { findEngine, findWhisperModel } = require('./media-preprocess');
  const ffmpeg = findEngine('ffmpeg', appDir);
  const whisper = findEngine('whisper', appDir);
  const model = findWhisperModel(appDir);
  return {
    dir: appDir ? path.join(appDir, 'media') : '',
    ffmpeg: { ok: !!ffmpeg, path: ffmpeg || '' },
    whisper: { ok: !!whisper, path: whisper || '' },
    model: { ok: !!model, path: model || '', name: model ? path.basename(model) : '' },
  };
}

/** 匿名调 GitHub API 拿 release 列表，失败返回 null（调用方回落兜底 URL）。 */
function fetchJson(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      timeout: 15000,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'hermes-buddy', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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

function downloadTo(url, destFile, onTick) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('非法下载地址')); }
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      timeout: DOWNLOAD_TIMEOUT,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'hermes-buddy' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadTo(next, destFile, onTick).then(resolve, reject);
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
async function downloadFirstAvailable(urls, destFile, onTick) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await downloadTo(url, destFile, onTick);
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
async function install({ appDir, components = ['whisper', 'model', 'ffmpeg'], model = 'base', onProgress } = {}) {
  if (!appDir) throw new Error('缺少 userData 目录，无法安装');
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
      report({ component: 'model', phase: 'download', message: `正在下载语音模型 ${key}（约 ${mb(MODELS[key].bytes)}）…` });
      const urls = MODEL_BASES.map((b) => `${b}/${file}`);
      await downloadFirstAvailable(urls, dest, ({ received, total }) => {
        report({
          component: 'model', phase: 'download',
          received, total: total || MODELS[key].bytes,
          message: `正在下载模型 ${key}… ${mb(received)} / ${mb(total || MODELS[key].bytes)}`,
        });
      });
      installed.push(file);
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
};
