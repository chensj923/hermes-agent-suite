'use strict';

/**
 * 预测模式编排器（Electron 主进程专用，但除 capture/panel 外均可在 node 下注入 fake 测试）。
 *
 * 把分散的纯逻辑模块串成完整流水线：
 *   钩子捕获输入 → BehaviorEngine 评估规则 → 命中则
 *   截图 → 本地/远端多模态模型判断意图 → 置信度达标则
 *   浮窗展示建议 → 用户决策（生成/稍后/不再提示）→ 动作执行（剪贴板回填）。
 *
 * 设计要点：
 *   - 所有外部依赖（capture / modelRunner / panel / actionExecutor / channel / resolveWindow）
 *     通过构造参数注入，使本文件可在 node --test 下用 fake 完整验证流水线。
 *   - 严格守护隐私：截图只进 _analyze，绝不落盘；行为上下文只含元数据。
 *   - 流水线串行（_processing 互斥），避免二次触发重入。
 *   - 一键关闭立即停钩子、停模型、清上下文。
 */

const path = require('path');
const { PredictConfig } = require('./config');
const { BehaviorEngine } = require('./behavior-engine');
const { BehaviorDB } = require('./behavior-db');
const { createBehaviorHooks, detectAntivirus } = require('./behavior-hooks');
const { ActionExecutor } = require('./action-executor');

/** v4.8.2：hybrid 模式下本地模型只是「触发筛选器」。
 * v4.9.0：实测 CPU 跑 Qwen2.5-VL-3B 一轮推理要 11~15s（prompt eval 8~11s + 生成 3~4s，
 * 见 buddy.log 的 slot print_timing），原 8s 窗口必然掐掉本地、白等一轮再走远端。
 * 放宽到 18s 让本地筛选真正跑完：判「无需打扰」就地结束，判「值得打扰」再交给远端。 */
const LOCAL_SCREEN_TIMEOUT_MS = 18000;

/** v4.8.6：控制器级模型推断超时。remote/hybrid 与通道层 30s 对齐，避免真实推理 20s+ 时提前降级。 */
const REMOTE_ANALYZE_TIMEOUT_MS = 30000;

/** v4.8.4：local 模式全在本机跑 2GB VLM，给 45s 更宽松。 */
const LOCAL_ANALYZE_TIMEOUT_MS = 45000;

/** v4.8.8：_withTimeout 轨迹回调（由控制器构造时注入 logger），用于定位「30s 定时器未触发」问题。 */
let _timeoutTrace = null;

/** Promise 超时包装器。 */
function _withTimeout(promise, ms, message) {
  if (_timeoutTrace) { try { _timeoutTrace('timer-set', { ms, message }); } catch (_) {} }
  let timer = null;
  // v4.8.9：原实现不清理定时器——主 Promise 早已 settle 后，30s 定时器仍会
  // 触发并 reject（被 race 吞掉但留下噪声日志、且定时器一直挂着）。
  // 这里在主 Promise settle 时立刻 clearTimeout。
  const guarded = Promise.resolve(promise).finally(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        // v4.8.8 插桩：这个回调若不执行，说明主进程定时器本身没触发
        if (_timeoutTrace) { try { _timeoutTrace('timer-fired', { ms, message }); } catch (_) {} }
        reject(new Error(message));
      }, ms);
    }),
  ]);
}

/** 规则 → 无模型时的兜底建议模板（model='none' 时使用）。 */
const RULE_TEMPLATE = {
  word_writing: '要不要我帮你续写或润色这段文字？',
  data_entry: '这个字段需要我帮忙填吗？',
  collecting_material: '复制的资料要我帮你整理成笔记吗？',
  api_lookup: '卡在接口/报错上了？把报错贴给我，我帮你查。',
  reading_or_thinking: '需要我帮你梳理思路或找资料吗？',
};

/** 主动预测（点桌宠/点按钮）且连窗口类型都推断不出来时的通用话术。 */
const PROACTIVE_TEMPLATE = '我看了一眼屏幕——需要我帮你做点什么吗？';

