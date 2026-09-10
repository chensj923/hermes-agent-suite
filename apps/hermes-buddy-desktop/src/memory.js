'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = 'MEMORY.md';
const MAX_MEMORY_CHARS = 6000;
const MAX_DAILY_CHARS = 4000;

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 两层记忆：
 *  - 全局：跨工作区的用户偏好，放在应用数据目录
 *  - 项目：只属于当前工作区的约定，放在工作区 .hermes 下，可随项目一起提交
 * 大模型只看到拼接后的文本，路径细节跟它无关。
 */
class MemoryStore {
  constructor({ workspace, appDir, logger }) {
    if (!workspace) throw new Error('缺少 workspace');
    if (!appDir) throw new Error('缺少应用数据目录');
    this.workspace = workspace;
    this.appDir = appDir;
    this.globalDir = path.join(appDir, 'memory');
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
  }

  ensure() {
    fs.mkdirSync(this.globalDir, { recursive: true });
    fs.mkdirSync(this.workspace.memoryDir, { recursive: true });
    return { global: this.globalDir, project: this.workspace.memoryDir };
  }

  readFile(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  }

  writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return content;
  }

  projectMemory() { return this.readFile(path.join(this.workspace.memoryDir, MEMORY_FILE)); }
  globalMemory() { return this.readFile(path.join(this.globalDir, MEMORY_FILE)); }
  saveProjectMemory(text) { return this.writeFile(path.join(this.workspace.memoryDir, MEMORY_FILE), String(text)); }
  saveGlobalMemory(text) { return this.writeFile(path.join(this.globalDir, MEMORY_FILE), String(text)); }

  /** 追加当天日志；同一天的多条记录会累积，方便事后回溯。 */
  appendDaily(text, scope = 'project') {
    const dir = scope === 'global' ? this.globalDir : this.workspace.memoryDir;
    const file = path.join(dir, `${today()}.md`);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = `\n- ${stamp} ${String(text).trim()}\n`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, entry, 'utf8');
    return file;
  }

  recentDaily(scope = 'project', days = 3) {
    const dir = scope === 'global' ? this.globalDir : this.workspace.memoryDir;
    const out = [];
    const base = new Date();
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(base.getTime() - offset * 86400000);
      const pad = (value) => String(value).padStart(2, '0');
      const name = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const content = this.readFile(path.join(dir, `${name}.md`));
      if (content.trim()) out.push(`### ${name}\n${content.trim().slice(-MAX_DAILY_CHARS)}`);
    }
    return out.join('\n\n');
  }

  /** 拼成给系统提示词的记忆块。没有记忆就返回空串，别塞一堆占位符。 */
  render() {
    const blocks = [];
    const global = this.globalMemory().trim().slice(0, MAX_MEMORY_CHARS);
    const project = this.projectMemory().trim().slice(0, MAX_MEMORY_CHARS);
    const daily = this.recentDaily('project', 2).trim();
    if (global) blocks.push(`【用户长期记忆（跨项目）】\n${global}`);
    if (project) blocks.push(`【本项目记忆】\n${project}`);
    if (daily) blocks.push(`【最近工作日志】\n${daily}`);
    return blocks.join('\n\n');
  }

  summary() {
    return {
      globalDir: this.globalDir,
      projectDir: this.workspace.memoryDir,
      globalChars: this.globalMemory().length,
      projectChars: this.projectMemory().length
    };
  }
}

/** 让用户自己写一句话，模型下次就能记住。 */
function rememberLine(store, line, scope = 'project') {
  const text = String(line || '').trim();
  if (!text) return { ok: false, error: '内容为空' };
  const current = scope === 'global' ? store.globalMemory() : store.projectMemory();
  const next = `${current.trim()}\n- ${text}\n`.trim() + '\n';
  if (scope === 'global') store.saveGlobalMemory(next); else store.saveProjectMemory(next);
  return { ok: true, scope, chars: next.length };
}

module.exports = { MemoryStore, rememberLine, today, MEMORY_FILE, MAX_MEMORY_CHARS };
