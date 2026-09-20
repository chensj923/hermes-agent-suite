'use strict';

/**
 * v4.10.24：场景规则（结晶场景）。
 *
 * 用户需求：预先设置几个触发场景，直接"结晶"起来——
 *   - 打开 WPS 新文档 → 弹「是否需要写作，请命名」
 *   - 打开已有文章   → 弹「是否需要润色」
 *   - 微信/QQ 前台   → 弹「是否需要自动回复」（用户可自定义回复方向提示词）
 * 匹配到场景规则时**跳过**截图 + VL 描述 + 远端推断整条流水线，直接弹浮窗。
 *
 * 规则可由用户在设置面板增删改（config.sceneRules 落盘）。
 * 本模块只做纯逻辑（匹配 + 冷却），不碰 electron / Win32。
 */

/** 默认结晶场景（用户可在设置里禁用/修改/追加）。 */
const DEFAULT_SCENE_RULES = [
  {
    id: 'scene-wps-new',
    name: 'WPS/Word 新文档写作',
    enabled: true,
    exeNames: ['wps', 'winword', 'wpspdf'],
    titleExclude: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
    intent: 'word_writing',
    suggestion: '检测到新建文档，需要我帮你起草吗？告诉我主题就行。',
    prompt: '',
    cooldownMin: 30,
  },
  {
    id: 'scene-wps-polish',
    name: 'WPS/Word 已有文章润色',
    enabled: true,
    exeNames: ['wps', 'winword'],
    titleInclude: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
    intent: 'word_writing',
    suggestion: '检测到已打开的文档，需要我帮你润色或续写吗？',
    prompt: '围绕文档主题生成润色建议或续写内容',
    cooldownMin: 30,
  },
  {
    id: 'scene-im-reply',
    name: '微信/QQ 智能回复',
    enabled: false, // 默认关——自动回复涉及社交场景，用户显式开启
    exeNames: ['wechat', 'weixin', 'qq'],
    intent: 'message_reply',
    suggestion: '需要我帮你起草一条回复吗？',
    prompt: '根据对话场景生成一条得体的回复',
    cooldownMin: 10,
  },
];

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw;
  const id = String(r.id || '').trim();
  if (!id) return null;
  const toList = (v) => String(v || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const min = (n, d) => {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    id,
    name: String(r.name || id).slice(0, 60),
    enabled: r.enabled !== false,
    exeNames: toList(r.exeNames),
    titleInclude: toList(r.titleInclude),
    titleExclude: toList(r.titleExclude),
    intent: String(r.intent || 'word_writing').slice(0, 40),
    suggestion: String(r.suggestion || '').slice(0, 200),
    prompt: String(r.prompt || '').slice(0, 500),
    cooldownMin: min(r.cooldownMin, 30),
  };
}

/** 归一化整张规则表：非法条目剔除，id 冲突去重。 */
function normalizeSceneRules(list) {
  if (!Array.isArray(list)) return DEFAULT_SCENE_RULES.map(normalizeRule).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const r = normalizeRule(raw);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** exe 名匹配：规则项是目标进程名的子串（大小写不敏感）。 */
function exeMatch(ruleExeNames, exeName) {
  if (!ruleExeNames || !ruleExeNames.length) return false;
  const exe = String(exeName || '').toLowerCase();
  if (!exe) return false;
  return ruleExeNames.some((n) => exe.includes(n));
}

/**
 * 判定一个前台窗口是否命中某条已启用的场景规则（不含冷却）。
 * 匹配条件：exe 命中 + 标题不含 titleExclude 任一关键词 + （若配置了
 * titleInclude）标题含至少一个 include 关键词。
 */
function matchRule(rule, { exeName, title } = {}) {
  if (!rule || rule.enabled === false) return false;
  if (!exeMatch(rule.exeNames, exeName)) return false;
  const t = String(title || '').toLowerCase();
  if (rule.titleExclude && rule.titleExclude.length && rule.titleExclude.some((k) => t.includes(k))) return false;
  if (rule.titleInclude && rule.titleInclude.length && !rule.titleInclude.some((k) => t.includes(k))) return false;
  return true;
}

/**
 * 场景监视器：喂前台窗口信息，返回命中的规则（带冷却去重）。
 * 每条规则独立冷却，避免「每次切回 WPS 都弹」的骚扰。
 */
function createSceneWatcher(rules, { now = Date.now } = {}) {
  const normalized = normalizeSceneRules(rules);
  const lastFired = {}; // id -> ts
  return {
    /**
     * @param {{exeName?:string,title?:string}} wi OS 前台窗口信息
     * @returns {object|null} 命中的规则（已过冷却）
     */
    feed(wi) {
      const ts = now();
      for (const rule of normalized) {
        if (!matchRule(rule, wi)) continue;
        const cd = (rule.cooldownMin || 0) * 60 * 1000;
        if (cd > 0 && lastFired[rule.id] && ts - lastFired[rule.id] < cd) continue;
        lastFired[rule.id] = ts;
        return rule;
      }
      return null;
    },
    /** 更新规则表（设置面板保存后调用）。 */
    update(list) {
      const next = normalizeSceneRules(list);
      normalized.length = 0;
      normalized.push(...next);
    },
    getRules() { return normalized.map((r) => ({ ...r })); },
  };
}

module.exports = {
  DEFAULT_SCENE_RULES,
  normalizeSceneRules,
  normalizeRule,
  matchRule,
  createSceneWatcher,
};
