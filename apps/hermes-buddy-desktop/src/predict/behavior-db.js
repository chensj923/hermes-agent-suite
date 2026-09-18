'use strict';

/**
 * 行为日志 + 偏好结晶（纯 JS，零 Electron 依赖，node --test 可测）。
 *
 * 隐私是设计前提，不是补丁：
 * - 事件日志（events.log.jsonl）只写「行为元数据」白名单字段。
 * - 任何白名单外的字段（title / text / content / password …）一律在入口被剥离，
 *   即调用方就算误传了内容，也不会落盘。这是防御性纵深。
 * - 结晶（crystallization.json）只存「模式」：每条规则的触发 / 接受 / 拒绝次数，
 *   绝不存窗口标题或你输入的内容。
 * - 事件日志按 TTL（默认 7 天）清理。
 */

const fs = require('fs');
const path = require('path');

/** 允许落盘的事件字段白名单。任何不在其中的键都会被 recordEvent 丢弃。 */
const EVENT_KEYS = new Set([
  't', 'type', 'windowClass', 'region', 'inEditArea',
  'clipboardType', 'clipboardLength', 'typedCount', 'pauseMs',
  'mouseIdleMs', 'windowChangesLast10s'
]);

class BehaviorDB {
  constructor({ dataDir, ttlMs, now } = {}) {
    if (!dataDir) throw new Error('BehaviorDB 需要 dataDir');
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.log.jsonl');
    this.crystalFile = path.join(dataDir, 'crystallization.json');
    this.ttlMs = ttlMs || 7 * 24 * 60 * 60 * 1000;
    this._now = now || Date.now;
    this._crystal = null;
  }

  _ensureDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ---------- 事件日志（只存元数据） ----------
  /**
   * 记录一条行为事件。event 里只能含白名单字段，其余（含内容/标题）会被丢弃。
   * 返回实际落盘的干净对象。
   */
  recordEvent(event) {
    const now = this._now();
    const clean = { t: now };
    for (const k of EVENT_KEYS) {
      if (k === 't') continue;
      if (event && Object.prototype.hasOwnProperty.call(event, k)) clean[k] = event[k];
    }
    this._ensureDir();
    fs.appendFileSync(this.eventsFile, JSON.stringify(clean) + '\n', 'utf8');
    return clean;
  }

  /** 取最近 windowMs 内的事件（超过 TTL 的旧事件视为过期，不返回）。 */
  getRecentEvents(windowMs) {
    const cutoff = this._now() - (windowMs || 0);
    const out = [];
    let raw = '';
    try { raw = fs.readFileSync(this.eventsFile, 'utf8'); } catch (_) { return out; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.t >= cutoff) out.push(e);
      } catch (_) { /* 跳过损坏行 */ }
    }
    return out;
  }

  // ---------- 偏好结晶（按规则） ----------
  _loadCrystal() {
    if (this._crystal) return this._crystal;
    try { this._crystal = JSON.parse(fs.readFileSync(this.crystalFile, 'utf8')); }
    catch (_) { this._crystal = {}; }
    return this._crystal;
  }

  _saveCrystal() {
    this._ensureDir();
    fs.writeFileSync(this.crystalFile, JSON.stringify(this._crystal || {}, null, 2), 'utf8');
  }

  _stat(rule) {
    const c = this._loadCrystal();
    if (!c[rule]) c[rule] = { triggers: 0, accepts: 0, rejects: 0, rejectStreak: 0, retired: false };
    return c[rule];
  }

  recordTrigger(rule) {
    const s = this._stat(rule);
    s.triggers += 1;
    this._saveCrystal();
    return s;
  }

  /**
   * 记录一次用户对建议的决策。
   * 接受 → accepts++、拒绝连击清零。
   * 拒绝 → rejects++、拒绝连击+1；连续拒绝 ≥3 次且接受率 < 0.2 → retired（不再弹）。
   */
  recordDecision(rule, accepted) {
    const s = this._stat(rule);
    if (accepted) {
      s.accepts += 1;
      s.rejectStreak = 0;
    } else {
      s.rejects += 1;
      s.rejectStreak = (s.rejectStreak || 0) + 1;
      const total = s.accepts + s.rejects;
      const acceptRate = total > 0 ? s.accepts / total : 0;
      if (s.rejectStreak >= 3 && acceptRate < 0.2) s.retired = true;
    }
    this._saveCrystal();
    return s;
  }

  getStats(rule) {
    const s = this._stat(rule);
    const total = s.accepts + s.rejects;
    return Object.assign({}, s, { acceptRate: total > 0 ? s.accepts / total : 0 });
  }

  isRetired(rule) {
    return Boolean(this._stat(rule).retired);
  }

  getCrystallization() {
    const c = this._loadCrystal();
    const out = {};
    for (const rule of Object.keys(c)) out[rule] = this.getStats(rule);
    return out;
  }

  // ---------- 清理 ----------
  /** 删除超过 TTL 的事件行，返回删除条数。 */
  pruneOld() {
    let raw = '';
    try { raw = fs.readFileSync(this.eventsFile, 'utf8'); } catch (_) { return 0; }
    const cutoff = this._now() - this.ttlMs;
    const kept = [];
    let removed = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.t >= cutoff) kept.push(line);
        else removed += 1;
      } catch (_) { kept.push(line); } // 损坏行保留，避免误删有效数据
    }
    this._ensureDir();
    fs.writeFileSync(this.eventsFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return removed;
  }

  /** 一键清空（一键关闭 / 重置）。 */
  reset() {
    for (const f of [this.eventsFile, this.crystalFile]) {
      try { fs.rmSync(f, { force: true }); } catch (_) {}
    }
    this._crystal = null;
  }
}

module.exports = { BehaviorDB, EVENT_KEYS };
