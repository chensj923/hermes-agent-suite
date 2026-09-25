'use strict';

/**
 * v4.11.0：结晶引擎（本地的"长期记忆"）。
 *
 * 目标：让桌宠越用越懂你，而不是每次都从零盲猜。
 *
 * 工作方式（三段）：
 *  1) 记录——每次主动推测/触发都把「行为模式」写进本地（哪个应用、哪个行为、什么意图、
 *     用户后来是接受还是拒绝）。只存元数据，绝不存窗口标题和文档内容。
 *  2) 结晶——第二次及以后打开应用时后台静默跑一次：淘汰过期/你不爱用的预测，
 *     把反复命中且你常常接受的模式固化成"高置信预测"。
 *  3) 使用——命中应用时，结晶出来的高置信行为排在前面；接受率足够高的行为
 *     可以直接跳过确认框自动执行（用户不再被反复打扰）。
 *
 * 纯 JS、零 Electron 依赖，node --test 可直接加载。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 结晶最小间隔：距上次结晶超过这个时长且又有新行为，才在后台跑一次
  crystalIntervalMs: 6 * 60 * 60 * 1000,
  // 模式过期：这么久没再出现就淘汰（预测时效性的保证）
  expireMs: 21 * 24 * 60 * 60 * 1000,
  // 至少命中几次才可能结晶成预测
  minHits: 2,
  // 至少有过几次明确接受/拒绝，才用接受率做淘汰判断
  minDecisions: 4,
  // 接受率低于此值（且样本够）→ 淘汰
  retireBelowRate: 0.25,
  // 结晶门槛：接受率 ≥ 此值（或样本不足时的冷启动分）才生成预测
  crystalMinRate: 0.5,
  // 每个应用最多保留几条预测
  maxPerApp: 3,
  // 全局最多保留多少条预测
  maxPredictions: 80,
  // 行为流水最多保留多少条（环形）
  maxEvents: 500,
};

/** 模式 key：appId + 行为 id。 */
function keyOf(appId, behaviorId) {
  return String(appId || 'unknown') + '::' + String(behaviorId || 'unknown');
}

