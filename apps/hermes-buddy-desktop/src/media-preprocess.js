'use strict';

/**
 * 音视频本地预处理（Win 端）。
 *
 * 用户要求「语音和视频最好在 win 端本地处理完」再发给 AI，所以这里做的事情是：
 *   语音 → 本地 Whisper 转写成文字
 *   视频 → 本地 ffmpeg 抽音轨 → Whisper 转写成文字；再抽若干关键帧 PNG
 * 最终只把「文字 + 关键帧图片」作为多模态内容发出去，**原始音视频绝不上传**。
 *
 * 引擎（ffmpeg / whisper）是可选的：
 *   · 找不到 → 降级（视频仍尽量抽关键帧；音频只能附一行说明），并给出 warning
 *   · 绝不让"缺引擎"变成"消息发不出去"
 *
 * 引擎查找顺序：环境变量 → userData/media → PATH
 *   BUDDY_FFMPEG_BIN     ffmpeg 可执行文件
 *   BUDDY_WHISPER_BIN    whisper 可执行文件（whisper-cli / main / whisper）
 *   BUDDY_WHISPER_MODEL  whisper 模型文件（whisper.cpp 的 ggml-*.bin）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_FRAMES = 6;          // 单个视频最多抽几张关键帧
const FRAME_INTERVAL_SEC = 10; // 每隔多少秒抽一帧
const WHISPER_TIMEOUT = 5 * 60 * 1000;
const FFMPEG_TIMEOUT = 3 * 60 * 1000;

/** 把 ArrayBuffer / Uint8Array / base64 字符串统一成 Buffer。 */
function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') {
    // 容忍 data URL：data:audio/wav;base64,xxxx
    const cleaned = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    return Buffer.from(cleaned, 'base64');
  }
  return null;
}

/** 可执行文件是否可用（只判断"能不能启动"，不看退出码）。 */
function isAvailable(bin) {
  if (!bin) return false;
  try {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    if (r.error) return r.error.code !== 'ENOENT';
    return true;
  } catch (_) {
    return false;
  }
}