class PredictController {
  /**
   * @param {object} opts
   * @param {string} opts.appDir          userData 目录（行为日志/config 落盘处）
   * @param {object} [opts.logger]
   * @param {object} [opts.capture]       截图器（注入；默认 null 走 electron capture）
   * @param {object} [opts.modelRunner]   LocalModelRunner 实例（注入；默认按配置懒建）
   * @param {object} [opts.panel]         PredictPanel 实例（注入）
   * @param {object} [opts.actionExecutor] ActionExecutor 实例（注入）
   * @param {object} [opts.channel]       通道客户端（远端 predict 用，可选）
   * @param {function} [opts.resolveChannel] ()=>ChannelClient|null  惰性取通道（连接后才有的用）
   * @param {function} [opts.resolveWindow] async()=>({windowClass,title,exeName})|null
   * @param {function} [opts.buildRunner] (config)=>LocalModelRunner  懒建 runner 的工厂
   * @param {function} [opts.predicateFn] (behaviorContext)=>Promise<{intent,confidence,suggestion,reason}>  远端模型用
   */
  constructor(opts = {}) {
    if (!opts.appDir) throw new Error('PredictController 需要 appDir');
    this.appDir = opts.appDir;
    this.logger = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.capture = opts.capture || null;
    this.modelRunner = opts.modelRunner || null;
    this.panel = opts.panel || null;
    this.actionExecutor = opts.actionExecutor || null;
    this.channel = opts.channel || null;
    this._resolveChannel = opts.resolveChannel || null;
    this.resolveWindow = opts.resolveWindow || (async () => null);
    this.buildRunner = opts.buildRunner || null;
    this._predictFn = opts.predictFn || null;  // 远端/测试用

    this.config = new PredictConfig({ dataDir: path.join(this.appDir, 'predict') });
    this.db = new BehaviorDB({ dataDir: path.join(this.appDir, 'predict') });
    this.engine = new BehaviorEngine({ config: this.config, db: this.db, logger: this.logger });
    this.hooks = null;
    this._processing = false;
    this._enabled = false;
    this._degraded = false;   // v4.8.5：防止 analyze 失败 + 面板安全网并发重复降级
    this._lastRule = null;    // v4.8.9：最近一次触发规则，供超时降级兜底
    this._remoteInFlight = false;  // v4.8.9：是否有远端请求在飞（防请求堆积）
    this._remotePromise = null;
    this._pipelineSeq = 0;    // v4.8.8：流水线所有权序列，防止并发 finally 互清 _processing 锁
    // v4.8.8 插桩：把 _withTimeout 定时器的设置/触发轨迹写进日志
    _timeoutTrace = (ev, info) => {
      try { this.logger.info('predict-timeout-trace', { ev, ...info }); } catch (_) {}
    };
  }

  // ---------------- 生命周期 ----------------

  /** 是否具备启用条件（已授权 + 已启用 + 杀软不阻断）。 */
  _canEnable() {
    return Boolean(this.config.get('authorized') && this.config.get('enabled'));
  }

  /** 启用：初始化钩子并启动。未授权则抛错（无降级）。 */
  async enable() {
    if (!this.config.get('authorized')) {
      throw new Error('预测模式未授权，无法启用');
    }
    this.config.set({ enabled: true });
    this.hooks = createBehaviorHooks({
      config: this.config,
      engine: this.engine,
      db: this.db,
      logger: this.logger,
      resolveWindow: this.resolveWindow,
      onTrigger: (r) => this._onTrigger(r),
    });
    await this.hooks.start();
    this._enabled = true;
    // v4.8.2：后台预热本地模型，让 local/hybrid 的下次触发不走冷启动
    this.warmLocalModel().catch(() => {});
    this.logger.info('predict-enabled');
    return this.getStatus();
  }

  /** 停用：停钩子、停模型、清上下文。 */
  async disable() {
    if (this.hooks) { try { this.hooks.stop(); } catch (_) {} this.hooks = null; }
    if (this.modelRunner) { try { await this.modelRunner.stop(); } catch (_) {} this.modelRunner = null; }
    if (this.panel) { try { this.panel.destroy(); } catch (_) {} }
    this._enabled = false;
    this.engine.reset();
    this.logger.info('predict-disabled');
    return this.getStatus();
  }

  /** 一键关闭（用户从浮窗/设置点「关」）：停止并持久化 enabled=false。 */
  async oneClickOff() {
    this.config.set({ enabled: false, authorized: false });
    return this.disable();
  }

