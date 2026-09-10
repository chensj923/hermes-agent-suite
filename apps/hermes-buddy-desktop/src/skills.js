'use strict';

const fs = require('fs');
const path = require('path');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_SKILL_CHARS = 3000;

/** 只解析 name/description 两个键，够用且不必引入 YAML 依赖。 */
function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (pair) meta[pair[1].toLowerCase()] = pair[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * 技能 = 一份 Markdown 说明，按需注入系统提示词。
 * 内置技能随安装包分发，项目技能放在工作区 .hermes/skills 下、可以随仓库提交。
 */
class SkillStore {
  constructor({ builtinDir, workspace, logger }) {
    this.builtinDir = builtinDir || null;
    this.workspace = workspace || null;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
  }

  static from(file, scope) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || path.basename(file, '.md');
    return {
      name,
      description: meta.description || '',
      scope,
      path: file,
      content: body.trim(),
      chars: body.trim().length
    };
  }

  list() {
    const out = [];
    const collect = (dir, scope) => {
      if (!dir) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const skill = SkillStore.from(path.join(dir, entry.name), scope);
        if (skill) out.push(skill);
      }
    };
    collect(this.builtinDir, 'builtin');
    collect(this.workspace ? this.workspace.skillsDir : null, 'project');
    // 同名时项目技能覆盖内置，方便用户改。
    const byName = new Map();
    for (const skill of out) byName.set(skill.name, skill);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name) {
    return this.list().find((skill) => skill.name === name) || null;
  }

  save(name, content, description = '') {
    if (!this.workspace) throw new Error('没有工作区，无法保存技能');
    if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(String(name || ''))) throw new Error('技能名只能包含字母、数字、- 和 _');
    fs.mkdirSync(this.workspace.skillsDir, { recursive: true });
    const file = path.join(this.workspace.skillsDir, `${name}.md`);
    const head = `---\nname: ${name}\ndescription: ${description || '由用户创建的工作技能'}\n---\n\n`;
    fs.writeFileSync(file, head + String(content || '').trim() + '\n', 'utf8');
    return SkillStore.from(file, 'project');
  }

  remove(name) {
    const skill = this.list().find((item) => item.name === name);
    if (!skill) return false;
    if (skill.scope !== 'project') throw new Error('内置技能不能删除，可在工作区创建同名技能覆盖');
    fs.unlinkSync(skill.path);
    return true;
  }

  /**
   * 注入系统提示词的技能块。
   * 只放名称与简介，避免把全部技能正文塞进每一轮对话——需要时让模型用 read_file 自己读。
   */
  render() {
    const skills = this.list();
    if (!skills.length) return '';
    const lines = skills.map((skill) => `- ${skill.name}（${skill.scope === 'builtin' ? '内置' : '项目'}）：${skill.description || '（无说明）'}`);
    return ['【可用技能】', '下面是本工作区可用的技能。需要某个技能的详细步骤时，用 read_file 读取 .hermes/skills/<名称>.md。', '', ...lines].join('\n');
  }

  /** 全部技能正文，用于"技能模式"这类需要完整上下文的场景。 */
  renderFull(limit = MAX_SKILL_CHARS) {
    const skills = this.list();
    if (!skills.length) return '';
    let used = 0;
    const chunks = [];
    for (const skill of skills) {
      if (used + skill.content.length > limit) break;
      chunks.push(`### ${skill.name}\n${skill.content}`);
      used += skill.content.length;
    }
    return chunks.join('\n\n');
  }
}

module.exports = { SkillStore, parseFrontmatter };
