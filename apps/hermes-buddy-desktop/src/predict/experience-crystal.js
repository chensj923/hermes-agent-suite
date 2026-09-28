'use strict';

/**
 * v4.12.13 经验结晶引擎（按用户定义的"结晶"重做）
 *
 * 概念：从桌宠自身行为（预测接受/拒绝、生成回复）中提炼常用模式，
 * 每天结晶、更新，并**分级**：
 *   - tier=script：频率高且做法一致（低变体 / 高接受）→ 固化为可直接执行的桌宠内部规则
 *   - tier=model ：频率高但需判断（高变体 / 中接受）→ 固化为"调用模型的方案"（prompt/规则）
 *
 * 三类输入（来自现有 predict-controller 的 record/recordOutcome 信号）：
 *   - 预测行为（appId + behaviorId + intent + 接受/拒绝）
 *   - 工具类操作（intent 非生成类 → kind='behavior'）
 *   - 常用回复（intent ∈ {word_writing, message_reply} → kind='reply'）
 *
 * 纯 JS、零 Electron 依赖，node --test 可直接加载。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPLY_INTENTS = new Set(['word_writing', 'message_reply']);

function kindOfIntent(intent) {
  return REPLY_INTENTS.has(intent) ? 'reply' : 'behavior';
}

function clusterKey(appId, behaviorId, intent) {
  return [kindOfIntent(intent), String(appId || 'unknown'), String(behaviorId || 'unknown'), String(intent || 'unknown')].join('::');
}

/** 归一化文案用于判断"做法是否一致"（变体计数）。 */
function normText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

const DEFAULTS = {
  // 结晶最小间隔：默认每天一次（距上次结晶超过这个时长且有新行为才跑）
  crystalIntervalMs: 24 * 60 * 60 * 1000,
  // 模式过期：这么久没再出现就淘汰
  expireMs: 30 * 24 * 60 * 60 * 1000,
  // 至少命中几次才可能结晶成经验
  minHits: 3,
  // 至少有过几次明确接受/拒绝，才用接受率做分级判断
  minDecisions: 4,
  // 接受率低于此值（且样本够）→ 淘汰（用户不爱用）
  retireBelowRate: 0.25,
  // 确定性门槛：接受率 ≥ 此值且变体少 → 直接执行（script）
  scriptAcceptRate: 0.6,
  // 变体数 ≤ 此值（做法一致）→ 倾向 script
  scriptMaxVariants: 2,
  // 频率够但需判断时，至少命中几次才固化为 model 方案
  modelMinHits: 3,
  // 经验库最多保留多少条
  maxExperiences: 120,
  // 行为流水最多保留多少条（环形，仅调试用；聚类统计走 patterns 不丢）
  maxEvents: 800,
};

