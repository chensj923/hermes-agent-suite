'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.hermes', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf', '.zip', '.rar', '.7z', '.gz', '.tar', '.exe', '.dll', '.so', '.dylib', '.mp4', '.mp3', '.avi', '.mov', '.wasm', '.class']);
const MAX_FILE_BYTES = 1024 * 1024;      // 单文件超过 1MB 不参与全文搜索
const MAX_SCAN_FILES = 2000;
const MAX_READ_BYTES = 512 * 1024;       // 单次读取上限
const DEFAULT_MAX_RESULTS = 50;

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function detectBinary(buffer) {
  const probe = buffer.subarray(0, 4096);
  return probe.includes(0);
}

/** 把 glob 片段翻译成正则：只支持 * 与 **，够用且不会 catastrophic backtracking。 */
// 先把 '**' 换成控制字符占位，避免和单星号、字面空格混淆，最后再展开成 .*。
const GLOB_DOUBLE_STAR = '\u0000';

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\/?/g, GLOB_DOUBLE_STAR)
    .replace(/\*/g, '[^/\\\\]*')
    .split(GLOB_DOUBLE_STAR).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** 递归收集文件，带硬上限，防止在大仓库里跑飞。 */
function walk(dir, { includeDirs = false, maxFiles = MAX_SCAN_FILES } = {}, acc = []) {
  if (acc.length >= maxFiles) return acc;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    if (acc.length >= maxFiles) return acc;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (includeDirs) acc.push(full);
      walk(full, { includeDirs, maxFiles }, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/** 文件类工具。所有路径先过工作区校验，越界一律拒绝。 */
class FileTools {
  constructor({ workspace, logger }) {
    if (!workspace) throw new Error('缺少 workspace');
    this.workspace = workspace;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
  }

  readFile(input) {
    const target = this.workspace.resolve(input.path);
    const stat = fs.statSync(target);
    if (stat.size > MAX_READ_BYTES) {
      return { ok: false, error: `文件过大（${stat.size} 字节），请用命令行工具分段读取` };
    }
    const buffer = fs.readFileSync(target);
    if (detectBinary(buffer)) {
      return { ok: false, error: `这是二进制文件（${path.basename(target)}），无法按文本读取`, binary: true };
    }
    const text = stripBom(buffer.toString('utf8'));
    const lines = text.split(/\r?\n/);
    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Number(input.limit) > 0 ? Number(input.limit) : lines.length;
    const slice = lines.slice(offset, offset + limit);
    const width = String(offset + slice.length).length;
    return {
      ok: true,
      path: this.workspace.relative(target),
      totalLines: lines.length,
      content: slice.map((line, index) => `${String(offset + index + 1).padStart(width, ' ')} | ${line}`).join('\n'),
      truncated: offset + slice.length < lines.length
    };
  }

  writeFile(input) {
    const target = this.workspace.resolve(input.path);
    const content = String(input.content == null ? '' : input.content);
    const existed = fs.existsSync(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename：写一半崩了也不会留下被截断的原文件。
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: this.workspace.relative(target), bytes: Buffer.byteLength(content, 'utf8'), created: !existed };
  }

  listDir(input) {
    const target = this.workspace.resolve(input.path || '.');
    const depth = Number(input.depth) > 0 ? Math.min(Number(input.depth), 4) : 1;
    const lines = [];
    const walkDir = (dir, level) => {
      if (level > depth) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const entry of entries) {
        if (entry.name === '.hermes') continue;
        const indent = '  '.repeat(level);
        lines.push(`${indent}${entry.isDirectory() ? entry.name + '/' : entry.name}`);
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walkDir(path.join(dir, entry.name), level + 1);
      }
    };
    walkDir(target, 0);
    return { ok: true, path: this.workspace.relative(target), tree: lines.join('\n') || '（空目录）' };
  }

  findFiles(input) {
    const base = this.workspace.resolve(input.path || '.');
    const pattern = String(input.pattern || '*').trim() || '*';
    const matcher = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`);
    const stat = fs.statSync(base);
    const files = stat.isDirectory() ? walk(base, { maxFiles: MAX_SCAN_FILES }) : [base];
    const hits = files
      .filter((file) => matcher.test(this.workspace.relative(file).split(path.sep).join('/')))
      .slice(0, 200)
      .map((file) => this.workspace.relative(file).split(path.sep).join('/'));
    return { ok: true, pattern, count: hits.length, files: hits };
  }

  searchContent(input) {
    const needle = String(input.pattern || '').trim();
    if (!needle) return { ok: false, error: '搜索内容不能为空' };
    let regex;
    try { regex = new RegExp(needle, 'g'); } catch (_) { return { ok: false, error: `无效的正则表达式: ${needle}` }; }
    const base = this.workspace.resolve(input.path || '.');
    const fileMatcher = input.filePattern ? globToRegExp(`**/${input.filePattern}`) : null;
    const maxResults = Number(input.maxResults) > 0 ? Math.min(Number(input.maxResults), 200) : DEFAULT_MAX_RESULTS;

    const stat = fs.statSync(base);
    const files = stat.isDirectory() ? walk(base, { maxFiles: MAX_SCAN_FILES }) : [base];
    const results = [];
    for (const file of files) {
      if (results.length >= maxResults) break;
      const rel = this.workspace.relative(file).split(path.sep).join('/');
      if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
      if (fileMatcher && !fileMatcher.test(rel)) continue;
      let stat2;
      try { stat2 = fs.statSync(file); } catch (_) { continue; }
      if (stat2.size > MAX_FILE_BYTES) continue;
      let text;
      try { text = stripBom(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!regex.test(lines[index])) { regex.lastIndex = 0; continue; }
        regex.lastIndex = 0;
        results.push({ file: rel, line: index + 1, text: lines[index].trim().slice(0, 300) });
        if (results.length >= maxResults) break;
      }
    }
    return { ok: true, pattern: needle, count: results.length, results, truncated: results.length >= maxResults };
  }

  /** 环境快照：让模型知道这台机器能用什么，别瞎调 git/python。 */
  systemInfo() {
    const cpus = os.cpus();
    return {
      ok: true,
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpu: cpus.length ? `${cpus[0].model} × ${cpus.length}` : 'unknown',
      memoryGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
      freeMemoryGB: +(os.freemem() / 1024 ** 3).toFixed(1),
      home: os.homedir(),
      shell: process.platform === 'win32' ? 'powershell' : 'sh',
      workspace: this.workspace.dir,
      locale: Intl.DateTimeFormat().resolvedOptions().locale
    };
  }
}

module.exports = {
  FileTools, globToRegExp, walk, stripBom, detectBinary,
  SKIP_DIRS, BINARY_EXT, MAX_READ_BYTES, DEFAULT_MAX_RESULTS
};