class CrystalEngine {
  constructor({ dataDir, now, logger } = {}) {
    if (!dataDir) throw new Error('CrystalEngine 需要 dataDir');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'crystal.json');
    this._now = now || Date.now;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.opts = Object.assign({}, DEFAULTS);
    this._data = null;
  }

  // ---------------- 落盘 ----------------
  _ensureDir() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (_) {}
  }

  _load() {
    if (this._data) return this._data;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      parsed = { version: 1, createdAt: this._now(), updatedAt: 0, lastCrystalAt: 0, runs: 0, patterns: {}, predictions: [], events: [] };
    }
    parsed.patterns = parsed.patterns && typeof parsed.patterns === 'object' ? parsed.patterns : {};
    parsed.predictions = Array.isArray(parsed.predictions) ? parsed.predictions : [];
    parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
    this._data = parsed;
    return this._data;
  }

  _save() {
    this._ensureDir();
    const d = this._load();
    d.updatedAt = this._now();
    try { fs.writeFileSync(this.file, JSON.stringify(d, null, 2), 'utf8'); }
    catch (e) { this.logger.warn('crystal-save-failed', { error: e.message }); }
  }

  // ---------------- 记录 ----------------
  /**
   * 记录一次"行为模式"。每次主动推测/触发都调一次。
   * @param {{appId?:string,behaviorId?:string,intent?:string,text?:string,proactive?:boolean}} info
   */
  record(info) {
    const d = this._load();
    const now = this._now();
    const appId = String((info && info.appId) || 'unknown');
    const behaviorId = String((info && info.behaviorId) || 'unknown');
    const key = keyOf(appId, behaviorId);
    let p = d.patterns[key];
    if (!p) {
      p = { appId, behaviorId, hits: 0, accepts: 0, rejects: 0, firstAt: now, lastAt: now, retired: false };
      d.patterns[key] = p;
    }
    p.hits += 1;
    p.lastAt = now;
    p.intent = String((info && info.intent) || p.intent || '');
    // 文案以最新一次为准（用户改过规则也能跟上）
    if (info && typeof info.text === 'string' && info.text) p.text = info.text.slice(0, 300);
    // 只留最近 maxEvents 条流水（不含标题等隐私字段）
    d.events.push({
      t: now,
      appId,
      behaviorId,
      intent: p.intent,
      proactive: Boolean(info && info.proactive),
      outcome: '',   // 'accept' / 'reject' 由 recordOutcome 回填
    });
    if (d.events.length > this.opts.maxEvents) d.events.splice(0, d.events.length - this.opts.maxEvents);
    this._save();
    return Object.assign({}, p);
  }

  /**
   * 回填最近一条同 key 流水的结果（接受/拒绝）。
   * proactively 由 controller 在用户点「生成」或「稍后/不再」时调用。
   */
  recordOutcome(info, accepted) {
    const d = this._load();
    const now = this._now();
    const appId = String((info && info.appId) || 'unknown');
    const behaviorId = String((info && info.behaviorId) || 'unknown');
    const key = keyOf(appId, behaviorId);
    const p = d.patterns[key] || { appId, behaviorId, hits: 0, accepts: 0, rejects: 0, firstAt: now, lastAt: now, retired: false };
    d.patterns[key] = p;
    if (accepted) p.accepts += 1; else p.rejects += 1;
    p.lastAt = now;
    // 回填最近一条未结算的流水
    for (let i = d.events.length - 1; i >= 0; i--) {
      const e = d.events[i];
      if (e.appId === appId && e.behaviorId === behaviorId && !e.outcome) { e.outcome = accepted ? 'accept' : 'reject'; break; }
    }
    this._save();
    return this.scoreOf(appId, behaviorId);
  }

  // ---------------- 查询 ----------------
  /** 单个模式的打分：{hits, accepts, rejects, acceptRate, confidence, retired}。 */
  scoreOf(appId, behaviorId) {
    const d = this._load();
    const p = d.patterns[keyOf(appId, behaviorId)];
    const hits = p ? p.hits : 0;
    const accepts = p ? p.accepts : 0;
    const rejects = p ? p.rejects : 0;
    const decisions = accepts + rejects;
    const acceptRate = decisions > 0 ? accepts / decisions : 0;
    // 冷启动：还没攒够决策时给一个偏中性的分，随命中次数缓慢上升
    let confidence;
    if (decisions > 0) confidence = acceptRate;
    else confidence = Math.min(0.5, 0.25 + hits * 0.05);
    return { hits, accepts, rejects, acceptRate, confidence, retired: Boolean(p && p.retired) };
  }

  /** 某应用当前有效的结晶预测（按置信度降序）。 */
  predictionsFor(appId) {
    const d = this._load();
    return d.predictions
      .filter((x) => !x.retired && x.appId === appId)
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }

  /** 全部有效预测（诊断/设置面板用）。 */
  allPredictions() {
    return this._load().predictions.filter((x) => !x.retired).slice();
  }

  /** 摘要：模式数、预测数、上次结晶时间。 */
  summary() {
    const d = this._load();
    return {
      patterns: Object.keys(d.patterns).length,
      predictions: d.predictions.filter((x) => !x.retired).length,
      events: d.events.length,
      lastCrystalAt: d.lastCrystalAt || 0,
      runs: d.runs || 0,
    };
  }

  // ---------------- 结晶 ----------------
  /** 是否该在后台跑一次结晶。 */
  shouldCrystal() {
    const d = this._load();
    const now = this._now();
    // 有未结算的新行为，且距上次结晶够久（首次使用只要有 ≥2 条行为就跑一次）
    const hasNew = d.events.some((e) => e.t > (d.lastCrystalAt || 0));
    if (!hasNew) return false;
    if (!d.lastCrystalAt) return d.events.length >= 2;
    return now - d.lastCrystalAt >= this.opts.crystalIntervalMs;
  }

  /**
   * 跑一次结晶：淘汰过期/低接受率预测，把高频高接受率模式固化成新预测。
   * @returns {{retired:Array, added:Array, updated:Array, kept:number}}
   */
  crystallize() {
    const d = this._load();
    const now = this._now();
    const retired = [];
    const added = [];
    const updated = [];

    // 1) 淘汰：过期 + 低接受率
    for (const key of Object.keys(d.patterns)) {
      const p = d.patterns[key];
      const decisions = (p.accepts || 0) + (p.rejects || 0);
      const rate = decisions > 0 ? p.accepts / decisions : 1;
      const stale = now - (p.lastAt || 0) > this.opts.expireMs;
      const disliked = decisions >= this.opts.minDecisions && rate < this.opts.retireBelowRate;
      if (stale || disliked) {
        p.retired = true;
        retired.push({ key, reason: stale ? 'expired' : 'low-accept-rate', rate: Number(rate.toFixed(2)), hits: p.hits });
      }
    }
    // 同步淘汰对应预测
    for (const pred of d.predictions) {
      const p = d.patterns[pred.id];
      if (p && p.retired && !pred.retired) {
        pred.retired = true;
        pred.retiredAt = now;
      }
    }

    // 2) 新增/更新：命中够多且接受率达标
    const byApp = {};
    for (const pred of d.predictions) {
      if (pred.retired) continue;
      byApp[pred.appId] = (byApp[pred.appId] || 0) + 1;
    }
    const candidates = Object.keys(d.patterns)
      .map((k) => d.patterns[k])
      .filter((p) => !p.retired && p.hits >= this.opts.minHits)
      .map((p) => {
        const s = this.scoreOf(p.appId, p.behaviorId);
        return { p, s };
      })
      .filter((x) => x.s.confidence >= this.opts.crystalMinRate)
      .sort((a, b) => (b.s.confidence - a.s.confidence) || (b.p.hits - a.p.hits));

    for (const { p, s } of candidates) {
      const existing = d.predictions.find((x) => x.id === keyOf(p.appId, p.behaviorId));
      if (existing) {
        if (existing.retired) { existing.retired = false; existing.retiredAt = 0; }
        existing.confidence = Number(s.confidence.toFixed(3));
        existing.hits = p.hits;
        existing.accepts = p.accepts || 0;
        existing.lastHitAt = p.lastAt || now;
        if (p.text) existing.text = p.text;
        if (p.intent) existing.intent = p.intent;
        updated.push(existing.id);
        continue;
      }
      if ((byApp[p.appId] || 0) >= this.opts.maxPerApp) continue;
      if (d.predictions.filter((x) => !x.retired).length >= this.opts.maxPredictions) continue;
      d.predictions.push({
        id: keyOf(p.appId, p.behaviorId),
        appId: p.appId,
        behaviorId: p.behaviorId,
        intent: p.intent || '',
        text: p.text || '',
        confidence: Number(s.confidence.toFixed(3)),
        createdAt: now,
        lastHitAt: p.lastAt || now,
        hits: p.hits,
        accepts: p.accepts || 0,
        retired: false,
      });
      byApp[p.appId] = (byApp[p.appId] || 0) + 1;
      added.push(keyOf(p.appId, p.behaviorId));
    }

    d.lastCrystalAt = now;
    d.runs = (d.runs || 0) + 1;
    this._save();
    const result = {
      retired,
      added,
      updated,
      kept: d.predictions.filter((x) => !x.retired).length,
    };
    this.logger.info('crystal-run', { added: added.length, updated: updated.length, retired: retired.length, kept: result.kept });
    return result;
  }

  /** 一键清空（隐私开关 / 重置）。 */
  reset() {
    try { fs.rmSync(this.file, { force: true }); } catch (_) {}
    this._data = null;
  }
}

module.exports = { CrystalEngine, DEFAULTS, keyOf };
