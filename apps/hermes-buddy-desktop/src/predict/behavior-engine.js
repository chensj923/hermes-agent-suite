'use strict';

/**
 * 行为状态机 + 规则引擎 + 冷却/结晶（纯 JS，零 Electron 依赖，node --test 可测）。
 *
 * 设计要点：
 * - 不 import electron；数据目录由 BehaviorDB 注入。
 * - 入口只接受「行为元数据」事件（windowClass / 节奏 / 鼠标停留 / 剪贴板类型与长度），
 *   绝不接收任何文本内容——隐私边界在入口就守住。
 * - FSM: IDLE → MONITORING（收到事件）→ TRIGGERED（规则命中）→ ANALYZING（截图完成）
 *   → SUGGESTING（模型置信度达标）→ 执行 / COOLDOWN（被拒绝）。
 * - 截图 / 模型 / 用户决策由外部（主进程）在相应时机调用 screenshotTaken / modelResult / userDecision，
 *   本引擎据此推进状态，保持可被 node 直接测试的纯逻辑。
 */

const CONTEXT_WINDOW_MS = 30 * 1000;
const WINDOW_CHANGE_WINDOW_MS = 10 * 1000;
const MAX_RECENT_WINDOWS = 10;

/** 各规则的基准阈值（灵敏度=1 时）。sensitivity>1 降低阈值（更敏感）。 */
const RULE_BASE = {
  // v4.2 扩充 apps：同一语义场景不再只认一个窗口类（原来 writing 只认 Word → 触发率极低）
  word_writing: { pauseMs: 5000, typed: 30, apps: ['word', 'ppt', 'im', 'pdf'] },
  data_entry: { pauseMs: 3000, typed: 20, apps: ['excel'] },
  collecting_material: { clipboardLen: 500, apps: ['browser', 'pdf'] },
  api_lookup: { windowChanges: 3, apps: ['vscode', 'ide', 'terminal'] },
  reading_or_thinking: { mouseIdleMs: 3000, inEditArea: true }
};

/**
 * v4.2 通用兜底：不限制应用，只要「打字停顿够久 + 确实敲过一段」就算写作/录入场景。
 * 阈值比专用规则略高（避免聊天/随手输入被打扰），默认由 config.genericWritingFallback 开关。
 */
const GENERIC_RULE = { pauseMs: 8000, typed: 40, clipboardLen: 1200 };

/**
 * v4.10.31 护栏：用户此刻正在打字 → 绝不触发。
 * 以"距上次按键"这一可靠活跃信号为界；鼠标停留类规则（reading_or_thinking）
 * 自身已要求 mouseIdleMs>3000，无需在此额外拦截。确保桌宠不会在用户
 * 正打字时突然插话（"适当的时候才出言"的硬保证）。
 */
const GUARD_TYPING_MS = 1200;   // 距上次按键 < 此值视为"正在打字"
/**
 * v4.10.31 上下文切换轻提示：切到这些"创作/阅读类"应用即视为一个自然的开口时机
 * （"我正要写/读"），比"等停顿"更早、更自然。刻意排除 browser/ide/terminal/vscode——
 * 那类"浏览器↔IDE 反复横跳"由更具体的 api_lookup 规则接管，避免两者抢同一个首切。
 * 配合全局冷却 + 每应用去重避免刷屏。
 */
const CONTEXT_SWITCH_WORK_APPS = ['word', 'ppt', 'im', 'pdf', 'excel'];

function matchApp(windowClass, logicalNames, appClassMap) {
  if (!windowClass) return false;
  for (const name of logicalNames) {
    const classes = (appClassMap && appClassMap[name]) || [];
    if (classes.includes(windowClass)) return true;
  }
  return false;
}

class BehaviorEngine {
  constructor({ config, db, logger, now } = {}) {
    if (!config) throw new Error('BehaviorEngine 需要 config');
    this.config = config;
    this.db = db || null;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this._nowFn = now || Date.now;
    this.state = 'IDLE';
    this.cooldownUntil = 0;
    this.currentCooldownMs = config.get('cooldownInitialMs') || 5 * 60 * 1000;
    this._pending = null; // { rule, reason, context, intent }
    this._lastContextNudgeClass = null; // 上下文切换轻提示：已提示过的应用类，避免重复
    this._resetContext();
  }

  _now() { return this._nowFn(); }

  _resetContext() {
    this.ctx = {
      windowClass: null,
      // v4.10.1：前台进程名（win-info 解析出 exe 名，如 wps / chrome / explorer）。
      // 只进快照给远端模型做事实参考，不参与本地规则匹配。
      exeName: null,
      typedSincePause: 0,
      lastKeyMs: 0,
      clipboard: null, // { type, length } 仅类型与长度
      recentWindows: [], // [{ t, windowClass }]
      mouseIdleMs: 0,
      inEditArea: false,
      lastActivityMs: 0
    };
  }