  isEnabled() { return this._enabled; }

  // ---------------- 触发流水线 ----------------

  /** 钩子命中规则时由 hooks 回调。 */
  async _onTrigger(triggerResult) {
    if (this._processing) return;           // 已有流水线在跑，丢弃本次触发
    if (!triggerResult || !triggerResult.shouldScreenshot) return;
    this._processing = true;
    this._degraded = false;                 // v4.8.5：每次新触发重置降级标记
    const mySeq = ++this._pipelineSeq;      // v4.8.8：标记本流水线所有权
    try {
      // 1) 进入 ANALYZING
      const r1 = this.engine.screenshotTaken();
      if (r1.state !== 'ANALYZING') return;

      // 2) 截图（仅内存 buffer，不落盘）
      let imageBase64 = null;
      if (this.capture) {
        try {
          const shot = await this.capture.captureActiveWindow({ skipName: /hermes buddy|hermes-buddy/i });
          imageBase64 = shot && shot.base64;
        } catch (e) {
          this.logger.warn('predict-capture-failed', { error: e.message });
        }
      }

      // 3) 行为上下文（只元数据，绝不带文本/标题内容）
      const ctx = this.engine.pending() ? this.engine.pending().context : this.engine._snapshot();
      const rule = triggerResult.rule;
      // v4.8.9：记住最近一次触发的规则，供超时降级兜底（engine.pending() 在
      // 超时回调里常已清空，导致降级弹窗 intent 退化成 unknown、建议泛化）。
      if (rule) this._lastRule = rule;
      const behaviorContext = Object.assign({ rule }, ctx);

      // 4) 模型判断意图（本地 / 远端 / 本地+远端）
      //    注意：三种模式都走 _analyze；只有模型真的拿不到结果时才降级为规则模板。
      //    （旧实现把 remote 也判成「没有模型路径」，远端模式其实从未真正调用过通道。）
      const mode = this.config.get('model');
      let result;
      if (mode === 'none') {
        result = {
          intent: rule,
          confidence: 0.7,
          suggestion: (RULE_TEMPLATE[rule] || '需要我帮你做点什么吗？'),
          reason: '基于行为规则的本地预判',
        };
      } else {
        this._showThinking('思考中…');
        try {
          result = await this._analyze(behaviorContext, imageBase64);
        } catch (e) {
          // v4.8.5：模型不可用（本地引擎未安装/推理超时、远端通道未连）→ 降级为规则模板弹窗。
          // 旧行为是 modelTimeout()+return 静默丢弃，导致用户只看到转圈；现在必须给出可见输出。
          this.logger.warn('predict-analyze-failed, degrade to rule template', { error: e.message });
          await this._degradeToRule(behaviorContext, '模型未就绪，已降级为行为规则预判：' + e.message);
          return;
        }
      }
      if (!result) { this.engine.modelTimeout(); return; }
      // v4.8.5：若 analyze 失败分支已降级弹窗，后续不再重复展示
      if (this._degraded) {
        this.logger.info('predict-already-degraded');
        return;
      }
      // 面板 thinking 安全网可能已把 _processing 重置，避免超时后再弹窗
      if (!this._processing) {
        this.logger.info('predict-pipeline-aborted-after-timeout');
        return;
      }

      // 5) 引擎按置信度门槛决定是否弹窗
      const r2 = this.engine.modelResult({
        intent: result.intent,
        confidence: result.confidence,
      });
      if (!r2.suggest) {
        // 模型觉得不该打扰 → 不弹窗，回到 IDLE
        return;
      }

      // 6) 浮窗展示 + 等决策
      const suggestion = {
        intent: result.intent,
        suggestion: result.suggestion || RULE_TEMPLATE[result.intent] || '需要我帮你做点什么吗？',
        reason: result.reason || '',
        confidence: result.confidence,
        action: this._buildAction(result.intent, result.suggestion),
      };
      let choice = 'later';
      if (this.panel) {
        choice = await this.panel.show(suggestion);
      }
      this._applyDecision(choice, rule, suggestion);
    } catch (e) {
      this.logger.error('predict-pipeline-error', { error: e.message });
      try { this.engine.modelTimeout(); } catch (_) {}
    } finally {
      // v4.8.8：只有自己仍是当前流水线时才释放锁；否则说明有新流水线/超时回调已接管
      if (this._pipelineSeq === mySeq) {
        this._processing = false;
        // v4.9.1：所有"结束但不弹窗"的早退路径（置信度没过门槛 / 没拿到结果 /
        // 已降级 / 超时中断）都要收走 thinking 态，否则 45s 安全网会误降级。
        if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
      }
      this.logger.info('predict-pipeline-done', { seq: mySeq, owner: this._pipelineSeq === mySeq });
    }
  }

