'use strict';
// 真机自检：真的下载 whisper + ffmpeg 并解压放置，验证目录结构猜测是否正确。
// 不参与打包，仅用于开发期验证。用法：node scripts/check-engine-install.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const { install, getStatus } = require('../src/media-engines');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-eng-real-'));

(async () => {
  console.log('安装目录：', path.join(appDir, 'media'));
  const res = await install({
    appDir,
    components: ['whisper', 'ffmpeg'],   // 模型就是单个 bin 文件，没必要在这里验证
    onProgress: (p) => console.log('  [进度]', p.component || p.phase, '-', p.message || p.phase),
  });
  console.log('\n已放置：', res.installed);
  const s = res.status;
  console.log('状态：', JSON.stringify({
    whisper: { ok: s.whisper.ok, path: s.whisper.path },
    ffmpeg: { ok: s.ffmpeg.ok, path: s.ffmpeg.path },
    model: { ok: s.model.ok },
  }, null, 2));

  const mediaDir = path.join(appDir, 'media');
  console.log('\nmedia 目录内容：');
  for (const f of fs.readdirSync(mediaDir)) console.log('  -', f);

  // 关键：装完必须能被 media-preprocess 的查找逻辑发现
  const { findEngine } = require('../src/media-preprocess');
  console.log('\nfindEngine(whisper) =', findEngine('whisper', appDir) || '(空)');
  console.log('findEngine(ffmpeg)  =', findEngine('ffmpeg', appDir) || '(空)');

  try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n[完成] 已清理临时目录');
})().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
  process.exit(1);
});