class ExperienceCrystal {
  constructor({ dataDir, now, logger } = {}) {
    if (!dataDir) throw new Error('ExperienceCrystal 需要 dataDir');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'experience.json');
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
      parsed = { version: 1, createdAt: this._now(), updatedAt: 0, lastCrystalAt: 0, runs: 0, patterns: {}, experiences: [], events: [] };
    }
    parsed.patterns = parsed.patterns && typeof parsed.patterns === 'object' ? parsed.patterns : {};
    parsed.experiences = Array.isArray(parsed.experiences) ? parsed.experiences : [];
    parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
    this._data = parsed;
    return this._data;
  }

  _save() {
    this._ensureDir();
    const d = this._load();
    d.updatedAt = this._now();
    try { fs.writeFileSync(this.file, JSON.stringify(d, null, 2), 'utf8'); }
    catch (e) { this.logger.warn('experience-save-failed', { error: e.message }); }
  }

  // ---------------- 记录 ----------------
  /**
   * 记录一次行为（来自 predict-controller.record 信号）。
   * @param {{appId?:string,behaviorId?:string,intent?:string,text?:string,proactive?:boolean}} info
   */
  record(info) {
    const d = this._load();
    const now = this._now();
    const appId = String((info && info.appId) || 'unknown');
    const behaviorId = String((info && info.behaviorId) || 'unknown');
    const intent = String((info && info.intent) || 'unknown');
    const key = clusterKey(appId, behaviorId, intent);
    const kind = kindOfIntent(intent);
    let p = d.patterns[key];
    if (!p) {
      p = { appId, behaviorId, intent, kind, hits: 0, accepts: 0, rejects: 0, texts: [], firstAt: now, lastAt: now, retired: false };
      d.patterns[key] = p;
    }
    p.hits += 1;
    p.lastAt = now;
    const n = normText(info && info.text);
    if (n) {
      p.texts.push(n);
      if (p.texts.length > 12) p.texts.splice(0, p.texts.length - 12); // 只留最近若干用于变体判断
    }
    d.events.push({ t: now, appId, behaviorId, intent, kind, text: (info && info.text || '').slice(0, 300), proactive: Boolean(info && info.proactive), outcome: '' });
    if (d.events.length > this.opts.maxEvents) d.events.splice(0, d.events.length - this.opts.maxEvents);
    this._save();
    return Object.assign({}, p);
  }

  /** 回填最近一条同 key 流水的结果（接受/拒绝）。 */
  recordOutcome(info, accepted) {
    const d = this._load();
    const now = this._now();
    const appId = String((info && info.appId) || 'unknown');
    const behaviorId = String((info && info.behaviorId) || 'unknown');
    const intent = String((info && info.intent) || 'unknown');
    const key = clusterKey(appId, behaviorId, intent);
    const p = d.patterns[key] || { appId, behaviorId, intent, kind: kindOfIntent(intent), hits: 0, accepts: 0, rejects: 0, texts: [], firstAt: now, lastAt: now, retired: false };
    d.patterns[key] = p;
    if (accepted) p.accepts += 1; else p.rejects += 1;
    p.lastAt = now;
    for (let i = d.events.length - 1; i >= 0; i--) {
      const e = d.events[i];
      if (e.appId === appId && e.behaviorId === behaviorId && e.intent === intent && !e.outcome) { e.outcome = accepted ? 'accept' : 'reject'; break; }
    }
    this._save();
    return this.scoreOf(appId, behaviorId, intent);
  }

  // ---------------- 查询 ----------------
  scoreOf(appId, behaviorId, intent) {
    const d = this._load();
    const p = d.patterns[clusterKey(appId, behaviorId, intent)];
    const hits = p ? p.hits : 0;
    const accepts = p ? p.accepts : 0;
    const rejects = p ? p.rejects : 0;
    const decisions = accepts + rejects;
    const acceptRate = decisions > 0 ? accepts / decisions : 0;
    const variants = p ? new Set(p.texts).size : 0;
    return { hits, accepts, rejects, acceptRate, variants, retired: Boolean(p && p.retired) };
  }

  /** 出现频率最高的原文（代表主流做法/模板）。 */
  _dominantText(texts) {
    if (!texts || !texts.length) return '';
    const cnt = {};
    let best = '', bestN = 0;
    for (const t of texts) {
      // 还原时找最长非空原文以保留信息（归一化后计数，取原样需另存；这里用归一串近似）
      cnt[t] = (cnt[t] || 0) + 1;
      if (cnt[t] > bestN) { bestN = cnt[t]; best = t; }
    }
    return best;
  }

  /** 全部有效经验（UI / 同步用）。 */
  allExperiences() {
    return this._load().experiences.filter((x) => !x.retired).slice();
  }

  /** 导出可同步到服务端的文档（分级后的经验，覆盖写）。 */
  exportDoc() {
    const list = this.allExperiences();
    const lines = ['# Hermes 经验结晶（每日自动更新）', ''];
    lines.push(`> 由桌宠本地经验结晶引擎每日生成，按确定性分级：script=可直接执行，model=需判断（调模型）。`, '');
    const byTier = { script: [], model: [] };
    for (const e of list) (byTier[e.tier] || byTier.model).push(e);
    for (const tier of ['script', 'model']) {
      lines.push(`## ${tier === 'script' ? '直接执行（脚本/规则）' : '需判断（调用模型方案）'}（${byTier[tier].length}）`);
      if (!byTier[tier].length) { lines.push('_（暂无）_', ''); continue; }
      for (const e of byTier[tier]) {
        const scope = e.appId === 'unknown' ? e.intent : `${e.appId}/${e.behaviorId}`;
        lines.push(`- [${scope}] 频率${e.frequency} 接受率${(e.acceptRate * 100).toFixed(0)}%`);
        lines.push(`  - 做法/模板：${e.template || '(无文本)'}`);
        if (tier === 'model' && e.artifact && e.artifact.modelPlan) {
          lines.push(`  - 模型方案：${e.artifact.modelPlan.prompt}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 摘要：模式数、经验数、上次结晶时间。 */
  summary() {
    const d = this._load();
    return {
      patterns: Object.keys(d.patterns).length,
      experiences: d.experiences.filter((x) => !x.retired).length,
      events: d.events.length,
      lastCrystalAt: d.lastCrystalAt || 0,
      runs: d.runs || 0,
    };
  }

  // ---------------- 结晶 ----------------
  shouldCrystal() {
    const d = this._load();
    const now = this._now();
    const hasNew = d.events.some((e) => e.t > (d.lastCrystalAt || 0));
    if (!hasNew) return false;
    if (!d.lastCrystalAt) return d.events.length >= 2;
    return now - d.lastCrystalAt >= this.opts.crystalIntervalMs;
  }

  /**
   * 跑一次结晶：从 patterns 聚合提炼经验并分级。
   * @returns {{added:Array,updated:Array,retired:Array,kept:number}}
   */
  crystallize() {
    const d = this._load();
    const now = this._now();
    const added = [];
    const updated = [];
    const retired = [];

    // 1) 淘汰过期/低接受率 pattern（及对应经验）
    for (const key of Object.keys(d.patterns)) {
      const p = d.patterns[key];
      const decisions = (p.accepts || 0) + (p.rejects || 0);
      const rate = decisions > 0 ? p.accepts / decisions : 1;
      const stale = now - (p.lastAt || 0) > this.opts.expireMs;
      const disliked = decisions >= this.opts.minDecisions && rate < this.opts.retireBelowRate;
      if (stale || disliked) {
        p.retired = true;
        const ex = d.experiences.find((x) => x.id === hashKey(key));
        if (ex && !ex.retired) { ex.retired = true; ex.retiredAt = now; retired.push(key); }
      }
    }

    // 2) 聚类 → 分级 → 固化
    const idCount = {};
    for (const key of Object.keys(d.patterns)) {
      const p = d.patterns[key];
      if (p.retired) continue;
      if (p.hits < this.opts.minHits) continue;
      const decisions = (p.accepts || 0) + (p.rejects || 0);
      const rate = decisions > 0 ? p.accepts / decisions : 1;
      const variants = new Set(p.texts).size;
      let tier = null;
      if (rate >= this.opts.scriptAcceptRate && variants <= this.opts.scriptMaxVariants) {
        tier = 'script';
      } else if (p.hits >= this.opts.modelMinHits) {
        tier = 'model';
      } else {
        continue; // 样本不够定级，留待后续
      }
      const id = hashKey(key);
      const template = this._dominantText(p.texts);
      const artifact = tier === 'script'
        ? { script: { trigger: { appId: p.appId, behaviorId: p.behaviorId, intent: p.intent }, action: { kind: p.kind, template }, auto: true } }
        : { modelPlan: { when: { appId: p.appId, intent: p.intent }, how: { model: 'hermes-agent' }, prompt: buildModelPlanPrompt(p, template) } };
      const existing = d.experiences.find((x) => x.id === id);
      if (existing) {
        if (existing.retired) { existing.retired = false; existing.retiredAt = 0; }
        existing.tier = tier;
        existing.frequency = p.hits;
        existing.acceptRate = Number(rate.toFixed(2));
        existing.variants = variants;
        existing.template = template;
        existing.artifact = artifact;
        existing.lastHitAt = p.lastAt || now;
        existing.updatedAt = now;
        updated.push(key);
      } else {
        if (d.experiences.filter((x) => !x.retired).length >= this.opts.maxExperiences) continue;
        d.experiences.push({
          id, kind: p.kind, appId: p.appId, behaviorId: p.behaviorId, intent: p.intent,
          tier, frequency: p.hits, acceptRate: Number(rate.toFixed(2)), variants,
          template, artifact, createdAt: now, lastHitAt: p.lastAt || now, updatedAt: now, retired: false,
        });
        added.push(key);
      }
      idCount[tier] = (idCount[tier] || 0) + 1;
    }

    d.lastCrystalAt = now;
    d.runs = (d.runs || 0) + 1;
    this._save();
    const result = { added, updated, retired, kept: d.experiences.filter((x) => !x.retired).length };
    this.logger.info('experience-crystal-run', { added: added.length, updated: updated.length, retired: retired.length, kept: result.kept });
    return result;
  }

  /** 一键清空（隐私重置）。 */
  reset() {
    try { fs.rmSync(this.file, { force: true }); } catch (_) {}
    this._data = null;
  }
}

function hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function buildModelPlanPrompt(p, template) {
  const scope = p.appId === 'unknown' ? `意图「${p.intent}」` : `应用「${p.appId}」的「${p.behaviorId}」`;
  const base = `用户常在${scope}下出现此需求（频率${p.hits}、接受率${(p.accepts / Math.max(1, p.accepts + p.rejects) * 100).toFixed(0)}%），` +
    `但做法随语境变化、需要判断，不要写死。参考做法：「${template || '（无模板）'}」。`;
  if (p.kind === 'reply') {
    return base + ' 生成回复时先判断语境（对象/语气/长度），再参考上述习惯产出，必要时调整。';
  }
  return base + ' 执行前先判断当前状态是否匹配，匹配则按参考做法执行，不匹配则向用户确认。';
}

module.exports = { ExperienceCrystal, DEFAULTS, kindOfIntent, clusterKey, normText };