  /**
   * v4.8.5：模型 analyze 失败或面板 thinking 安全网触发时，降级为规则模板弹窗。
   * 避免用户盯着「思考中…」空转却没有任何输出。
   *
   * @param {object} behaviorContext 含 rule 的行为上下文
   * @param {string} reason 降级原因，显示在 reason 行
   * @returns {Promise<'generate'|'later'|'never'>}
   */
  async _degradeToRule(behaviorContext, reason) {
    if (this._degraded) return 'later';
    this._degraded = true;
    const rule = behaviorContext && behaviorContext.rule;
    const template = RULE_TEMPLATE[rule] || '需要我帮你做点什么吗？';
    const suggestion = {
      intent: rule || 'unknown',
      suggestion: template,
      reason: (reason || '模型未就绪，已降级为行为规则预判'),
      confidence: 0.7,
      action: this._buildAction(rule, template),
    };
    // 推进引擎状态到 SUGGESTING，让后续 userDecision 能正确记录接受/拒绝并回到 IDLE
    this.engine.modelResult({ intent: suggestion.intent, confidence: suggestion.confidence });
    if (!this.panel) { this.logger.warn('predict-degrade-no-panel'); return 'later'; }
    this.logger.info('predict-degrade-show', { intent: suggestion.intent, reason: suggestion.reason });
    const choice = await this.panel.show(suggestion);
    this.logger.info('predict-degrade-choice', { choice });
    this._applyDecision(choice, rule, suggestion);
    return choice;
  }

  /** 把用户决策写回引擎 + 执行动作。 */
  _applyDecision(choice, rule, suggestion) {
    if (choice === 'generate') {
      this.engine.userDecision(true);
      if (this.actionExecutor && suggestion && suggestion.action) {
        this.actionExecutor.execute(suggestion.action).catch((e) => this.logger.warn('action-failed', { error: e.message }));
      } else if (this.actionExecutor && suggestion && suggestion.suggestion) {
        // 没有显式 action 时默认把建议文本回填剪贴板
        this.actionExecutor.execute({ type: 'clipboard', text: suggestion.suggestion }).catch((e) => this.logger.warn('action-failed', { error: e.message }));
      }
    } else if (choice === 'never') {
      // 不再提示：先按拒绝计入冷却（recordDecision 记一次拒绝），再退休该规则。
      // 注意：不要再次 recordDecision，否则拒绝数会被重复计数。
      this.engine.userDecision(false);
      if (this.db) { const s = this.db._stat(rule); s.retired = true; this.db._saveCrystal(); }
    } else {
      // later / 超时：按拒绝计入冷却（不退休）
      this.engine.userDecision(false);
    }
  }

  /** 构造动作（当前默认剪贴板回填建议文本）。 */
  _buildAction(intent, suggestionText) {
    if (!suggestionText) return { type: 'noop' };
    return { type: 'clipboard', text: suggestionText };
  }

  /** 本地或远端模型推断。mode: local | remote | hybrid */
  async _analyze(behaviorContext, imageBase64) {
    const mode = this.config.get('model');
    let analyzePromise;
    let timeoutMs;
    let timeoutMsg;
    if (mode === 'remote') {
      analyzePromise = this._remoteAnalyze(behaviorContext, imageBase64, null);
      timeoutMs = REMOTE_ANALYZE_TIMEOUT_MS;
      timeoutMsg = '远端模型响应超时';
    } else if (mode === 'hybrid') {
      analyzePromise = this._hybridAnalyze(behaviorContext, imageBase64);
      timeoutMs = REMOTE_ANALYZE_TIMEOUT_MS;
      timeoutMsg = '模型响应超时';
    } else {
      analyzePromise = this._localAnalyze(behaviorContext, imageBase64);
      timeoutMs = LOCAL_ANALYZE_TIMEOUT_MS;
      timeoutMsg = '本地模型推理超时';
    }
    return _withTimeout(analyzePromise, timeoutMs, timeoutMsg);
  }