  // ---------------- 事件处理 ----------------
  /**
   * 喂入一个行为事件。事件类型：
   *  - { type:'window_change', windowClass, title? }            // title 被忽略（隐私）
   *  - { type:'keypress', windowClass }
   *  - { type:'clipboard', clipboardType, clipboardLength }
   *  - { type:'mouse', mouseIdleMs, inEditArea, region? }
   *  - { type:'tick' }                                          // 定时心跳，用户停笔后无新输入也能评估
   * 返回 { state, shouldScreenshot, reason?, rule?, context?, retired? }
   */
  handleEvent(ev) {
    const now = this._now();
    this._maintain(ev, now);
    if (this.state === 'COOLDOWN' && now >= this.cooldownUntil) this.state = 'IDLE';
    if (!this._canTrigger(now)) return { state: this.state, shouldScreenshot: false };
    const hit = this._evaluate(now);
    if (hit) {
      const { rule, reason } = hit;
      if (this.db && this.db.isRetired(rule)) {
        return { state: this.state, shouldScreenshot: false, retired: true, rule };
      }
      this.state = 'TRIGGERED';
      this._pending = { rule, reason, context: this._snapshot() };
      if (this.db) this.db.recordTrigger(rule);
      return { state: this.state, shouldScreenshot: true, reason, rule, context: this._snapshot() };
    }
    return { state: this.state, shouldScreenshot: false };
  }

  /** 定时心跳：重算打字停顿并重新评估（用户停笔后没有新事件也能触发）。 */
  tick() {
    return this.handleEvent({ type: 'tick' });
  }

  _maintain(ev, now) {
    const e = ev || {};
    this.ctx.lastActivityMs = now;
    switch (e.type) {
      case 'window_change': {
        this.ctx.windowClass = e.windowClass || null;
        // v4.10.1：exe 名跟着窗口切换一起更新（window_change 事件由 hook 的
        // 800ms 前台窗口轮询产生，天然带 exeName）。
        if (e.exeName) this.ctx.exeName = e.exeName;
        this.ctx.typedSincePause = 0;
        this.ctx.recentWindows.push({ t: now, windowClass: e.windowClass || null });
        if (this.ctx.recentWindows.length > MAX_RECENT_WINDOWS) this.ctx.recentWindows.shift();
        this.ctx.mouseIdleMs = 0;
        break;
      }
      case 'keypress': {
        if (e.windowClass) this.ctx.windowClass = e.windowClass;
        this.ctx.typedSincePause += 1;
        this.ctx.lastKeyMs = now;
        this.ctx.mouseIdleMs = 0;
        break;
      }
      case 'clipboard': {
        // 只记类型与长度，不记内容
        this.ctx.clipboard = { type: e.clipboardType || 'unknown', length: Number(e.clipboardLength) || 0 };
        break;
      }
      case 'mouse': {
        if (typeof e.mouseIdleMs === 'number') this.ctx.mouseIdleMs = e.mouseIdleMs;
        if (typeof e.inEditArea === 'boolean') this.ctx.inEditArea = e.inEditArea;
        break;
      }
      case 'tick':
      default:
        break;
    }
  }

  _typingPauseMs(now) {
    return this.ctx.lastKeyMs ? Math.max(0, now - this.ctx.lastKeyMs) : 0;
  }

  _windowChangesLast10s(now) {
    const cutoff = now - WINDOW_CHANGE_WINDOW_MS;
    return this.ctx.recentWindows.filter((w) => w.t >= cutoff).length;
  }

  _canTrigger(now) {
    if (!this.config.get('enabled')) return false;
    if (now < this.cooldownUntil) return false;
    if (this.state !== 'IDLE' && this.state !== 'MONITORING') return false;
    if (this.state === 'IDLE' && this.ctx.lastActivityMs > 0) this.state = 'MONITORING';
    return true;
  }