function findEngine(kind, appDir) {
  const envKey = kind === 'ffmpeg' ? 'BUDDY_FFMPEG_BIN' : 'BUDDY_WHISPER_BIN';
  const names = kind === 'ffmpeg' ? ['ffmpeg'] : ['whisper-cli', 'whisper', 'main'];
  const envVal = (process.env[envKey] || '').trim();
  if (envVal) return envVal;

  // userData/media 下（含 .exe）
  const mediaDir = appDir ? path.join(appDir, 'media') : '';
  if (mediaDir) {
    for (const n of names) {
      for (const candidate of [path.join(mediaDir, n), path.join(mediaDir, n + '.exe')]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  // PATH
  for (const n of names) {
    if (isAvailable(n)) return n;
  }
  return '';
}

/**
 * v4.12.18：模型文件完整性校验。
 * 事故：hf-mirror 下载被截断，ggml-base.bin 只有 8.8 MB（应为 ~148 MB），
 * 魔数仍是 ggml 所以"看起来像个模型"，findWhisperModel 照样当已安装，
 * 直到 whisper 启动时报 "not all tensors loaded - expected 245, got 3"。
 * 下载完必须验：① 体积是否够 ② 文件头是不是 ggml/GGUF（防下到 HTML 错误页）。
 */
const MODEL_MAGIC_GGML = Buffer.from([0x6c, 0x6d, 0x67, 0x67]); // "ggml"（uint32 小端）
const MODEL_MAGIC_GGUF = Buffer.from('GGUF', 'ascii');
/** 比这还小一定是坏的：最小的 whisper tiny 也有 70 MB+。 */
const MODEL_MIN_BYTES = 20 * 1024 * 1024;
/** 已知预期体积时的截断阈值（不同镜像给出的实际体积略有出入，留 10% 余量）。 */
const MODEL_TRUNCATE_RATIO = 0.9;

function verifyWhisperModel(file, expectBytes) {
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch (_) { return { ok: false, bytes: 0, reason: 'missing', detail: '文件不存在' }; }
  const mbOf = (n) => (n / 1048576).toFixed(1) + ' MB';
  if (bytes < MODEL_MIN_BYTES) {
    return { ok: false, bytes, reason: 'truncated', detail: `只有 ${mbOf(bytes)}，远小于正常模型` };
  }
  let magicOk = false;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    magicOk = head.equals(MODEL_MAGIC_GGML) || head.equals(MODEL_MAGIC_GGUF);
  } catch (_) { magicOk = false; }
  if (!magicOk) {
    return { ok: false, bytes, reason: 'bad-magic', detail: '文件头不是 ggml/GGUF（很可能下到了错误页或 HTML）' };
  }
  const exp = Number(expectBytes) || 0;
  if (exp > 0 && bytes < exp * MODEL_TRUNCATE_RATIO) {
    return { ok: false, bytes, reason: 'truncated', detail: `只有 ${mbOf(bytes)}，应约 ${mbOf(exp)}` };
  }
  return { ok: true, bytes, reason: '', detail: '' };
}

/**
 * 找 whisper.cpp 的模型文件（ggml-*.bin）。
 * v4.12.19：目录里可能同时存在多个模型（比如用户装了 small，之前还留着一个
 * 下载截断的 base）——readdir 按字母序第一个是 ggml-base.bin，旧实现无脑取第一个，
 * 结果完整的 small 躺在旁边也被判"损坏"。现在逐个校验，优先返回**完好的**里
 * 体积最大的；全都坏才返回第一个（让 getStatus 继续能报 damaged）。
 */
function findWhisperModel(appDir) {
  const envVal = (process.env.BUDDY_WHISPER_MODEL || '').trim();
  if (envVal) return envVal;
  const mediaDir = appDir ? path.join(appDir, 'media') : '';
  if (mediaDir && fs.existsSync(mediaDir)) {
    try {
      const hits = fs.readdirSync(mediaDir)
        .filter((f) => /^ggml-.*\.bin$/i.test(f))
        .sort();
      if (!hits.length) return '';
      const full = hits.map((f) => path.join(mediaDir, f));
      // 先做不依赖预期体积的基础校验（体积下限 + 魔数），通过的里挑最大的
      const good = full
        .map((p) => ({ p, v: verifyWhisperModel(p, 0) }))
        .filter((x) => x.v.ok)
        .sort((a, b) => b.v.bytes - a.v.bytes);
      if (good.length) return good[0].p;
      return full[0]; // 全坏：仍返回一个路径，让上层报"损坏/重新下载"
    } catch (_) {}
  }
  return '';
}

/** 判断 whisper 二进制的"流派"：whisper.cpp 还是 openai-whisper(python)。 */
function whisperFlavor(bin) {
  const base = path.basename(bin).toLowerCase();
  if (base.startsWith('whisper-cli') || base.startsWith('main')) return 'cpp';
  return 'python';
}

/**
 * whisper.cpp 只认 16bit PCM WAV；webm/opus、mp3、m4a 一律解不开。
 * 所以只要不是 wav，就必须先转成 16k 单声道 WAV 再喂给它。
 */
function needsWav(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.includes('wav') || m.includes('pcm') || n.endsWith('.wav')) return false;
  return true;
}

/** 用 ffmpeg 把任意音频归一到 16k 单声道 WAV。失败抛错，调用方降级。 */
async function toWav16k(ffmpeg, srcFile, wavFile) {
  await execFileAsync(ffmpeg, ['-y', '-i', srcFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wavFile],
    { timeout: FFMPEG_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * 压缩报错信息。
 * execFile 的 message = "Command failed: ...\n<stdout>\n<stderr>"，
 * 头部通常是 whisper 的 load_backend / system_info 噪音，真正原因在**末尾**——
 * 之前只取前 120 字，结果用户只看到"loaded CPU backend"，看不到失败原因。
 */
// whisper 的正常日志行前缀——这些是噪音，挤占报错空间时必须先滤掉
const NOISE_LINE = /^(load_backend|whisper_(init|print|model|ctx|backend|full|state)|system_info|main:|output_txt|Command failed)/i;
// read_audio_data 只有"正在读/正在试解码"这两句是进度，报错行要留着
const NOISE_PROGRESS = /^read_audio_data:\s*(reading|trying)/i;

function condenseError(error) {
  const raw = String((error && error.message) || error || '');
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // 先滤掉正常日志，剩下的尾部才是失败原因；全被滤光就退回最后两行
  const useful = lines.filter((s) => !NOISE_LINE.test(s) && !NOISE_PROGRESS.test(s));
  const picked = (useful.length ? useful : lines).slice(-3);
  const code = error && error.code != null ? `（exit ${error.code}）` : '';
  return (picked.join(' ') + code).slice(0, 300) || '未知错误';
}

/** 清掉 whisper 输出里的非语音标记（[BLANK_AUDIO]、(crickets chirping)、时间戳前缀等）。 */
function cleanTranscript(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let s = line.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim();
    s = s.replace(/^\[\s*[^\]]{0,40}\s*\]$/, '').trim();   // [BLANK_AUDIO] / [Silence]
    s = s.replace(/^\(\s*[^)]{0,60}\s*\)$/, '').trim();    // (crickets chirping)
    if (s) out.push(s);
  }
  return out.join('\n').trim();
}

/**
 * 跑 whisper 转写。
 * @param {string} bin    whisper 可执行文件路径
 * @param {string} audioFile 16k 单声道 WAV
 * @param {string} outDir 输出目录（转写结果 transcript.txt 落这里）
 * @param {string} model  whisper.cpp 的模型路径（python 版忽略）
 * @param {{lang?: string}} [opts] 语言提示，如 'zh'。whisper.cpp 默认是 en，
 *   不指定会把中文转成英文音译，所以语音场景必须传。
 */
/**
 * 纯函数：拼 whisper 的命令行参数（便于单测，避免为测参数去伪造可执行文件）。
 * @param {'cpp'|'python'} flavor
 * @param {string} [lang] 语言提示；留空则不追加语言参数
 */
function buildWhisperArgs(flavor, audioFile, outDir, model, lang) {
  const base = (flavor === 'cpp')
    // whisper.cpp：必须给模型文件，输出 txt 到 outDir
    ? ['-m', model, '-f', audioFile, '-otxt', '-of', path.join(outDir, 'transcript')]
    // openai-whisper(python CLI)：--model 默认 base
    : [audioFile, '--model', 'base', '--output_format', 'txt', '--output_dir', outDir];
  if (!lang) return base;
  return base.concat(flavor === 'cpp' ? ['-l', lang] : ['--language', lang]);
}

async function runTranscribe(bin, audioFile, outDir, model, opts) {
  const lang = opts && opts.lang ? String(opts.lang).trim() : '';
  const flavor = whisperFlavor(bin);
  const baseArgs = buildWhisperArgs(flavor, audioFile, outDir, model, '');
  const withLang = buildWhisperArgs(flavor, audioFile, outDir, model, lang);
  const run = (args) => execFileAsync(bin, args, {
    timeout: WHISPER_TIMEOUT,
    cwd: path.dirname(bin),   // 保证 ggml-*.dll / whisper.dll 能被同目录加载
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  let result;
  try {
    result = await run(withLang);
  } catch (e) {
    // 老版本 whisper / 英文-only 模型可能不认 -l，去掉语言参数重试一次
    if (!lang) throw e;
    try { result = await run(baseArgs); } catch (_) { throw e; }
  }
  const { stdout, stderr } = result;
  // 优先读落盘的 txt；读不到就用 stdout
  const candidates = ['transcript.txt', path.basename(audioFile, path.extname(audioFile)) + '.txt'];
  for (const c of candidates) {
    const p = path.join(outDir, c);
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch (_) {}
  }
  const text = String(stdout || '').trim();
  if (text) return text;
  throw new Error(String(stderr || '').slice(0, 200) || 'Whisper 未产出转写结果');
}

async function extractAudio(ffmpeg, videoFile, wavFile) {
  await execFileAsync(ffmpeg, ['-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavFile],
    { timeout: FFMPEG_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

async function extractFrames(ffmpeg, videoFile, outDir) {
  const pattern = path.join(outDir, 'frame-%03d.png');
  try {
    await execFileAsync(ffmpeg, [
      '-y', '-i', videoFile,
      '-vf', `fps=1/${FRAME_INTERVAL_SEC}`,
      '-frames:v', String(MAX_FRAMES),
      pattern
    ], { timeout: FFMPEG_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (_) {
    // 抽帧失败不致命（有些容器/编码 ffmpeg 解不了），交给调用方降级
  }
  const frames = [];
  try {
    const files = fs.readdirSync(outDir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
    for (const f of files.slice(0, MAX_FRAMES)) {
      const buf = fs.readFileSync(path.join(outDir, f));
      frames.push({ mime: 'image/png', data: buf.toString('base64') });
    }
  } catch (_) {}
  return frames;
}

function extFor(mime, fallback) {
  if (mime && mime.includes('/')) {
    const sub = mime.split('/')[1].split(';')[0].trim();
    if (/^[a-z0-9]{2,5}$/i.test(sub)) return '.' + sub.toLowerCase();
  }
  return fallback;
}

function safeName(name, fallback) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return base || fallback;
}

/**
 * 预处理 parts：把 audio / video 就地替换成本地派生出的 text + image。
 * 其余 part（text/image/file）原样透传。
 * @returns {Promise<{parts: Array, warnings: string[], missing: string[]}>}
 *   missing 是结构化的"缺什么"（whisper / model / ffmpeg），渲染层据此决定要不要给安装按钮。
 */
async function preprocessParts(parts, { appDir, logger } = {}) {
  const warnings = [];
  const missing = [];
  const list = Array.isArray(parts) ? parts : [];
  const hasMedia = list.some((p) => p && (p.type === 'audio' || p.type === 'video'));
  if (!hasMedia) return { parts: list, warnings, missing };

  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  const ffmpeg = findEngine('ffmpeg', appDir);
  const whisper = findEngine('whisper', appDir);
  const model = findWhisperModel(appDir);

  const out = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-media-'));

  /** 记一条"缺引擎"警告，并登记到 missing 供 UI 弹安装按钮。 */
  const noteMissing = (kind, message) => {
    if (missing.indexOf(kind) === -1) missing.push(kind);
    warnings.push(message);
  };

  try {
    for (const part of list) {
      if (!part || (part.type !== 'audio' && part.type !== 'video')) { out.push(part); continue; }

      const isVideo = part.type === 'video';
      const buf = toBuffer(part.data);
      const name = safeName(part.name, isVideo ? 'clip.mp4' : 'voice.wav');
      if (!buf || !buf.length) {
        warnings.push(`${name}：读取附件内容失败，已跳过`);
        continue;
      }

      // 视频需要 ffmpeg 才能抽帧/抽音轨；音频只要有 whisper 就能转写
      if (isVideo && !ffmpeg) {
        noteMissing('ffmpeg', `未检测到 ffmpeg，视频「${name}」无法在本地抽帧/转写，已跳过。`);
        out.push({ type: 'file', name, mime: part.mime, note: `（视频 ${name}：本机缺少 ffmpeg，未能本地转写/抽帧）` });
        continue;
      }
      if (!whisper) {
        noteMissing('whisper', '未检测到 Whisper，语音/视频无法本地转写。可点下方「安装本地转写引擎」一键装上。');
        // 视频即使没有 whisper，也把关键帧抽出来给模型看
        if (isVideo && ffmpeg) {
          const vdir = fs.mkdtempSync(path.join(tmpRoot, 'v-'));
          const vfile = path.join(vdir, 'input' + extFor(part.mime, '.mp4'));
          fs.writeFileSync(vfile, buf);
          const frames = await extractFrames(ffmpeg, vfile, vdir);
          out.push({ type: 'video', name, mime: part.mime, transcript: '', frames });
        } else {
          out.push({ type: 'file', name, mime: part.mime, note: `（音频 ${name}：本机缺少 Whisper，未能本地转写）` });
        }
        continue;
      }
      if (whisperFlavor(whisper) === 'cpp' && !model) {
        noteMissing('model', '未检测到 Whisper 模型文件（ggml-*.bin），无法本地转写。可点下方「安装本地转写引擎」一键装上。');
        out.push({ type: 'file', name, mime: part.mime, note: `（${name}：缺少 Whisper 模型文件，未能本地转写）` });
        continue;
      }

      // 有引擎：落盘 → 抽音轨 → 转写 → （视频）抽关键帧
      const dir = fs.mkdtempSync(path.join(tmpRoot, (isVideo ? 'v-' : 'a-')));
      const srcFile = path.join(dir, 'input' + extFor(part.mime, isVideo ? '.mp4' : '.wav'));
      fs.writeFileSync(srcFile, buf);

      let audioFile = srcFile;
      if (isVideo) {
        audioFile = path.join(dir, 'audio.wav');
        try {
          await extractAudio(ffmpeg, srcFile, audioFile);
        } catch (error) {
          log.warn('media-extract-audio-failed', { error: error.message });
          audioFile = '';   // 有些视频没有音轨
        }
      } else if (needsWav(part.mime, name)) {
        // 非 WAV（webm/mp3/m4a…）：whisper.cpp 解不开，必须先转。
        // 新版录音已在渲染层直接产出 WAV，这里兜的是旧录音和外部导入的音频文件。
        if (!ffmpeg) {
          noteMissing('ffmpeg',
            `「${name}」是 ${part.mime || '压缩音频'}，Whisper 只认 16bit PCM WAV，需要 ffmpeg 先转码。` +
            '可在设置里一键安装 ffmpeg（约 111 MB），或直接重新录一段（新版录音直接产出 WAV，不再依赖 ffmpeg）。');
          out.push({ type: 'file', name, mime: part.mime, note: `（音频 ${name}：格式非 WAV 且本机缺少 ffmpeg，未能本地转写）` });
          continue;
        }
        audioFile = path.join(dir, 'audio.wav');
        try {
          await toWav16k(ffmpeg, srcFile, audioFile);
        } catch (error) {
          log.warn('media-to-wav-failed', { error: error.message });
          warnings.push(`${name} 转码 WAV 失败：${condenseError(error)}`);
          audioFile = '';
        }
      }

      let transcript = '';
      if (audioFile) {
        try {
          transcript = cleanTranscript(await runTranscribe(whisper, audioFile, dir, model));
        } catch (error) {
          log.warn('media-transcribe-failed', { error: error.message });
          const hint = needsWav(part.mime, name) ? '（提示：Whisper 只支持 16bit PCM WAV）' : '';
          warnings.push(`${name} 转写失败：${condenseError(error)}${hint}`);
        }
      }

      if (isVideo) {
        const frames = await extractFrames(ffmpeg, srcFile, dir);
        out.push({ type: 'video', name, mime: part.mime, transcript, frames });
      } else {
        out.push({ type: 'audio', name, mime: part.mime, transcript });
      }
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }

  return { parts: out, warnings, missing };
}

module.exports = {
  preprocessParts, toBuffer, findEngine, findWhisperModel,
  // 下面几个导出是为了能单测"格式判断 / 报错压缩 / 文本清洗"这几条关键逻辑
  needsWav, condenseError, cleanTranscript,
  // v4.12.17：语音(STT)链路要用。之前没导出，voice-manager 调 pre.toWav16k
  // 直接 TypeError「is not a function」，收音成功但转写必崩——必须导出并加测试守住。
  toWav16k, runTranscribe, buildWhisperArgs,
  // v4.12.18：模型完整性校验（防截断/错误页被当成已安装）
  verifyWhisperModel, MODEL_MIN_BYTES, MODEL_TRUNCATE_RATIO,
};