  /** 本地小模型推断（判断意图 + 建议）。 */
  async _localAnalyze(behaviorContext, imageBase64) {
    if (this._predictFn) return this._predictFn(behaviorContext, imageBase64);
    const runner = this._runner();
    if (!runner) throw new Error('本地模型未就绪（请先安装 VLM 引擎）');
    return runner.analyze({ imageBase64, behaviorContext });
  }

  /** 远端大模型推断（思考 + 解答）。localJudgment 可选：混合模式下把本地判断作为提示带上。 */
  async _remoteAnalyze(behaviorContext, imageBase64, localJudgment) {
    let ch = this.channel;
    if (!ch && this._resolveChannel) {
      try { ch = this._resolveChannel(); } catch (_) { ch = null; }
    }
    if (ch) {
      // v4.8.9：远端请求去重。日志实测触发可密集到 4~10s 一次，每次都带整屏
      // 截图打远端；服务端串行处理 → 请求排队，最后一条要等 20s+ 才返回，
      // 表现就是「思考半天然后超时」。若已有在飞的远端请求，复用它的结果，
      // 而不是再发一张图把队列排得更长。
      if (this._remoteInFlight && this._remotePromise) {
        this.logger.info('predict-remote-reuse-inflight');
        return this._remotePromise;
      }
      const ctx = localJudgment
        ? Object.assign({}, behaviorContext, {
          localJudgment: { intent: localJudgment.intent, confidence: localJudgment.confidence },
          stage: 'deep_think',
        })
        : behaviorContext;
      this._remoteInFlight = true;
      this._remotePromise = ch.predict(ctx, imageBase64);
      try {
        return await this._remotePromise;
      } finally {
        this._remoteInFlight = false;
        this._remotePromise = null;
      }
    }
    // 通道还没连上：抛错交给上层——remote 模式降级为规则预判，hybrid 模式退回本地结论。
    // （早期版本在这里直接返回兜底模板，导致混合模式下本地结论被通用话术覆盖。）
    throw new Error('远端通道未连接');
  }

  /**
   * 混合模式（v4.4 / v4.8.2）：本地小模型只负责判断「该不该触发」，
   * 判定值得打扰后再把上下文交给远端大模型做真正的思考与解答。
   *
   * v4.8.2 关键修正：本地模型只当「热缓存」用。默认 hybrid 模式下若本地 2GB VLM
   * 还没启动，冷启动会拖慢首条预测数十秒；因此未热启/推理超时时直接跳过筛选，
   * 先走远端，同时后台默默预热本地模型供下次触发使用。
   */
  async _hybridAnalyze(behaviorContext, imageBase64) {
    const threshold = Number(this.config.get('confidenceThreshold')) || 0.6;
    let localResult = null;
    if (this._isLocalWarm()) {
      try {
        localResult = await _withTimeout(
          this._localAnalyze(behaviorContext, imageBase64),
          LOCAL_SCREEN_TIMEOUT_MS,
          '本地筛选模型超时'
        );
      } catch (e) {
        // 本地筛选模型推理失败/超时：不经筛选，直接交给远端思考
        this.logger.warn('hybrid-local-screen-skipped', { error: e.message });
      }
    } else {
      this.logger.info('hybrid-local-cold, skip to remote');
    }
    if (localResult && Number(localResult.confidence) < threshold) {
      // 本地小模型判断「此刻不该打扰」：到此为止，不再惊动远端
      return Object.assign({}, localResult, { reason: '本地模型判断：此刻无需打扰', source: 'local' });
    }
    try {
      const remoteResult = await this._remoteAnalyze(behaviorContext, imageBase64, localResult);
      if (remoteResult) {
        return Object.assign({}, remoteResult, {
          reason: '本地判断触发 + 远端思考解答' + (remoteResult.reason ? '｜' + remoteResult.reason : ''),
          source: 'hybrid',
        });
      }
    } catch (e) {
      this.logger.warn('hybrid-remote-failed', { error: e.message });
    }
    // 远端不可用：退回本地结论
    if (localResult) {
      return Object.assign({}, localResult, {
        reason: '远端不可用，已退回本地结论' + (localResult.reason ? '｜' + localResult.reason : ''),
        source: 'local',
      });
    }
    throw new Error('本地模型未就绪且远端通道未连接');
  }

