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

/** 找 whisper.cpp 的模型文件（ggml-*.bin）。 */
function findWhisperModel(appDir) {
  const envVal = (process.env.BUDDY_WHISPER_MODEL || '').trim();
  if (envVal) return envVal;
  const mediaDir = appDir ? path.join(appDir, 'media') : '';
  if (mediaDir && fs.existsSync(mediaDir)) {
    try {
      const hit = fs.readdirSync(mediaDir).find((f) => /^ggml-.*\.bin$/i.test(f));
      if (hit) return path.join(mediaDir, hit);
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

async function runTranscribe(bin, audioFile, outDir, model) {
  const flavor = whisperFlavor(bin);
  let args;
  if (flavor === 'cpp') {
    // whisper.cpp：必须给模型文件，输出 txt 到 outDir
    args = ['-m', model, '-f', audioFile, '-otxt', '-of', path.join(outDir, 'transcript')];
  } else {
    // openai-whisper(python CLI)：--model 默认 base
    args = [audioFile, '--model', 'base', '--output_format', 'txt', '--output_dir', outDir];
  }
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: WHISPER_TIMEOUT,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
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
      }

      let transcript = '';
      if (audioFile) {
        try {
          transcript = await runTranscribe(whisper, audioFile, dir, model);
        } catch (error) {
          log.warn('media-transcribe-failed', { error: error.message });
          warnings.push(`${name} 转写失败：${String(error.message || '').slice(0, 120)}`);
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

module.exports = { preprocessParts, toBuffer, findEngine, findWhisperModel };
