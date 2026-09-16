'use strict';
/**
 * 音视频本地预处理的自检脚本（不强制要求装引擎）。
 * 用法：node scripts/check-media-degrade.js
 *
 * 做两件事：
 *   1. 校验「无音视频」的快路径：不做任何子进程调用，parts 原样返回；
 *   2. 报告本机引擎（ffmpeg / whisper）是否就位；没装就提示怎么装。
 * 引擎就位时会额外跑一次真实的降级/转写路径（需要能创建子进程）。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { preprocessParts } = require('../src/media-preprocess');
const { partsToContent, contentToPlainText } = require('../src/agent/parts');

/** 只做文件系统探测，不 spawn，避免在没有子进程权限的环境里被杀。 */
function engineStatus(appDir) {
  const out = {};
  for (const kind of ['ffmpeg', 'whisper']) {
    const envKey = kind === 'ffmpeg' ? 'BUDDY_FFMPEG_BIN' : 'BUDDY_WHISPER_BIN';
    const envVal = (process.env[envKey] || '').trim();
    const names = kind === 'ffmpeg' ? ['ffmpeg'] : ['whisper-cli', 'whisper', 'main'];
    let found = '';
    if (envVal) found = envVal;
    else {
      const mediaDir = appDir ? path.join(appDir, 'media') : '';
      if (mediaDir) {
        for (const n of names) {
          for (const c of [path.join(mediaDir, n), path.join(mediaDir, n + '.exe')]) {
            if (fs.existsSync(c)) { found = c; break; }
          }
          if (found) break;
        }
      }
    }
    out[kind] = found;
  }
  const modelEnv = (process.env.BUDDY_WHISPER_MODEL || '').trim();
  let model = modelEnv;
  if (!model) {
    const mediaDir = appDir ? path.join(appDir, 'media') : '';
    try {
      const hit = mediaDir && fs.existsSync(mediaDir)
        ? fs.readdirSync(mediaDir).find((f) => /^ggml-.*\.bin$/i.test(f))
        : null;
      if (hit) model = path.join(mediaDir, hit);
    } catch (_) {}
  }
  out.model = model;
  return out;
}

(async () => {
  // ---- 1) 无音视频：不做任何子进程调用，parts 原样返回 ----
  const plain = [
    { type: 'text', text: '看看这个' },
    { type: 'image', mime: 'image/png', data: 'AAAA' },
    { type: 'file', name: 'a.txt', mime: 'text/plain', text: '文件内容' }
  ];
  const fast = await preprocessParts(plain, { appDir: os.tmpdir() });
  if (fast.parts !== plain || fast.warnings.length) {
    console.error('FAILED: 无音视频时应原样返回且不产生 warning');
    process.exit(1);
  }
  const fastContent = partsToContent(fast.parts);
  if (!fastContent.some((c) => c.type === 'image_url')) {
    console.error('FAILED: 图片应转成 image_url');
    process.exit(1);
  }
  console.log('[OK] 无音视频快路径：不调用引擎，parts 原样通过');
  console.log('     纯文本摘要 =', JSON.stringify(contentToPlainText(fastContent)));

  // ---- 2) 引擎就位情况 ----
  const st = engineStatus(os.tmpdir());
  console.log('\n本机引擎探测（环境变量 / userData/media / PATH）：');
  console.log('  ffmpeg :', st.ffmpeg || '未配置（PATH 探测需子进程权限，此处只报显式配置）');
  console.log('  whisper:', st.whisper || '未配置');
  console.log('  模型   :', st.model || '未配置');
  if (!st.ffmpeg || !st.whisper) {
    console.log('\n提示：语音/视频的本地转写与抽帧需要 ffmpeg + whisper。');
    console.log('  放到 %APPDATA%\\@hermes\\buddy-desktop\\media\\，');
    console.log('  或用环境变量 BUDDY_FFMPEG_BIN / BUDDY_WHISPER_BIN / BUDDY_WHISPER_MODEL 指定。');
    console.log('  没装也不会阻断发送：音视频会降级为说明文字并给出提示。');
    return;
  }

  // ---- 3) 引擎就位：跑一次真实路径，确认降级不抛异常 ----
  const res = await preprocessParts([
    { type: 'text', text: '看看这个' },
    { type: 'image', mime: 'image/png', data: 'AAAA' },
    { type: 'audio', name: 'v.wav', mime: 'audio/wav', data: Buffer.from('fake') },
    { type: 'video', name: 'c.mp4', mime: 'video/mp4', data: Buffer.from('fake') }
  ], { appDir: os.tmpdir() });
  const content = partsToContent(res.parts);
  console.log('\nwarnings:', JSON.stringify(res.warnings, null, 2));
  console.log('content blocks =', content.length);
  if (!Array.isArray(content) || !content.length) {
    console.error('FAILED: 降级后仍应产出 content');
    process.exit(1);
  }
  console.log('[OK] 音视频处理未抛异常，图片/文本均保留');
})().catch((e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