  /** 懒建 LocalModelRunner（默认按 llama-engine 查找）；测试可注入 this.modelRunner。 */
  _runner() {
    if (this.modelRunner) return this.modelRunner;
    if (!this.buildRunner) return null;
    this.modelRunner = this.buildRunner(this.config);
    return this.modelRunner;
  }

  /** 本地模型是否已热启（hybrid 模式用它决定是否参与筛选）。 */
  _isLocalWarm() {
    // 测试注入 predictFn 时视为「已就绪」，否则看真实 runner 是否已启动
    if (typeof this._predictFn === 'function') return true;
    return !!(this.modelRunner && this.modelRunner.started);
  }

  /**
   * v4.7：本地模型文件被换掉 —— 停掉旧的 llama-server 进程并丢弃 runner 缓存，
   * 下次分析会用新的 config（新 GGUF / 新 mmproj）重新拉起，避免老模型还占着显存和内存。
   */
  resetRunner() {
    if (this.modelRunner && typeof this.modelRunner.stop === 'function') {
      try { this.modelRunner.stop(); } catch (_) {}
    }
    this.modelRunner = null;
    return { ok: true };
  }

  /** 当前选择的模式是否要走模型（remote 模式本身没有本地路径）。 */
  _hasModelPath() {
    return this.config.get('model') !== 'remote';
  }

  /**
   * 走模型分析时先弹「思考中」浮窗（带转圈 loading），分析完由 panel.show 换成结果。
   * 纯规则降级（不走模型）不弹，避免秒闪。
   */
  _showThinking(text) {
    if (!this.panel || typeof this.panel.showThinking !== 'function') return;
    try { this.panel.showThinking(text || '思考中…'); } catch (_) {}
  }

  // ---------------- 配置 / 状态 ----------------

  getStatus() {
    const cooldownRemainingMs = Math.max(0, this.engine.cooldownUntil - Date.now());
    return {
      enabled: this._enabled,
      authorized: this.config.get('authorized'),
      model: this.config.get('model'),
      sensitivity: this.config.get('sensitivity'),
      state: this.engine.state,
      cooldownRemainingMs,
      processing: this._processing,
      av: detectAntivirus().map((a) => a.name),
      crystallization: this.db.getCrystallization(),
      // v4.2
      proactivePatrolMinutes: Number(this.config.get('proactivePatrolMinutes')) || 0,
      genericWritingFallback: this.config.get('genericWritingFallback') !== false,
    };
  }

  setModel(model) {
    this.config.set({ model });
    // 切换模型后释放旧 runner，下次触发重新懒建
    if (this.modelRunner) { try { this.modelRunner.stop(); } catch (_) {} this.modelRunner = null; }
    // v4.8.2：切到 local/hybrid 时后台预热本地模型，避免首条触发被冷启动拖慢
    if (model !== 'remote') {
      this.warmLocalModel().catch(() => {});
    }
    return this.getStatus();
  }

  /**
   * v4.8.2：后台预热本地模型。启用 / 切到 local/hybrid 时调用，不阻塞主流程。
   * 只有本地模型已安装且未启动时才拉起；remote 模式不预热。
   */
  async warmLocalModel() {
    const mode = this.config.get('model');
    if (mode === 'remote') return { ok: false, reason: 'remote 模式无需预热本地模型' };
    const runner = this._runner();
    if (!runner) return { ok: false, reason: '本地模型未安装' };
    if (runner.started) return { ok: true, reason: '本地模型已就绪' };
    try {
      await runner.start();
      return { ok: true, reason: '本地模型预热完成' };
    } catch (e) {
      this.logger.warn('predict-warm-local-failed', { error: e.message });
      return { ok: false, reason: e.message };
    }
  }

