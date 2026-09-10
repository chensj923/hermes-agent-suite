'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 工作区内 Hermes 自己的目录。与普通项目文件分开，避免 agent 把自己的记忆
// 当成用户代码去"整理"。
const HERMES_DIR = '.hermes';
const MEMORY_DIR = 'memory';
const SKILLS_DIR = 'skills';
const AGENTS_FILE = 'AGENTS.md';

const DEFAULT_AGENTS_MD = [
  '# Hermes 工作区',
  '',
  '> 本文件由 Hermes Buddy 生成。Hermes 在此目录工作时会自动读取它。',
  '> 你可以直接编辑本文件，补充项目背景、约定和禁止事项。',
  '',
  '## 约定',
  '',
  '- 所有相对路径都以本目录为基准。',
  '- 修改文件前先读取确认，不要凭空覆盖。',
  '- 不确定的破坏性操作先向用户确认。',
  ''
].join('\n');

class WorkspaceError extends Error {
  constructor(message, code = 'workspace_error') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/** 默认工作区：用户目录下的 HermesWorkspace。安装后用户可改。 */
function defaultRoot() {
  return path.join(os.homedir(), 'HermesWorkspace');
}

/**
 * 把任意用户输入解析成工作区内的绝对路径。
 * 相对路径按工作区根解析；绝对路径必须落在工作区内。
 * 符号链接会被 realpath 展开后再校验，防止软链逃出工作区。
 */
class Workspace {
  constructor({ root, logger }) {
    this.rootRaw = String(root || '').trim();
    if (!this.rootRaw) throw new WorkspaceError('工作目录不能为空');
    if (!path.isAbsolute(this.rootRaw)) throw new WorkspaceError(`工作目录必须是绝对路径: ${this.rootRaw}`);
    // 只做字符串规整，不去 realpath——目录可能还不存在。
    this.root = path.resolve(path.normalize(this.rootRaw));
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
  }

  /** 比较用的规范化形式：Windows 大小写不敏感，且要吃掉尾部分隔符。 */
  static canonical(target) {
    const resolved = path.resolve(path.normalize(String(target)));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  get dir() { return this.root; }
  get hermesDir() { return path.join(this.root, HERMES_DIR); }
  get memoryDir() { return path.join(this.hermesDir, MEMORY_DIR); }
  get skillsDir() { return path.join(this.hermesDir, SKILLS_DIR); }
  get agentsFile() { return path.join(this.root, AGENTS_FILE); }

  exists() {
    try { return fs.statSync(this.root).isDirectory(); } catch (_) { return false; }
  }

  /** 解析相对/绝对路径，返回工作区内的绝对地址。越界直接抛错。 */
  resolve(target) {
    const input = String(target == null ? '' : target).trim();
    if (!input) return this.root;
    // 明确拒绝空段与裸分隔符以外的异常输入，避免 resolve 悄悄吞掉意图。
    if (input.includes('\0')) throw new WorkspaceError('路径包含非法字符', 'invalid_path');
    const candidate = path.isAbsolute(input) ? path.normalize(input) : path.resolve(this.root, input);
    this.assertInside(candidate);
    return candidate;
  }

  /** 越界检查。文件或目录不存在时退化为父目录检查（新建场景）。 */
  assertInside(target) {
    const candidate = path.resolve(path.normalize(String(target)));
    const rootKey = Workspace.canonical(this.root);
    let probe = candidate;

    // 已存在的路径展开真实位置，挡住 junction/symlink 逃逸。
    try { probe = fs.realpathSync(candidate); } catch (_) { /* 还不存在，用原始值 */ }

    const probeKey = Workspace.canonical(probe);
    const inside = probeKey === rootKey || probeKey.startsWith(rootKey + path.sep);
    if (!inside) {
      // realpath 可能把路径带到别处，再用原始值兜一次，兼容"目标还不存在"的新建场景。
      const rawKey = Workspace.canonical(candidate);
      if (rawKey !== rootKey && !rawKey.startsWith(rootKey + path.sep)) {
        throw new WorkspaceError(`路径超出工作目录范围: ${target}`, 'path_escape');
      }
    }
    return candidate;
  }

  /** 给大模型看的相对路径，避免把用户机器的绝对路径喂给远端。 */
  relative(target) {
    const rel = path.relative(this.root, path.resolve(String(target)));
    return rel ? rel.split(path.sep).join('/') : '.';
  }

  /** 首次使用：建目录、写 AGENTS.md、备好记忆与技能目录。 */
  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.mkdirSync(this.skillsDir, { recursive: true });
    if (!fs.existsSync(this.agentsFile)) {
      fs.writeFileSync(this.agentsFile, DEFAULT_AGENTS_MD, 'utf8');
    }
    return { root: this.root, created: { memory: this.memoryDir, skills: this.skillsDir, agents: this.agentsFile } };
  }

  readAgents() {
    try { return fs.readFileSync(this.agentsFile, 'utf8'); } catch (_) { return ''; }
  }

  /**
   * 工作区摘要，进入系统提示词。只给结构不给内容，
   * 免得每次对话都把整个项目塞进上下文。
   */
  describe({ maxEntries = 60, maxDepth = 2 } = {}) {
    const lines = [];
    let truncated = false;
    const walk = (dir, depth) => {
      if (depth > maxDepth || lines.length >= maxEntries) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const entry of entries) {
        if (entry.name === HERMES_DIR || entry.name === 'node_modules' || entry.name === '.git') continue;
        if (lines.length >= maxEntries) { truncated = true; return; }
        const indent = '  '.repeat(depth);
        lines.push(`${indent}${entry.isDirectory() ? entry.name + '/' : entry.name}`);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      }
    };
    walk(this.root, 0);
    return { root: this.root, tree: lines.join('\n'), truncated, empty: lines.length === 0 };
  }
}

module.exports = { Workspace, WorkspaceError, defaultRoot, HERMES_DIR, AGENTS_FILE, DEFAULT_AGENTS_MD };
