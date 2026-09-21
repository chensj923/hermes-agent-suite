#!/usr/bin/env node
/**
 * 把安装包从「云同步目录」搬到「本地非同步目录」并做完整性校验。
 *
 * 背景（v4.10.27 踩坑）：
 *   仓库在 C:\Users\chens\SynologyDrive\ 下，dist/ 里的产物会被同步客户端
 *   变成 ReparsePoint（云端占位文件）。NSIS 安装器读取这类文件时，未下载的
 *   数据块会返回错误内容 —— 表现为「装完缺 Hermes Buddy.exe / app.asar /
 *   snapshot_blob.bin 等 8 个文件」，而杀软日志里干干净净，很容易误判成被查杀。
 *   判据：7z t <installer> 会报 "Data Error : Hermes Buddy.exe"（107 sub-item errors）。
 *
 * 用法：
 *   node scripts/stage-installer.js                       # 默认搬到 C:\HermesSetup
 *   node scripts/stage-installer.js --out D:\MySetup      # 指定目标目录
 *   node scripts/stage-installer.js --src <installer.exe> # 指定源安装包
 *   node scripts/stage-installer.js --check-only          # 只体检，不复制
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_SRC = path.join(REPO, 'dist', 'hermes-suite-windows-x86_64.exe');
const DEFAULT_OUT_DIR = 'C:\\HermesSetup';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 云同步占位文件在 Node 里表现为符号链接 / 重解析点。 */
function isCloudPlaceholder(p) {
  try {
    const st = fs.lstatSync(p);
    return Boolean(st.isSymbolicLink && st.isSymbolicLink());
  } catch (_) {
    return false;
  }
}

function find7z() {
  const cands = [
    // electron-builder 自带的 7z：能正确校验 26.x 生成的 LZMA2 载荷归档。
    // 优先用它——系统装的 C:\Program Files\7-Zip\7z.exe 版本过旧，对这类归档
    // 会误报 "Data Error"（实际解包内容与魔数均正常），导致 stage 假失败。
    path.join(REPO, '..', '..', 'node_modules', 'electron-winstaller', 'vendor', '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(REPO, '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

/** 用 7z 测试 NSIS 容器内嵌的 app-64.7z 载荷；返回 {ok, errors, detail}。 */
function testPayload(installer) {
  const seven = find7z();
  if (!seven) return { ok: null, errors: -1, detail: '未找到 7z，跳过载荷校验' };
  console.error('[stage] using 7z = ' + seven);
  const tmp = path.join(require('os').tmpdir(), 'hb-stage-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync(seven, ['e', '-o' + tmp, installer, '$PLUGINSDIR\\app-64.7z', '-r', '-y'], {
      stdio: 'ignore',
    });
    const arc = path.join(tmp, 'app-64.7z');
    if (!fs.existsSync(arc)) return { ok: false, errors: -1, detail: '抽不出 app-64.7z' };
    let out = '';
    try {
      out = execFileSync(seven, ['t', arc], { encoding: 'utf8' });
    } catch (e) {
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    }
    const m = out.match(/Sub items Errors:\s*(\d+)/);
    const errors = m ? Number(m[1]) : (/Everything is Ok/.test(out) ? 0 : -1);
    return { ok: errors === 0, errors, detail: out.split(/\r?\n/).slice(-4).join(' ').trim() };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function main() {
  const src = arg('src', DEFAULT_SRC) || DEFAULT_SRC;
  const outDir = arg('out', DEFAULT_OUT_DIR) || DEFAULT_OUT_DIR;
  const checkOnly = process.argv.includes('--check-only');

  if (!fs.existsSync(src)) {
    console.error('[stage] 源安装包不存在: ' + src);
    process.exit(1);
  }

  console.log('[stage] 源: ' + src);
  console.log('[stage]   大小 ' + fs.statSync(src).size + ' B  云端占位: ' + isCloudPlaceholder(src));

  if (checkOnly) {
    const r = testPayload(src);
    console.log('[stage] 载荷校验: ' + (r.ok === true ? 'OK' : '失败(' + r.errors + ') ' + r.detail));
    process.exit(r.ok === true ? 0 : 2);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const dst = path.join(outDir, path.basename(src));
  fs.copyFileSync(src, dst);
  const st = fs.statSync(dst);
  const placeholder = isCloudPlaceholder(dst);
  console.log('[stage] 目标: ' + dst);
  console.log('[stage]   大小 ' + st.size + ' B  云端占位: ' + placeholder);

  if (placeholder) {
    console.error('[stage] 失败：目标仍是云端占位文件，请先"始终保留在此设备"或换个非同步目录');
    process.exit(3);
  }
  if (st.size !== fs.statSync(src).size) {
    console.error('[stage] 失败：复制后大小不一致');
    process.exit(4);
  }

  const r = testPayload(dst);
  if (r.ok === false) {
    console.error('[stage] 失败：载荷 CRC 错误 ' + r.errors + ' 项 —— 安装包本体是坏的，请重新构建');
    console.error('[stage] ' + r.detail);
    process.exit(5);
  }
  console.log('[stage] 载荷校验: ' + (r.ok === true ? 'OK（可安全安装）' : '已跳过'));
  console.log('[stage] DONE -> ' + dst);
}

main();