  /**
   * v4.8.5：面板 thinking 安全网触发时由主进程回调。
   * 如果当前流水线还没出结果，立刻降级为规则模板弹窗，避免用户只看到转圈却没有任何输出。
   * 底层未完成的模型 Promise 会在后台自行熄灭，不会再次弹窗。
   */
  onThinkingTimeout() {
    this.logger.warn('predict-thinking-timeout-controller');
    // v4.8.8：作废在跑的流水线所有权，避免其 finally 把 _processing 又置回 true/误清
    this._pipelineSeq++;
    if (this._degraded) {
      this._processing = false;
      try { this.engine.modelTimeout(); } catch (_) {}
      return;
    }
    const pending = this.engine.pending();
    const ctx = pending ? pending.context : (this.engine._snapshot ? this.engine._snapshot() : {});
    // v4.8.9：pending 已清空时退回最近一次触发规则，避免降级弹窗 intent=unknown
    const rule = (pending && pending.rule) || this._lastRule || null;
    const behaviorContext = Object.assign({ rule }, ctx);
    // 先重置锁，让 _degradeToRule 弹窗不会被 _onTrigger 的互斥挡住
    this._processing = false;
    return this._degradeToRule(behaviorContext, '模型响应超时，已切换为本地规则建议');
  }

  setSensitivity(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error('灵敏度必须为正数');
    this.config.set({ sensitivity: n });
    return this.getStatus();
  }

  setAuthorized(v) {
    this.config.set({ authorized: Boolean(v) });
    return this.getStatus();
  }

  getCrystallization() {
    return this.db.getCrystallization();
  }

  /**
   * v4.2 主动预测：不依赖行为规则命中、也不受冷却限制，立刻「看一眼屏幕」给建议。
   * 用于桌宠点击 / 设置页「现在预测一次」——用户主动要求时不该被规则与冷却挡住。
   *
   * @returns {Promise<{shown:boolean, choice?:string, intent?:string, suggestion?:string, reason?:string}>}
   */
  async predictNow() {
    if (!this.config.get('authorized')) throw new Error('预测模式未授权');
    if (!this.config.get('enabled')) throw new Error('预测模式未启用');
    if (this._processing) return { shown: false, busy: true, reason: '上一次分析还在进行中' };
    this._processing = true;
    const mySeq = ++this._pipelineSeq;   // v4.8.8：所有权序列
    try {
      // 跳过 TRIGGERED：直接进入 ANALYZING（截图 → 模型）
      this.engine.state = 'ANALYZING';

      let imageBase64 = null;
      if (this.capture) {
        try {
          const shot = await this.capture.captureActiveWindow({ skipName: /hermes buddy|hermes-buddy/i });
          imageBase64 = shot && shot.base64;
        } catch (e) {
          this.logger.warn('predict-now-capture-failed', { error: e.message });
        }
      }

      const ctx = this.engine._snapshot();
      const rule = this._inferRuleFromContext(ctx);
      const behaviorContext = Object.assign({ rule, proactive: true }, ctx);

      const mode = this.config.get('model');
      let result;
      if (mode === 'none') {
        result = {
          intent: rule || 'none',
          confidence: 0.7,
          suggestion: (rule && RULE_TEMPLATE[rule]) || PROACTIVE_TEMPLATE,
          reason: '主动预测：根据当前窗口与操作节奏推断（未启用模型）',
        };
      } else {
        this._showThinking('思考中…');
        try {
          result = await this._analyze(behaviorContext, imageBase64);
        } catch (e) {
          this.logger.warn('predict-now-analyze-failed, degrade', { error: e.message });
          result = {
            intent: rule || 'none',
            confidence: 0.7,
            suggestion: (rule && RULE_TEMPLATE[rule]) || PROACTIVE_TEMPLATE,
            reason: '主动预测：模型未就绪，已降级为窗口类型推断（' + e.message + '）',
          };
        }
      }
      if (!result) { this.engine.modelTimeout(); return { shown: false, reason: '没有拿到模型结果' }; }
      if (!this._processing) {
        this.logger.info('predict-now-aborted-after-timeout');
        return { shown: false, reason: '分析已超时中断' };
      }

      // 主动预测：用户是自己点的 → 必须给答案（v4.9.2）。
      // v4.9.0 实测：远端对「只写了个标题」这类写作开场会给出低置信度，
      // 被 0.6 门槛拦下后只回一句「没什么需要帮忙的」，用户观感就是
      // 「判断草率、思考完就跳掉」。现在置信度不过门槛也弹窗：
      // 模型给不出明确意图时，退回场景规则推断（Word→word_writing 等）给建议。
      const r2 = this.engine.modelResult({ intent: result.intent, confidence: result.confidence });
      const suggestion = {
        intent: result.intent,
        suggestion: result.suggestion || (result.intent && RULE_TEMPLATE[result.intent]) || PROACTIVE_TEMPLATE,
        reason: result.reason || '',
        confidence: result.confidence,
        action: this._buildAction(result.intent, result.suggestion),
      };
      if (!r2.suggest) {
        const weakIntent = !result.intent || result.intent === 'none' || Number(result.confidence) < 0.3;
        if (weakIntent && rule && RULE_TEMPLATE[rule]) {
          // 模型不确定 → 用场景规则兜底，别让用户白等一场
          suggestion.intent = rule;
          suggestion.suggestion = RULE_TEMPLATE[rule];
          suggestion.reason = (result.reason ? result.reason + '；' : '') + '已按当前场景给出建议';
        }
        // 不再 return：用户主动要的预测，哪怕低置信度也把建议摆出来
      }

      let choice = 'later';
      if (this.panel) choice = await this.panel.show(suggestion);
      this._applyDecision(choice, rule || result.intent, suggestion);
      return { shown: true, choice, intent: result.intent, suggestion: suggestion.suggestion, reason: result.reason };
    } catch (e) {
      this.logger.error('predict-now-error', { error: e.message });
      try { this.engine.modelTimeout(); } catch (_) {}
      throw e;
    } finally {
      // v4.8.8：只在自己仍是当前流水线时释放锁，避免与 _onTrigger 并发互清
      if (this._pipelineSeq === mySeq) {
        this._processing = false;
        // v4.9.1：同 _onTrigger——不打扰分支提前 return 时收走 thinking 态
        if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
      }
      this.logger.info('predict-now-done', { seq: mySeq, owner: this._pipelineSeq === mySeq });
    }
  }