  _evaluate(now) {
    const cfg = this.config.get();
    const s = cfg.sensitivity && cfg.sensitivity > 0 ? cfg.sensitivity : 1;
    const apps = cfg.appClassMap || {};
    const typingPauseMs = this._typingPauseMs(now);
    const winChanges = this._windowChangesLast10s(now);

    // 护栏：用户此刻正在打字 → 不打断。"正在打字"须有真实按键（lastKeyMs 非空）
    // 且停顿 < 阈值；若本上下文从未按键（lastKeyMs=0），属"无打字信息"而非"刚打字"，
    // 不拦截——否则复制/切窗/鼠标停留类规则会被误杀。确保"适当的时候才出言"。
    if (this.ctx.lastKeyMs && typingPauseMs < GUARD_TYPING_MS) return null;

    // 结晶加成：接受率越高，规则越早弹（降低停顿阈值）。boost ∈ [0,1]，接受率>0.5 才起加成。
    const stats = this.db ? this.db.getCrystallization() : {};
    const boostFor = (rule) => {
      const st = stats[rule];
      if (!st) return 0;
      const rate = st.acceptRate || 0;
      return Math.max(0, Math.min(1, (rate - 0.5) * 2));
    };
    const pauseScale = (base, rule) => (base * (1 - 0.3 * boostFor(rule))) / s;

    // rule1: Word 写作停顿
    if (matchApp(this.ctx.windowClass, RULE_BASE.word_writing.apps, apps)
        && typingPauseMs > pauseScale(RULE_BASE.word_writing.pauseMs, 'word_writing')
        && this.ctx.typedSincePause > RULE_BASE.word_writing.typed / s) {
      return { rule: 'word_writing', reason: 'word_writing' };
    }
    // rule3: Excel 数据输入停顿
    if (matchApp(this.ctx.windowClass, RULE_BASE.data_entry.apps, apps)
        && typingPauseMs > pauseScale(RULE_BASE.data_entry.pauseMs, 'data_entry')
        && this.ctx.typedSincePause > RULE_BASE.data_entry.typed / s) {
      return { rule: 'data_entry', reason: 'data_entry' };
    }
    // rule2: 复制了大段文本。浏览器/PDF 里 500 字即算（典型"收集资料"）；
    //        其它应用（IDE 复制代码、微信复制长文）用更高门槛 1200，避免误打扰。
    if (this.ctx.clipboard && this.ctx.clipboard.type === 'text') {
      const len = this.ctx.clipboard.length;
      const inBrowser = matchApp(this.ctx.windowClass, RULE_BASE.collecting_material.apps, apps);
      if (inBrowser && len > RULE_BASE.collecting_material.clipboardLen / s) {
        return { rule: 'collecting_material', reason: 'collecting_material' };
      }
      if (cfg.genericWritingFallback !== false && len > GENERIC_RULE.clipboardLen / s) {
        return { rule: 'collecting_material', reason: 'generic_clipboard' };
      }
    }
    // rule4: IDE 反复切窗（注：VSCode 与 Chrome 同窗类，真正区分靠 exe 名，
    //         hook 层应给 VSCode 传一个独立 class 如 'VSCodeIDE'，否则会有误触发）
    if (winChanges >= Math.round(RULE_BASE.api_lookup.windowChanges / s)) {
      const recentClasses = this.ctx.recentWindows.slice(-MAX_RECENT_WINDOWS).map((w) => w.windowClass);
      if (recentClasses.some((wc) => matchApp(wc, RULE_BASE.api_lookup.apps, apps))) {
        return { rule: 'api_lookup', reason: 'api_lookup' };
      }
    }
    // rule4b: 浏览器/文档与 IDE/终端之间反复横跳 → 也在查资料
    if (winChanges >= Math.max(2, Math.round(RULE_BASE.api_lookup.windowChanges / s))) {
      const recentClasses = this.ctx.recentWindows.slice(-MAX_RECENT_WINDOWS).map((w) => w.windowClass);
      const sawBrowser = recentClasses.some((wc) => matchApp(wc, ['browser', 'pdf'], apps));
      const sawCode = recentClasses.some((wc) => matchApp(wc, ['vscode', 'ide', 'terminal'], apps));
      if (sawBrowser && sawCode) return { rule: 'api_lookup', reason: 'api_lookup' };
    }
    // rule7（v4.10.31 事件驱动）：切到工作类应用 = 自然的开口时机，比"等停顿"更早更自然。
    //   切换动作本身就是"用户在工作"的信号（typedSincePause 在 window_change 时已被重置，
    //   故不依赖它判断）。"正在打字"由上方护栏拦截；每应用去重 + 全局冷却防刷屏。
    //   放在 api_lookup 等具体场景规则之后，作为"没匹配到具体场景"时的兜底轻提示。
    {
      const recent = this.ctx.recentWindows.slice(-2);
      if (recent.length >= 2 && recent[1].windowClass && recent[1].windowClass !== recent[0].windowClass) {
        const entered = recent[1].windowClass;
        if (matchApp(entered, CONTEXT_SWITCH_WORK_APPS, apps)
            && entered !== this._lastContextNudgeClass) {
          this._lastContextNudgeClass = entered;
          return { rule: 'context_switch', reason: 'context_switch' };
        }
      }
    }
    // rule5: 鼠标编辑区停留
    if (this.ctx.mouseIdleMs > RULE_BASE.reading_or_thinking.mouseIdleMs / s
        && this.ctx.inEditArea === true) {
      return { rule: 'reading_or_thinking', reason: 'reading_or_thinking' };
    }
    // rule6（v4.2 通用兜底）：任意窗口里敲了一段后长时间停笔——WPS/记事本/微信/浏览器表单/未知应用都能命中。
    // 前提：不能已经命中过上面的专用规则（专用规则更精确，优先级更高）。
    if (cfg.genericWritingFallback !== false
        && typingPauseMs > pauseScale(GENERIC_RULE.pauseMs, 'word_writing')
        && this.ctx.typedSincePause > GENERIC_RULE.typed / s) {
      return { rule: 'word_writing', reason: 'generic_pause' };
    }
    return null;
  }

