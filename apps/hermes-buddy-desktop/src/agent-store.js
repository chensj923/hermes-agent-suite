'use strict';

/**
 * 智能体（Agent）配置存储。
 *
 * 一个智能体 = 一套独立的工作环境：名称 + 工作目录 + 权限档位 + 默认模型。
 * 角色（persona）/ 技能 / 记忆都落在各自工作区的 .hermes/ 下，
 * 所以"给每个智能体配不同工作区"天然就隔离了它们的知识与能力。
 *
 * 持久化在 userData/agents.json，不含任何密钥。
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'agents.json';

function genId() {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeAgent(raw, index) {
  return {
    id: String((raw && raw.id) || genId()),
    name: String((raw && raw.name) || `智能体 ${index + 1}`).slice(0, 40),
    // 空字符串 = 跟随连接时配置的默认工作目录
    workspace: String((raw && raw.workspace) || '').trim(),
    model: String((raw && raw.model) || '').trim(),
    permission: ['read', 'read-write', 'full'].includes(raw && raw.permission) ? raw.permission : 'read-write',
    createdAt: Number((raw && raw.createdAt) || Date.now())
  };
}

class AgentStore {
  constructor({ dir, logger } = {}) {
    if (!dir) throw new Error('缺少存储目录');
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.state = this.load();
  }

  load() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* 首次或损坏，走默认 */ }
    const list = Array.isArray(raw && raw.agents) && raw.agents.length
      ? raw.agents.map(normalizeAgent)
      : [normalizeAgent({ id: 'default', name: '默认智能体' }, 0)];
    const activeId = list.some((a) => a.id === (raw && raw.activeId)) ? raw.activeId : list[0].id;
    return { agents: list, activeId };
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn('agent-store-save-failed', { error: error.message });
    }
    return this.state;
  }

  list() { return this.state.agents.slice(); }
  get activeId() { return this.state.activeId; }
  active() { return this.state.agents.find((a) => a.id === this.state.activeId) || this.state.agents[0]; }
  find(id) { return this.state.agents.find((a) => a.id === id) || null; }

  create(input = {}) {
    const agent = normalizeAgent(input, this.state.agents.length);
    this.state.agents.push(agent);
    this.state.activeId = agent.id;
    this.save();
    return agent;
  }

  update(id, patch = {}) {
    const agent = this.find(id);
    if (!agent) throw new Error(`智能体不存在: ${id}`);
    if (patch.name !== undefined) agent.name = String(patch.name).trim().slice(0, 40) || agent.name;
    if (patch.workspace !== undefined) agent.workspace = String(patch.workspace).trim();
    if (patch.model !== undefined) agent.model = String(patch.model).trim();
    if (patch.permission !== undefined && ['read', 'read-write', 'full'].includes(patch.permission)) {
      agent.permission = patch.permission;
    }
    this.save();
    return agent;
  }

  remove(id) {
    if (this.state.agents.length <= 1) throw new Error('至少保留一个智能体');
    const index = this.state.agents.findIndex((a) => a.id === id);
    if (index === -1) return false;
    this.state.agents.splice(index, 1);
    if (this.state.activeId === id) this.state.activeId = this.state.agents[0].id;
    this.save();
    return true;
  }

  activate(id) {
    const agent = this.find(id);
    if (!agent) throw new Error(`智能体不存在: ${id}`);
    this.state.activeId = id;
    this.save();
    return agent;
  }
}

module.exports = { AgentStore, FILE_NAME };