  /**
   * 从当前窗口类型 / 剪贴板 / 鼠标状态推断一个最可能的场景（无模型时的兜底）。
   * 用 matchApp 的反向查找：windowClass 落在哪个逻辑应用组里，就归到对应场景。
   */
  _inferRuleFromContext(ctx) {
    const c = ctx || {};
    const apps = this.config.get('appClassMap') || {};
    // windowClass → 逻辑应用组名
    let group = null;
    for (const [name, classes] of Object.entries(apps)) {
      if (c.windowClass && Array.isArray(classes) && classes.includes(c.windowClass)) { group = name; break; }
    }
    if (group === 'excel') return 'data_entry';
    if (group === 'word' || group === 'ppt' || group === 'im') return 'word_writing';
    if (group === 'browser' || group === 'pdf') {
      // 浏览器：复制过大段 = 收集资料，否则算阅读/查资料
      if (c.clipboard && c.clipboard.length > 500) return 'collecting_material';
      return 'reading_or_thinking';
    }
    if (group === 'vscode' || group === 'ide' || group === 'terminal') return 'api_lookup';
    // 没有应用线索：看剪贴板 / 鼠标停留
    if (c.clipboard && c.clipboard.length > 500) return 'collecting_material';
    if (c.mouseIdleMs > 3000) return 'reading_or_thinking';
    if (c.typedSincePause > 0) return 'word_writing';
    return null;
  }

  /** 手动触发一次（开发/演示用）：把引擎置为 TRIGGERED 后走完整流水线。 */
  async triggerRule(rule) {
    // 模拟真实流程中 hooks 已命中规则、引擎进入 TRIGGERED 的状态
    this.engine.state = 'TRIGGERED';
    this.engine._pending = { rule, reason: rule, context: this.engine._snapshot() };
    return this._onTrigger({ rule, shouldScreenshot: true, reason: rule });
  }
}

module.exports = { PredictController, RULE_TEMPLATE, PROACTIVE_TEMPLATE };