  _snapshot() {
    return {
      windowClass: this.ctx.windowClass,
      // v4.10.1：把前台进程名带给远端模型——windowClass 是 Win32 类名
      // （如 Windows.UI.Core.CoreWindow），远端模型看不懂；exe 名
      // （wps / winword / explorer）才是它能直接理解的事实。
      exeName: this.ctx.exeName,
      typedSincePause: this.ctx.typedSincePause,
      typingPauseMs: this._typingPauseMs(this._now()),
      clipboard: this.ctx.clipboard,
      mouseIdleMs: this.ctx.mouseIdleMs,
      inEditArea: this.ctx.inEditArea
    };
  }

  // ---------------- 状态推进（外部在截图 / 模型 / 用户决策后调用） ----------------
  /** 截图完成 → ANALYZING（等待模型结果）。 */
  screenshotTaken() {
    if (this.state !== 'TRIGGERED') return { state: this.state };
    this.state = 'ANALYZING';
    return { state: this.state };
  }

  /** 模型返回结果。confidence >= 阈值 → SUGGESTING；否则视为「不该打扰」→ IDLE。 */
  modelResult({ intent, confidence } = {}) {
    if (this.state !== 'ANALYZING') return { state: this.state };
    const thr = this.config.get('confidenceThreshold') || 0.6;
    if (typeof confidence === 'number' && confidence >= thr) {
      this.state = 'SUGGESTING';
      if (this._pending) this._pending.intent = intent;
      return { state: this.state, suggest: true, intent, confidence };
    }
    // 模型没把握 → 不弹窗、不计入拒绝，回到 IDLE
    this.state = 'IDLE';
    this._pending = null;
    return { state: this.state, suggest: false, intent, confidence };
  }

  /** 模型推理超时/失败 → IDLE（不影响冷却，不计入拒绝）。 */
  modelTimeout() {
    if (this.state === 'ANALYZING') { this.state = 'IDLE'; this._pending = null; }
    return { state: this.state };
  }

  /**
   * 用户决策：accepted=true 执行并重置冷却为初始值；
   * accepted=false 计入拒绝、冷却翻倍（上限 cooldownMaxMs），进入 COOLDOWN。
   */
  userDecision(accepted) {
    if (this.state !== 'SUGGESTING') return { state: this.state };
    const rule = this._pending ? this._pending.rule : null;
    if (rule && this.db) this.db.recordDecision(rule, Boolean(accepted));
    const now = this._now();
    if (accepted) {
      const init = this.config.get('cooldownInitialMs') || 5 * 60 * 1000;
      this.currentCooldownMs = init;
      this.cooldownUntil = now + init;
      this.state = 'IDLE';
      this._pending = null;
      return { state: this.state, accepted: true };
    }
    this.currentCooldownMs = Math.min(
      this.currentCooldownMs * 2,
      this.config.get('cooldownMaxMs') || 30 * 60 * 1000
    );
    this.cooldownUntil = now + this.currentCooldownMs;
    this.state = 'COOLDOWN';
    this._pending = null;
    return { state: this.state, accepted: false };
  }

  /** 用户无视（10s 超时未点）→ 按拒绝处理，推进冷却。 */
  userIgnored() {
    return this.userDecision(false);
  }

  /** 当前待执行的建议（供 action-executor 取用）。 */
  pending() {
    return this._pending;
  }

  /** 复位（一键关闭 / 重置）。 */
  reset() {
    this.state = 'IDLE';
    this.cooldownUntil = 0;
    this.currentCooldownMs = this.config.get('cooldownInitialMs') || 5 * 60 * 1000;
    this._pending = null;
    this._resetContext();
  }
}

module.exports = { BehaviorEngine, RULE_BASE };
