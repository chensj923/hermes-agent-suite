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
const { titleToApp } = require('./win-info');
const { createSceneWatcher, normalizeSceneRules } = require('./scene-rules');
// v4.11.0：应用画像库（约 100 种软件 × 3 个常用行为）与结晶引擎（长期记忆）
const { lookupApp, behaviorsOf, behaviorById, isGame, CATEGORY_LABEL } = require('./app-profiles');
const { CrystalEngine } = require('./crystal-engine');

/** v4.8.2：hybrid 模式下本地模型只是「触发筛选器」。
/**
 * v4.10.9：模型推理时间不确定，不应设固定超时掐掉。
 * 本地模型（Qwen2.5-VL-3B）在 CPU 上 prompt eval 可达 13~20s+，
 * 掐掉只是白等一轮再降级，用户什么都没得到。
 * 改为：本地模型不设短超时，等到有结果或报错（reject/error）；
 * 只设 5 分钟看门狗防止模型进程假死（永远挂起既不是答复也不是报错）。
 * v4.10.11：远端模型也改 5 分钟看门狗——实测远端网络 30s 明显不够，
 * 网络慢时不应掐掉正常推理；看门狗只用于防止连接假死（既不返回也不报错）。
 */
const LOCAL_SCREEN_TIMEOUT_MS = 300000;  // 5 分钟看门狗（模型进程假死保护）
const LOCAL_ANALYZE_TIMEOUT_MS = 300000; // 5 分钟看门狗

/** v4.10.11：远端模型推断超时升级为 5 分钟看门狗，与本地对齐，避免远端慢推理被掐。 */
const REMOTE_ANALYZE_TIMEOUT_MS = 300000;

/** v4.12.2：远端生成正文超时。生成阶段比意图推断慢很多，默认放宽到 3 分钟看门狗，
 *  仍可被 HERMES_GENERATE_TIMEOUT_MS 覆盖。 */
const REMOTE_GENERATE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_GENERATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
})();

/** v4.12.2：本机离线生文兜底超时。本地 3B 小模型生文通常 10~30s，设 2 分钟看门狗
 *  防止进程假死导致面板永远转圈。 */
const LOCAL_GENERATE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_LOCAL_GENERATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
})();

/**
 * v4.10.37：思考安全网在「服务端请求真正发出」后重新计时的时长。
 * 必须与 channel.js 的 PREDICT_TIMEOUT_MS（默认 90s，可用 HERMES_PREDICT_TIMEOUT_MS
 * 覆盖）对齐，略加余量让客户端自身的 reject 先发生，安全网只兜底窗口卡死。
 */
const PANEL_INFLIGHT_SAFETY_MS = (() => {
  const raw = Number(process.env.HERMES_PREDICT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw + 3000 : 93000;
})();

/**
 * v4.10.38：自动插入走生成阶段时浮窗安全网。生成（含注入）实测可达近 1 分钟，
 * 与 _generateAndDeliver 的 300s 窗口对齐并略收，先让生成自身的超时/兜底生效，
 * 安全网只兜底「正在生成…」浮窗卡死、永不消失。
 */
const PANEL_GENERATE_SAFETY_MS = 180000;

/**
 * v4.10.39：挂起点自身的超时（关键修复）。
 * 旧实现里两处 await 没有任何超时、且兜底用的安全定时器是在它们之后才安装：
 *   - 场景规则路径 await panel.show()：其 10s 计时器在 setSize/ensureReady 之后才挂，
 *     若创建窗口/setSize 卡住，10s 计时器永远挂不上 → 永久等待。
 *   - 主动预测路径 await capture.captureActiveWindow()：内部直接 await
 *     desktopCapturer.getSources()，完全无超时；两条路径并发取源时尤其容易挂住。
 * 日志铁证：22:07:03 之后 35 分钟无任何落盘、进程却还在 = 永久挂起，不是超时丢弃。
 * 因此不能只靠事后安全网，必须给等待操作本身加超时。
 */
const PANEL_SHOW_AWAIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_PANEL_SHOW_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();   // 场景规则弹窗等待上限（含窗口创建）
const CAPTURE_AWAIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_CAPTURE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
})();      // 取截图源等待上限（getSources 挂起保护，v4.10.41 从 15s 提至 30s）
// v4.11.0：应用画像触发的每应用冷却——切回同一个应用不会反复弹行为卡片
const APP_PROFILE_COOLDOWN_MS = (() => {
  const raw = Number(process.env.HERMES_APP_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60 * 1000;
})();
// v4.11.0：结晶自动放行门槛——该行为被接受过这么多次且接受率够高，就不再问，直接干
const CRYSTAL_AUTO_ACCEPTS = 2;
const CRYSTAL_AUTO_CONFIDENCE = 0.6;

/** v4.8.8：_withTimeout 轨迹回调（由控制器构造时注入 logger），用于定位「30s 定时器未触发」问题。 */
let _timeoutTrace = null;

/** Promise 超时包装器。 */
function _withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) {
    if (_timeoutTrace) { try { _timeoutTrace('no-timeout', { message }); } catch (_) {} }
    return Promise.resolve(promise);
  }
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

/**
 * v4.11.0：判断远端是否吃不下图片。
 * 上游若是纯文本模型，收到 image_url 会直接报错（实测 volcengine-coding:
 * 「Model only support text input」）。这种时候退回本机 VL 转文字的老链路。
 */
function _visionUnsupported(result, errMsg) {
  const text = String((result && (result.error || result.reason)) || '') + ' ' + String(errMsg || '');
  return /(only\s*support\s*text|does\s*not\s*support\s*(image|vision)|vision_unsupported|image_unsupported|不支持图|不支持图像|not\s*a\s*multimodal|multimodal\s*not\s*supported)/i.test(text);
}

/** 规则 → 无模型时的兜底建议模板（model='none' 时使用）。 */
const RULE_TEMPLATE = {
  word_writing: '要不要我帮你续写或润色这段文字？',
  data_entry: '这个字段需要我帮忙填吗？',
  collecting_material: '复制的资料要我帮你整理成笔记吗？',
  api_lookup: '卡在接口/报错上了？把报错贴给我，我帮你查。',
  reading_or_thinking: '需要我帮你梳理思路或找资料吗？',
  context_switch: '进入新窗口啦——需要我帮你做点什么吗？',
};

/** 主动预测（点桌宠/点按钮）且连窗口类型都推断不出来时的通用话术。 */
const PROACTIVE_TEMPLATE = '我看了一眼屏幕——需要我帮你做点什么吗？';

/** 服务端上游失败时（buddy-channel.py predict_intent 的 catch 分支）返回的降级话术。 */
const SERVER_DEGRADE_TEXT = '需要我帮你做点什么吗？';

/**
 * v4.9.3：服务端上游失败（如 router_exhausted）时会降级返回
 * { intent: rule, confidence: 0.5, suggestion: '需要我帮你做点什么吗？' }。
 * 这句空话会以 0.5 置信度绕过 weakIntent 兜底（intent 非空且 ≥0.3）原样弹窗。
 * 有场景规则时必须换成针对性模板，别让用户等 20 秒换来一句废话。
 */
function _ungenericServerDegrade(result) {
  if (!result || typeof result !== 'object') return result;
  const generic = !result.suggestion
    || result.suggestion === SERVER_DEGRADE_TEXT
    || /远端推断失败/.test(result.reason || '');
  if (generic && result.intent && RULE_TEMPLATE[result.intent]) {
    result.suggestion = RULE_TEMPLATE[result.intent];
  }
  return result;
}

/**
 * v4.10.22：判断屏幕观察描述里是否存在「可供生成的正文内容」。
 *
 * 背景：连续多个版本用户反馈「生成并插入粘贴出来的是模板」。根因不是 prompt 措辞，
 * 而是截图拍到的画面里根本没有正文——用户在聊天输入框/空白页里触发时，VL 模型描述成
 * 「光标在空白处，没有输入内容」，远端模型拿不到任何素材，只能按兜底规则吐一个模板。
 *
 * 与其继续调 prompt 求模型别出模板，不如在客户端堵死：源素材为空时压根不调远端、
 * 不写剪贴板、不模拟粘贴，只提示用户把光标移到正文里。
 *
 * 判定优先级（先肯定后否定，避免误伤真实的正文）：
 *   1. 描述以「无正文」开头  -> 明确无内容（v4.10.22 DESCRIBE_PROMPT 规则 4 约定）
 *   2. 描述里有正文摘录特征  -> 有内容
 *   3. 描述里有明确空内容表述 -> 无内容
 *   4. 其余默认认为有内容（保守，宁可多生成一次也不误杀）
 */
function hasUsableSourceContent(observation) {
  const obs = String(observation || '').trim();
  // 空观察 != 无正文：remote 模式不跑本地 VL、或 VL 未就绪/截图失败时，
  // screenObservation 本来就是空的，此时靠行为元数据（rule/suggestion）生成，
  // 必须放行，否则 remote 模式下「生成并插入」会彻底失效。
  if (!obs) return true;
  if (/^无正文/.test(obs)) return false;                     // 结构化标记：无正文
  // 有正文摘录特征：明确的写作动作 + 摘录/标题
  if (/正在文档中写作/.test(obs)) return true;
  if (/(开头写着|标题是|写着[：:]|正文|文档标题)/.test(obs)) return true;
  // 明确的空内容表述
  if (/(没有输入内容|没有看到.{0,8}内容|文档为空白|只有标题|空白页|输入框为空|空白文档|没有文字)/.test(obs)) return false;
  return true;
}

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
    // v4.10.2：「生成并插入」的内容生成函数（main.js 注入，接远端通道）。
    // 独立注入而非复用判断通道，测试环境不注入时保持旧兜底行为。
    this._generateContentFn = opts.generateContentFn || null;
    this.buildRunner = opts.buildRunner || null;
    this._predictFn = opts.predictFn || null;  // 远端/测试用
    // v4.10.0：本机视觉描述函数（测试注入用；真实环境走 LocalModelRunner.describe）
    this._describeFn = opts.describeFn || null;

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

    // v4.10.18：推理记录环形缓冲（最多 200 条），供客户端 UI 展示
    this._logMax = 200;
    this._log = [];
    this._logSeq = 0;
    this._onLogEntry = opts.onLogEntry || null;  // 实时推送给渲染层的回调
    // v4.10.27：目标窗口（要插入内容的那个窗体）。由 captureTargetWindowFn 在触发
    // 那一刻异步捕获（那时前台还是用户的文档窗口），插入时直接用句柄 Activate，
    // 不再依赖「打字时沿 Z 序猜」——浮窗 focus / 点按钮都会把前台抢走，猜不准。
    this._captureTargetWindowFn = opts.captureTargetWindowFn || null;
    this._targetWindow = null;
    this._targetPromise = null;
    // v4.10.33：记录「触发时是否真的发起过捕获」。发起过却拿不到句柄时，
    // 插入时刻的窗口已不可信（用户可能切去别的窗口），宁可只写剪贴板也不盲插。
    this._targetCaptureAttempted = false;
    // v4.10.24：场景规则（结晶场景）监视器。规则表存 config.sceneRules，
    // 未配置时用内置默认（WPS 写作/润色 + 微信/QQ 回复）。
    this._sceneWatcher = createSceneWatcher(this.config.get('sceneRules'));
    // v4.11.0：结晶引擎（本地长期记忆）+ 应用画像触发的每应用冷却表
    this.crystal = new CrystalEngine({ dataDir: path.join(this.appDir, 'predict'), logger: this.logger });
    this._appLastFired = {};
    // v4.12.1：onWindowChange 处理锁。窗口事件路径不设置 _processing，但卡片
    // await panel.show 最长 20s，期间新切窗事件会再起卡片，导致 9s 内多条流水线、
    // 步骤堆满同一面板（实测卡顿/混乱来源之一）。用独立标志保证窗口处理不重入。
    this._windowHandling = false;
    this._lastProfile = null;   // 最近命中的应用画像（供生成阶段取行为 prompt）
  }

  // ---------------- 应用画像 + 结晶（v4.11.0） ----------------

  /**
   * 命中应用画像后，组装一张「这个应用最常用的 3 件事」卡片。
   * 行为顺序按结晶置信度排（你常接受的行为自动排到第一个），
   * 结晶足够强的行为会被标记 auto，面板阶段可直接放行不再问。
   */
  _profileSuggestion(hit, wi) {
    const profile = hit.profile;
    const behaviors = behaviorsOf(profile).map((b) => {
      const s = this.crystal.scoreOf(profile.id, b.id);
      return Object.assign({}, b, {
        confidence: s.confidence,
        hits: s.hits,
        // 自动放行：接受过 ≥2 次且接受率 ≥0.6，且该行为是可以插进文档的（不是给建议的）
        auto: b.insert && !s.retired && s.accepts >= CRYSTAL_AUTO_ACCEPTS && s.confidence >= CRYSTAL_AUTO_CONFIDENCE,
      });
    });
    behaviors.sort((a, b) => {
      if (a.auto !== b.auto) return a.auto ? -1 : 1;
      return (b.confidence || 0) - (a.confidence || 0);
    });
    const top = behaviors[0];
    return {
      intent: top.intent,
      suggestion: top.suggestion,
      reason: '应用画像：' + profile.name + (isGame(profile) ? '（游戏）' : ''),
      confidence: 1,
      appProfile: {
        id: profile.id,
        name: profile.name,
        category: profile.category,
        categoryLabel: CATEGORY_LABEL[profile.category] || profile.category,
        isGame: isGame(profile),
        exeName: (wi && wi.exeName) || '',
      },
      behaviors: behaviors.map((b) => ({
        id: b.id, name: b.name, intent: b.intent,
        hint: b.suggestion, insert: b.insert, auto: b.auto,
        confidence: b.confidence,
      })),
      // 默认方向：排第一的行为的 prompt，用户不点行为直接「生成」时用它
      behaviorPrompt: top.prompt || '',
      behaviorId: top.id,
    };
  }

  /** 记录一次行为模式（命中应用画像 / 每次主动推测都记）。 */
  _recordBehavior(profileId, behaviorId, intent, text, proactive) {
    try {
      this.crystal.record({ appId: profileId, behaviorId, intent, text, proactive: !!proactive });
    } catch (e) {
      this.logger.warn('crystal-record-failed', { error: e.message });
    }
  }

  /** 记录用户对某行为接受/拒绝。 */
  _recordOutcome(profileId, behaviorId, accepted) {
    try {
      return this.crystal.recordOutcome({ appId: profileId, behaviorId }, accepted);
    } catch (e) {
      this.logger.warn('crystal-outcome-failed', { error: e.message });
      return null;
    }
  }

  /**
   * 后台结晶：第二次及以后打开应用时静默跑一次，淘汰过期/不爱用的预测，
   * 固化新的高频高接受率行为。不阻塞主线程（纯本地 JSON 计算）。
   */
  async runBackgroundCrystal(force) {
    try {
      if (!force && !this.crystal.shouldCrystal()) return null;
      const before = this.crystal.summary();
      const result = this.crystal.crystallize();
      this.logger.info('crystal-background', { before, result });
      this._logEntry({
        phase: 'crystal',
        status: 'ok',
        added: result.added.length,
        retired: result.retired.length,
        kept: result.kept,
      });
      return result;
    } catch (e) {
      this.logger.warn('crystal-background-failed', { error: e.message });
      return null;
    }
  }

  /** 结晶摘要（设置面板展示）。 */
  getCrystalSummary() {
    try { return this.crystal.summary(); } catch (_) { return { patterns: 0, predictions: 0, events: 0, lastCrystalAt: 0, runs: 0 }; }
  }

  /** 某应用当前结晶出的预测（设置面板 / 调试用）。 */
  getCrystalPredictions(appId) {
    try { return this.crystal.predictionsFor(appId); } catch (_) { return []; }
  }

  // ---------------- 目标窗口捕获（v4.10.27） ----------------

  /**
   * 在流水线起头发起一次目标窗口捕获——不 await，与截图/模型推理并行跑。
   * 必须在这里（而不是插入时）发起：此刻前台还是用户真正在用的文档窗口，
   * 再晚一步浮窗 focus 或用户点按钮就把前台抢走了。
   * @returns {Promise<{hwnd:number,pid:number,title:string}|null>}
   */
  _startTargetCapture() {
    if (typeof this._captureTargetWindowFn !== 'function') return Promise.resolve(null);
    this._targetCaptureAttempted = true;
    const p = Promise.resolve()
      .then(() => this._captureTargetWindowFn({ buddyPid: process.pid, logger: this.logger }))
      .then((w) => {
        if (w && w.hwnd) {
          this._targetWindow = w;
          // 顺带把窗口标题补上——主题锚点（v4.10.23）在场景规则路径下常为空
          if (!this._lastWindowTitle && w.title) this._lastWindowTitle = w.title;
        }
        return this._targetWindow;
      })
      .catch((e) => {
        this.logger.warn('target-window-capture-error', { error: e && e.message });
        return null;
      });
    this._targetPromise = p;
    return p;
  }

  /** 插入前调用：等捕获落地（最多几秒），拿不到就返回 null（脚本内回退 Z 序查找）。 */
  async _resolveTargetWindow() {
    if (this._targetWindow) return this._targetWindow;
    if (this._targetPromise) {
      try { await this._targetPromise; } catch (_) {}
      this._targetPromise = null;
    }
    if (!this._targetWindow && typeof this._captureTargetWindowFn === 'function') {
      // 兜底：流水线起头没发起过（例如纯手动插入路径）→ 现抓一次
      try {
        const w = await this._captureTargetWindowFn({ buddyPid: process.pid, logger: this.logger });
        // v4.10.33 护栏：现抓发生在「插入时刻」，此时前台可能早已被用户切走
        //（比如切回来看推理记录），往里打字 = 内容插错窗口。只有现抓窗口与
        // 分析时刻记录的窗口标题一致时才可信；不一致宁可放弃（调用方降级为
        // 只写剪贴板）。anchor 为空时无从校验，保持旧行为。
        if (w && w.hwnd) {
          const anchor = String(this._lastWindowTitle || '').trim();
          const picked = String(w.title || '').trim();
          if (!anchor || (picked && picked === anchor)) {
            this._targetWindow = w;
          } else {
            this.logger.warn('target-window-mismatch', {
              pickedTitle: picked.slice(0, 60),
              anchorTitle: anchor.slice(0, 60),
            });
          }
        }
      } catch (_) {}
    }
    return this._targetWindow;
  }

  /**
   * v4.10.27：给建议打上「需要主题输入」标记。
   *
   * 屏幕上没有可识别正文（空白文档 / 只有标题 / 聊天输入框）时，远端拿不到素材，
   * 只能吐模板——这是「生成并插入总粘贴模板」的根源。与其硬生成，不如在浮窗里
   * 直接问用户想写什么，把主题当方向喂给模型。
   */
  _decorateSuggestion(suggestion) {
    if (!suggestion) return suggestion;
    const obs = this._lastObservation || '';
    // 没有观察（场景规则路径没跑 VL）或观察判定无正文 → 需要用户给主题
    const needTopic = !obs || !hasUsableSourceContent(obs);
    if (needTopic) {
      suggestion.needTopic = true;
      suggestion.topicHint = suggestion.topicHint
        || '没有识别到正在编辑的正文，输入你想写的主题';
    }
    return suggestion;
  }

  // ---------------- 场景规则（v4.10.24 结晶场景） ----------------

  /**
   * 前台窗口变化时由 main.js 的 hooks 接线调用。
   * 命中已启用的场景规则（且不在流水线中）→ 跳过截图/VL/远端推断，
   * 直接弹浮窗给建议——「打开 WPS 就问要不要写作」这类即开即问的顺畅体验。
   * @param {{exeName?:string,title?:string}} wi OS 前台窗口信息
   */
  async onWindowChange(wi) {
    // v4.12.1：窗口处理不重入（上一张卡片仍 await show 时，新切窗事件直接忽略）
    if (!this.isEnabled() || this._processing || this._windowHandling) return;
    this._windowHandling = true;
    try {
      // v4.11.0：应用画像优先——命中就把这个应用最常用的 3 件事直接摆出来，
      // 不再让远端模型从零猜「用户现在在干嘛」（过去触发率和准确度都差在这一步）。
      if (this.config.get('appProfilesEnabled') !== false) {
        const hit = lookupApp(wi);
        if (hit && this._profileCooldownOk(hit.profile.id)) {
          this._appLastFired[hit.profile.id] = Date.now();
          await this._onProfileHit(hit, wi);
          return;
        }
      }
      if (this.config.get('sceneRulesEnabled') === false) return;
      const rule = this._sceneWatcher.feed(wi);
      if (!rule || !this.panel) return;
      // v4.10.40：开一轮步骤面板，实时展示场景规则触发进度
      this._beginFlowStep('场景规则：' + rule.name);
      this._step('trigger', { title: '场景规则已触发', status: 'done', detail: (wi && wi.exeName) ? ('窗口：' + wi.exeName) : rule.name });
      this._step('target', { title: '捕获目标窗口', status: 'pending', detail: '准备把内容写进当前窗口' });
      // v4.10.27：前台刚切到目标窗口，此时抓句柄最准（晚一点浮窗就抢焦点了）
      this._startTargetCapture();
      this.logger.info('scene-rule-hit', { id: rule.id, exeName: wi && wi.exeName, title: wi && wi.title });
      this._logEntry({
        phase: 'trigger',
        rule: 'scene:' + rule.id,
        reason: '场景规则: ' + rule.name,
        sceneRule: true,
      });
      const suggestion = {
        intent: rule.intent,
        suggestion: rule.suggestion || rule.name,
        reason: '场景规则: ' + rule.name,
        confidence: 1,
        sceneRule: rule,   // 生成时作为提示词方向透传给服务端
      };
      // 场景规则路径没跑 VL，_lastObservation 常为空 → 这里几乎总会需要主题输入
      this._decorateSuggestion(suggestion);
      let choice = 'later';
      try {
        choice = await _withTimeout(
          this.panel.show(suggestion),
          PANEL_SHOW_AWAIT_TIMEOUT_MS,
          '场景浮窗等待超时'
        );
      } catch (e) {
        // v4.10.39：窗口创建/setSize 卡住导致 show 永不返回时，按「稍后」收场并收窗，
        // 绝不永久挂在 await 上（否则后续所有触发都因协程卡死而无推理）。
        this.logger.warn('scene-panel-show-timeout', { error: e.message });
        try { this.panel.dismissAwaiting(); } catch (_) {}
        choice = 'later';
      }
      this._applyDecision(choice, 'scene:' + rule.id, suggestion);
    } catch (e) {
      this.logger.warn('scene-rule-error', { error: e.message });
    } finally {
      this._windowHandling = false;   // v4.12.1：释放窗口处理锁
    }
  }

  /** 每应用冷却：切回同一个应用不会反复弹行为卡片。 */
  _profileCooldownOk(profileId) {
    const last = this._appLastFired[profileId] || 0;
    return Date.now() - last >= APP_PROFILE_COOLDOWN_MS;
  }

  /**
   * 应用画像命中：展示该应用最常用的 3 个行为，让用户点一下就走。
   * 结晶里接受率足够高的行为（auto）直接放行，不再打扰用户确认。
   */
  async _onProfileHit(hit, wi) {
    const profile = hit.profile;
    this._lastProfile = profile;
    const suggestion = this._profileSuggestion(hit, wi);
    const game = isGame(profile);
    this._beginFlowStep('应用画像：' + profile.name + (game ? '（游戏）' : ''));
    this._step('trigger', {
      title: '识别到应用',
      status: 'done',
      detail: profile.name + '（' + (CATEGORY_LABEL[profile.category] || profile.category) + '）',
    });
    // 画像路径不截图也不跑 VL——直接给行为，命中即达
    this._lastObservation = '';
    this._lastWindowTitle = String((wi && wi.title) || '');
    this.logger.info('app-profile-hit', {
      id: profile.id, exeName: wi && wi.exeName, category: profile.category, game,
    });
    this._logEntry({
      phase: 'trigger',
      rule: 'app:' + profile.id,
      reason: '应用画像: ' + profile.name,
      appProfile: profile.id,
    });
    // 每次命中都把行为模式记下来（供结晶判断哪些行为是真需求）
    for (const b of suggestion.behaviors) {
      this._recordBehavior(profile.id, b.id, b.intent, b.hint, false);
    }

    // 结晶出的常用行为：直接执行，不再问
    const auto = suggestion.behaviors.find((b) => b.auto);
    if (auto && this.config.get('autoInsert') === true) {
      this._step('decide', { title: '按你的习惯直接执行', status: 'done', detail: '「' + auto.name + '」你常用，已自动执行' });
      this._runBehavior(profile, auto.id, suggestion, '');
      return;
    }

    this._decorateSuggestion(suggestion);
    if (game) {
      // 游戏不需要手填主题：看画面给建议就行
      suggestion.needTopic = false;
      suggestion.topicHint = '';
    }
    let choice = 'later';
    try {
      choice = await _withTimeout(
        this.panel.show(suggestion),
        PANEL_SHOW_AWAIT_TIMEOUT_MS,
        '应用画像浮窗等待超时'
      );
    } catch (e) {
      this.logger.warn('app-profile-panel-show-timeout', { error: e.message });
      try { this.panel.dismissAwaiting(); } catch (_) {}
      choice = 'later';
    }
    await this._applyProfileDecision(choice, profile, suggestion);
  }

  /**
   * 处理画像卡片上的用户决策。
   * choice 可能是字符串（旧协议）或 {choice, topic, behaviorId}（v4.11.0 行为选择）。
   */
  async _applyProfileDecision(choice, profile, suggestion) {
    let c = 'later';
    let topic = '';
    let behaviorId = '';
    if (choice && typeof choice === 'object') {
      c = String(choice.choice || 'later');
      topic = String(choice.topic || '');
      behaviorId = String(choice.behaviorId || '');
    } else {
      c = String(choice || 'later');
    }
    const accepted = c === 'generate' || c === 'behavior';
    const targetId = behaviorId || (suggestion && suggestion.behaviorId) || '';
    this._recordOutcome(profile.id, targetId, accepted);
    this.logger.info('app-profile-decision', { appId: profile.id, behaviorId: targetId, choice: c, accepted });
    if (!accepted) return;
    await this._runBehavior(profile, targetId, suggestion, topic);
  }

  /**
   * 执行一个画像行为：生成内容 → 可插入的行为打进窗口，建议类（游戏等）只展示+剪贴板。
   */
  async _runBehavior(profile, behaviorId, suggestion, topic) {
    const b = behaviorById(profile, behaviorId) || (suggestion && suggestion.behaviors && suggestion.behaviors.find((x) => x.id === behaviorId)) || null;
    const exec = Object.assign({}, suggestion || {}, {
      intent: (b && b.intent) || (suggestion && suggestion.intent) || 'generic_help',
      behaviorPrompt: (b && b.prompt) || (suggestion && suggestion.behaviorPrompt) || '',
      behaviorId: behaviorId,
      behaviorName: (b && b.name) || '',
      // 建议类行为不往窗口里打字（游戏里打字 = 事故），只展示 + 写剪贴板
      noInsert: b ? !b.insert : true,
      appProfile: (suggestion && suggestion.appProfile) || { id: profile.id, name: profile.name },
    });
    this._step('deliver', {
      title: '执行：' + ((b && b.name) || behaviorId),
      status: 'pending',
      detail: b && b.insert ? '生成后将写入当前窗口' : '生成后只展示（不写入窗口）',
    });
    try {
      await this._generateAndDeliver(exec, topic || '');
    } catch (e) {
      this.logger.warn('app-profile-behavior-failed', { error: e.message });
      this._step('deliver', { title: '执行失败', status: 'fail', detail: String(e.message || '生成异常') });
    }
  }

  /** 设置面板保存场景规则后调用：热更新监视器 + 落盘。 */
  setSceneRules(list) {
    const normalized = normalizeSceneRules(list);
    this.config.set({ sceneRules: normalized });
    this._sceneWatcher.update(normalized);
    return this.getSceneRules();
  }

  getSceneRules() {
    return this._sceneWatcher.getRules();
  }

  // ---------------- 推理记录（v4.10.18） ----------------

  /**
   * 记录一次推理流水线事件，存入环形缓冲并实时推送给渲染层。
   * 在触发、分析完成、用户决策、生成完成/失败等关键节点调用。
   */
  _logEntry(entry) {
    const record = {
      id: ++this._logSeq,
      ts: Date.now(),
      ...entry,
    };
    this._log.push(record);
    if (this._log.length > this._logMax) this._log.shift();
    if (typeof this._onLogEntry === 'function') {
      try { this._onLogEntry(record); } catch (_) {}
    }
    return record;
  }

  /** 返回最近的推理记录（倒序，最多 200 条）。 */
  getLog() {
    return this._log.slice().reverse();
  }

  /** 清空推理记录。 */
  clearLog() {
    this._log = [];
    this._logSeq = 0;
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
      // v4.10.24：场景规则监视器挂在前台窗口切换事件上
      onWindowChange: (p) => this.onWindowChange(p),
    });
    await this.hooks.start();
    this._enabled = true;
    // v4.8.2：后台预热本地模型，让 local/hybrid 的下次触发不走冷启动
    this.warmLocalModel().catch(() => {});
    // v4.11.0：后台结晶——第二次及以后打开应用时静默跑一次：
    // 淘汰过期/不爱用的预测，固化新的高频高接受率行为（纯本地计算，不阻塞启用）
    this.runBackgroundCrystal().catch(() => {});
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

  /**
   * v4.10.3：前台是否为本应用自己的窗口。
   * 实测教训：用户刚装完包在 Buddy 界面/托盘上操作时触发预测，截图把仅有的
   * 前台（自己）藏掉 → 黑帧；远端收到 exeName:"Hermes Buddy" + 黑屏描述后
   * 只能瞎猜（api_lookup 0.9 置信度就是这么来的）。自己在前台时不该打扰用户。
   */
  _isSelfForeground(wi) {
    if (!wi) return false;
    const exe = String(wi.exeName || '');
    const title = String(wi.title || '');
    if (/hermes/i.test(exe)) return true;
    if (/hermes[\s-]?buddy/i.test(title)) return true;
    return false;
  }

  /**
   * v4.10.41：判断前台窗口是否为文字处理类应用（WPS/Word）。
   * 截图失败时，不能仅凭行为元数据让远端猜成 reading_or_thinking；
   * 只要用户在 Word/WPS 里，就按写作兜底。
   */
  _isWordLikeApp(wi) {
    if (!wi) return false;
    const exe = String(wi.exeName || '').toLowerCase();
    const title = String(wi.title || '').toLowerCase();
    const wc = String(wi.windowClass || '').toLowerCase();
    if (/\b(winword|wps)\b/.test(exe)) return true;
    if (/wps\s*文字|wps文字|金山|microsoft word|\bword\b/.test(title)) return true;
    if (wc === 'wps_application' || wc === 'opusapp' || wc === 'wwlib' || /wps/i.test(wc)) return true;
    return false;
  }

  /**
   * v4.10.12：主动预测时确定「用户正在用的应用」身份，写进行为上下文。
   *
   * 根因：主动点猫 → OS 前台窗口是桌宠自己，resolveWindow() 返回的 wi 是桌宠身份
   * （exeName="Hermes Buddy"、Chrome_WidgetWin_1 → 被归成 browser → reading_or_thinking），
   * 直接用它做规则推断/发给远端模型，就会给出「需要我帮你梳理思路吗」这类泛化话术。
   * 而 capture 在隐藏本应用窗口后截到的，是用户真正在用的窗口——其 source.name 就是
   * 真实窗口标题（如 "Hermes-buddy4.5使用结论： - WPS 文字"）。
   *
   * 优先级：
   *  1) 截图源是真实业务窗口（capture 已排除桌宠）→ 用 titleToApp 反推身份覆盖；
   *  2) 整屏截图（shotSource 形如 "Screen 1"）且 OS 前台是真实应用（非桌宠）→ 用 wi；
   *  3) 都没拿到 → 不动（_inferRuleFromContext 退化为兜底，不至于误判成阅读）。
   *
   * @param {object} ctx 行为上下文（会被原地写入 windowClass/exeName/title）
   * @param {string} [shotSource] capture 返回的真实窗口标题（或整屏标记）
   * @param {{windowClass?:string,title?:string,exeName?:string}} [wi] OS 前台窗口信息
   */
  _applyScreenIdentity(ctx, shotSource, wi) {
    if (!ctx) return;
    const screenRe = /^(screen|entire|全屏)/i;
    if (shotSource && !screenRe.test(shotSource)) {
      // capture 选源时已排除桌宠窗口，能到这里的一定是真实业务窗口（即便文档名含 "Hermes"）
      const id = titleToApp(shotSource);
      if (id) {
        ctx.windowClass = id.windowClass;
        ctx.exeName = id.exeName;
        ctx.title = id.title;
        return;
      }
    }
    // 整屏兜底：OS 前台是真实应用时才信任它（桌宠前台不能当业务身份）
    if (wi && !this._isSelfForeground(wi)) {
      if (wi.windowClass) ctx.windowClass = wi.windowClass;
      if (wi.exeName) ctx.exeName = wi.exeName;
      if (wi.title) ctx.title = wi.title;
    }
  }

  /** 钩子命中规则时由 hooks 回调。 */
  async _onTrigger(triggerResult) {
    if (this._processing) return;           // 已有流水线在跑，丢弃本次触发
    if (!triggerResult || !triggerResult.shouldScreenshot) return;
    this._processing = true;
    this._degraded = false;                 // v4.8.5：每次新触发重置降级标记
    const mySeq = ++this._pipelineSeq;      // v4.8.8：标记本流水线所有权
    // v4.10.40：开一轮步骤面板，实时展示预测进度
    this._beginFlowStep('主动预测' + (triggerResult.rule ? '：' + triggerResult.rule : ''));
    this._step('trigger', { title: '已触发预测', status: 'done', detail: (triggerResult.rule || '') + (triggerResult.reason ? '｜' + triggerResult.reason : '') });
    this._step('target', { title: '捕获目标窗口', status: 'pending', detail: '准备把内容写进当前窗口' });
    // v4.10.27：趁前台还是用户窗口，异步抓下目标句柄（不 await，与截图并行）
    this._startTargetCapture();
    // v4.10.18：记录触发
    this._logEntry({
      phase: 'trigger',
      rule: triggerResult.rule || '',
      reason: (triggerResult.reason || '').slice(0, 200),
    });
    try {
      // 1) 进入 ANALYZING
      const r1 = this.engine.screenshotTaken();
      if (r1.state !== 'ANALYZING') return;

      // 1.5) v4.10.31：context_switch = 切到工作应用的"开口时机"轻提示。
      //   走本地模板即时弹出——跳过截图 + 远端 10–20s，让桌宠在切换瞬间就"出言"，
      //   不等地远端想完才冒出来。这是"事件驱动"而非"等停顿"的流畅感来源。
      if (triggerResult.rule === 'context_switch') {
        const pendingCtx = this.engine.pending() ? this.engine.pending().context : null;
        const suggestion = {
          intent: 'context_switch',
          suggestion: RULE_TEMPLATE.context_switch,
          reason: '切到工作窗口，主动轻提示',
          confidence: 0.75,
          action: this._buildAction('context_switch', RULE_TEMPLATE.context_switch),
        };
        this._step('analyze', { title: '轻提示（免远端）', status: 'done', detail: '切到工作窗口即时提示' });
        this.engine.modelResult({ intent: suggestion.intent, confidence: suggestion.confidence });
        this.logger.info('predict-context-switch-instant', {
          windowClass: (pendingCtx && pendingCtx.windowClass) || null,
          exeName: (pendingCtx && pendingCtx.exeName) || null,
        });
        let choice = 'later';
        if (this.panel) choice = await this.panel.show(this._decorateSuggestion(suggestion));
        this._logEntry({
          phase: 'decision', rule: 'context_switch',
          intent: suggestion.intent, suggestion: suggestion.suggestion.slice(0, 200), choice,
        });
        this._applyDecision(choice, 'context_switch', suggestion);
        return;
      }

      // 1.5) v4.10.3：前台是本应用自己 → 整轮跳过（不截图、不调模型、不弹卡）
      try {
        const wi = await this.resolveWindow();
        if (false) { // v4.10.8: 不再跳过本应用前台 -- capture.js 已隐藏本应用窗口
          this.logger.info('predict-skip-self-foreground', { title: wi && wi.title, exeName: wi && wi.exeName });
          this.engine.modelTimeout();
          return;
        }
      } catch (_) { /* 前台解析失败不拦截，继续原流程 */ }

      // 2) 准备行为上下文（只元数据，绝不带文本/标题内容）
      //    v4.10.41：提前定义，让截图失败时也能写入兜底标记。
      const ctx = this.engine.pending() ? this.engine.pending().context : this.engine._snapshot();
      const rule = triggerResult.rule;
      // v4.8.9：记住最近一次触发的规则，供超时降级兜底
      if (rule) this._lastRule = rule;
      const behaviorContext = Object.assign({ rule }, ctx);

      // 2.5) 截图（仅内存 buffer，不落盘）
      //      v4.10.2：带上前台窗口标题，截图源优先匹配它（避免拿到后台/空白窗口）；
      //      capture 内部还会隐藏本应用窗口，防止桌宠猫污染画面。
      let imageBase64 = null;
      let shotSource = null;
      let wi = null;
      if (this.capture) {
        try {
          try {
            wi = await this.resolveWindow();
          } catch (_) {}
          const fgTitle = (wi && wi.title) || '';
          const shot = await _withTimeout(
            this.capture.captureActiveWindow({
              skipName: /hermes buddy|hermes-buddy|桌宠|buddy/i,
              fgTitle,
            }),
            CAPTURE_AWAIT_TIMEOUT_MS,
            '截图取源超时'
          );
          imageBase64 = shot && shot.base64;
          shotSource = shot && shot.source;
        } catch (e) {
          this.logger.warn('predict-capture-failed', { error: e.message, code: e.code });
        }
        // v4.10.40：截图步骤实时反馈
        // v4.10.41：截图失败但前台是 WPS/Word 时，按写作意图兜底，避免远端盲猜 reading_or_thinking
        if (imageBase64) {
          this._step('shot', { title: '已截图', status: 'done', detail: (shotSource || '当前窗口') });
        } else if (this._isWordLikeApp(wi)) {
          behaviorContext._forceWriting = true;
          this._step('shot', { title: '截图失败', status: 'warn', detail: '未取到 WPS/Word 画面，已按写作意图继续' });
        } else {
          this._step('shot', { title: '截图', status: 'warn', detail: '未取到画面（将不带视觉信息继续）' });
        }
      }

      // 3) 行为上下文身份纠正（截图后才能拿到真实窗口身份）
      // v4.10.13：自动触发也要纠正「桌宠被当成前台应用」的身份误判。
      // 否则远端拿到 exeName="Hermes Buddy自身" 会回低置信度「不打扰」，
      // 被 0.6 门槛拦下后思考气泡闪一下就消失，用户观感是「推理弹没了、没反应」。
      this._applyScreenIdentity(behaviorContext, shotSource, wi);

      // 4) 模型判断意图（远端优先，断线自动退回本机）
      //    v4.12.0：运行模式已移除，不再有 local/remote/hybrid 之分。
      //    连着远端就远端思考，远端不可用自动本机兜底；都拿不到才降级为规则模板。
      let result;
      this._showThinking('思考中…');
      this._step('analyze', { title: '分析意图中', status: 'pending', detail: '远端优先，断线退回本机' });
      try {
        result = await this._analyze(behaviorContext, imageBase64);
        const conf = result && Number(result.confidence);
        this._step('analyze', {
          title: '意图分析完成',
          status: 'done',
          detail: '意图：' + ((result && result.intent) || '未知') + (Number.isFinite(conf) ? '（置信度 ' + conf.toFixed(2) + '）' : ''),
        });
      } catch (e) {
        // v4.10.3：黑屏观察（截图拿不到有效画面）→ 静默放弃本轮，别降级弹卡
        // 瞎给建议——那正是「在写文档却被推荐查接口」的来源之一。
        if (/blank-screen/.test(e.message)) {
          this.logger.warn('predict-skip-blank-observation');
          this.engine.modelTimeout();
          return;
        }
        // v4.8.5：模型不可用（本地引擎未安装/推理超时、远端通道未连）→ 降级为规则模板弹窗。
        // 旧行为是 modelTimeout()+return 静默丢弃，导致用户只看到转圈；现在必须给出可见输出。
        this.logger.warn('predict-analyze-failed, degrade to rule template', { error: e.message });
        this._step('analyze', { title: '模型未就绪', status: 'fail', detail: String(e.message || '分析失败') + '，已降级为规则模板' });
        await this._degradeToRule(behaviorContext, '模型未就绪，已降级为行为规则预判：' + e.message);
        return;
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

      // 5) 构造建议对象，并允许客户端在特定场景下修正远端误判
      _ungenericServerDegrade(result);   // v4.9.3：服务端降级话术 → 场景规则模板
      const suggestion = {
        intent: result.intent,
        suggestion: result.suggestion || RULE_TEMPLATE[result.intent] || '需要我帮你做点什么吗？',
        reason: result.reason || '',
        confidence: result.confidence,
        action: this._buildAction(result.intent, result.suggestion),
      };
      // v4.10.41：截图失败但前台是 WPS/Word 时，远端盲猜 reading_or_thinking 不可靠，
      // 直接按写作意图兜底，避免「明明在写文档却问要不要梳理思路」且黑盒不自动写。
      if (behaviorContext._forceWriting && result.intent === 'reading_or_thinking') {
        suggestion.intent = 'word_writing';
        suggestion.suggestion = RULE_TEMPLATE.word_writing;
        suggestion.reason = (result.reason ? result.reason + '；' : '') + '截图失败，已按 WPS/Word 写作意图兜底';
        suggestion.confidence = Math.max(Number(result.confidence) || 0, 0.8);
        this._step('analyze', { title: '意图已兜底修正', status: 'warn', detail: '无截图，按 WPS/Word 写作处理' });
      }

      // 6) 引擎按置信度门槛决定是否弹窗
      const r2 = this.engine.modelResult({
        intent: suggestion.intent,
        confidence: suggestion.confidence,
      });
      // v4.10.18：记录分析结果
      this._logEntry({
        phase: 'analyzed',
        rule: rule || '',
        intent: suggestion.intent || '',
        confidence: suggestion.confidence || 0,
        suggestion: (suggestion.suggestion || '').slice(0, 200),
        reason: (suggestion.reason || '').slice(0, 200),
        suggest: r2.suggest,
      });
      // v4.10.13：自动触发复用主动预测的兜底——行为规则已命中（用户在写字/查资料
      // 等明确场景），却因身份误判导致远端回低置信度「不打扰」时，退回场景规则模板，
      // 避免「思考中闪一下就消失、毫无反应」。仅当连场景规则都没有（真的不明确）
      // 时才真正安静退出，收走 thinking 态。
      if (!r2.suggest) {
        // 仅对「明确场景」规则兜底弹窗（写作/录表/查接口/收集资料）；
        // 泛化的 reading_or_thinking（鼠标空闲 3s 即触发）不兜底，避免每次发呆都弹
        // 「需要我帮你梳理思路吗」。这一步消除「思考中闪一下就消失、毫无反应」的顽疾，
        // 又守住被动模式的「不打扰」语义。
        if (rule && rule !== 'reading_or_thinking' && RULE_TEMPLATE[rule]) {
          suggestion.intent = rule;
          suggestion.suggestion = RULE_TEMPLATE[rule];
          suggestion.reason = (result.reason ? result.reason + '；' : '') + '已按当前场景给出建议';
        } else {
          return;   // 模型觉得不该打扰，且场景也不明确 → 回到 IDLE
        }
      }

      // 6) 浮窗展示 + 等决策
      // v4.10.38：autoInsert 开启且是明确写作类意图 → 不再停在确认框等点击，
      // 直接生成并打进目标窗口；浮窗保留显示「正在生成…」。模糊意图
      // （reading_or_thinking）仍只提示，避免发呆时自动往文档里写东西。
      if (this._shouldAutoInsert(suggestion.intent)) {
        this.logger.info('predict-auto-insert', { intent: suggestion.intent || '' });
        this._logEntry({
          phase: 'decision', rule: rule || '',
          intent: suggestion.intent || '',
          suggestion: (suggestion.suggestion || '').slice(0, 200),
          choice: 'auto-generate',
        });
        this.engine.userDecision(true);
        // v4.10.40：自动插入也推一条「决策」步骤，保持面板可见
        this._step('decide', { title: '已自动生成并插入', status: 'pending', detail: '远端回馈后直接写入目标窗口（不再等待点击）' });
        // 浮窗换成「正在生成…」并重新计时安全网（生成窗口最长 300s）
        this._showThinking('正在生成…（可能需要约 1 分钟）');
        this._rearmPanelSafety(PANEL_GENERATE_SAFETY_MS);
        try {
          // v4.10.41：截图失败但前台是 WPS/Word 时，没有视觉观察，用窗口标题作为生成主题兜底
          const topic = behaviorContext._forceWriting ? String(behaviorContext.title || '').trim() : '';
          await this._generateAndDeliver(suggestion, topic);
        } catch (e) {
          this.logger.warn('predict-auto-insert-failed', { error: e.message });
        }
        return;
      }

      let choice = 'later';
      if (this.panel) {
        choice = await this.panel.show(this._decorateSuggestion(suggestion));
      }
      // v4.10.18：记录用户决策
      this._logEntry({
        phase: 'decision',
        rule: rule || '',
        intent: suggestion.intent || '',
        suggestion: (suggestion.suggestion || '').slice(0, 200),
        choice: choice,
      });
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
    // v4.10.40：降级步骤实时反馈
    this._step('suggestion', { title: '已降级为规则模板', status: 'warn', detail: suggestion.reason });
    if (!this.panel) { this.logger.warn('predict-degrade-no-panel'); return 'later'; }
    this.logger.info('predict-degrade-show', { intent: suggestion.intent, reason: suggestion.reason });
    const choice = await this.panel.show(this._decorateSuggestion(suggestion));
    this.logger.info('predict-degrade-choice', { choice });
    this._applyDecision(choice, rule, suggestion);
    return choice;
  }

  /**
   * 把用户决策写回引擎 + 执行动作。
   *
   * v4.10.27：choice 可能是字符串（旧协议），也可能是 {choice, topic}——
   * 浮窗在「没识别到正文」时会带一个主题输入框，用户填的主题随决策一起回来。
   */
  _applyDecision(choice, rule, suggestion) {
    let picked = choice;
    let topic = '';
    let behaviorId = '';
    if (choice && typeof choice === 'object') {
      picked = choice.choice || 'later';
      topic = String(choice.topic || '').trim();
      behaviorId = String(choice.behaviorId || '').trim();
    }
    // v4.11.0：应用画像路径——把接受/拒绝记进结晶，下次就更懂你
    const prof = suggestion && suggestion.appProfile;
    if (prof && prof.id) {
      const bid = behaviorId || (suggestion && suggestion.behaviorId) || '';
      this._recordOutcome(prof.id, bid, picked === 'generate' || picked === 'behavior');
    }
    if (picked === 'generate' || picked === 'behavior') {
      this.engine.userDecision(true);
      // v4.11.0：点了某个具体行为 → 按该行为的方向生成（游戏类只展示不插入）
      if (picked === 'behavior' && prof && prof.id && this._lastProfile) {
        this._runBehavior(this._lastProfile, behaviorId || (suggestion && suggestion.behaviorId) || '', suggestion, topic)
          .catch((e) => this.logger.warn('app-profile-behavior-failed', { error: e.message }));
        return;
      }
      // v4.10.2：「生成并插入」不再把建议问句填进剪贴板（旧实现把
      // "需要我帮你总结吗？"这种话术当成了"内容"，8 秒后还会被恢复机制
      // 冲掉，用户点了等于没点）。改为真正调远端生成一段可粘贴的内容，
      // 失败才退回旧的建议文案兜底。
      this._generateAndDeliver(suggestion, topic).catch((e) => this.logger.warn('generate-deliver-failed', { error: e.message }));
    } else if (picked === 'never') {
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

  /**
   * v4.10.2：真正执行「生成并插入」——
   * 走远端通道（stage=generate_content）基于屏幕观察 + 建议意图生成一段
   * 可粘贴的正文内容，写入剪贴板且不被 8 秒恢复机制冲掉；
   * 远端不可用/旧服务端无 content 字段时退回建议文案（保持旧兜底）。
   */
  async _generateAndDeliver(suggestion, topic) {
    let content = '';
    let remoteFailDetail = '';   // v4.12.0：远端失败原因，供本机兜底/最终报错
    // v4.10.40：生成步骤开始（实时反馈到持久化步骤面板）
    this._step('gen', { title: '正在生成内容', status: 'pending' });
    // v4.10.22 守卫：屏幕上没有可识别的正文内容时，不生成、不写剪贴板、不粘贴。
    // 这是「生成并插入总是粘贴模板」的真正根因——源素材为空，远端只能吐模板兜底。
    // 与其继续调 prompt 求模型别出模板，不如源头拦截并明确告诉用户原因。
    // v4.10.27：唯一的例外是用户在浮窗里填了主题——主题就是素材，直接放行。
    const _obs = this._lastObservation || '';
    const _topic = String(topic || '').trim();
    if (!_topic && !hasUsableSourceContent(_obs)) {
      this.logger.warn('predict-generate-no-source-content', {
        observation: _obs.slice(0, 120),
        intent: (suggestion && suggestion.intent) || '',
      });
      this._logEntry({
        phase: 'generated',
        status: 'no-source-content',
        intent: (suggestion && suggestion.intent) || '',
        observationPreview: _obs.slice(0, 200),
      });
      this._notifyNoSourceContent();
      this._step('gen', { title: '未识别到正文', status: 'warn', detail: '屏幕没有可编辑的正文，已跳过生成' });
      return;
    }
    // v4.10.34：VL 输出太泛（长度 < 50 且不含"正在文档中写作"）→ 视为无效观察，不生成。
    // 防止 VL 模型偷懒输出"光标在文档中"这类空话，服务端拿到只能瞎编。
    if (!_topic && _obs && _obs.length < 50 && !/正在文档中写作/.test(_obs)) {
      this.logger.warn('predict-generate-vague-observation', {
        observationLength: _obs.length,
        observationPreview: _obs.slice(0, 120),
        intent: (suggestion && suggestion.intent) || '',
      });
      this._logEntry({
        phase: 'generated',
        status: 'vague-observation',
        observationPreview: _obs.slice(0, 200),
      });
      this._notifyVagueObservation();
      this._step('gen', { title: '视觉描述太泛', status: 'warn', detail: '本机视觉未读到有效正文，已跳过生成' });
      return;
    }
    if (_topic) {
      this.logger.info('predict-generate-with-topic', { topic: _topic.slice(0, 80) });
      this._logEntry({
        phase: 'generated',
        status: 'with-topic',
        intent: (suggestion && suggestion.intent) || '',
        topic: _topic.slice(0, 200),
      });
    }
    // v4.10.2：内容生成走注入的 generateContentFn（main.js 里接远端通道）。
    // 不直接复用 this.channel/_resolveChannel——那会跟判断阶段的请求共用
    // 计数，测试断言「远端只被调一次」；且生成失败也不该影响主流程。
    if (typeof this._generateContentFn === 'function') {
      try {
        // v4.11.0：开启远端视觉时把截图一并上行——生成阶段也直接看图，
        // 不再依赖本机 VL 那句「光标在文档中」的转述。
        const _genImage = this._allowRemoteImage() ? (this._lastImageBase64 || null) : null;
        const res = await this._generateContentFn({
          stage: 'generate_content',
          rule: (suggestion && suggestion.intent) || '',
          suggestion: (suggestion && suggestion.suggestion) || '',
          reason: (suggestion && suggestion.reason) || '',
          screenObservation: this._lastObservation || '',
          windowTitle: this._lastWindowTitle || '',   // v4.10.23：文档名主题锚点
          // v4.10.24：场景规则自定义提示词方向（用户在设定框里写的推测方向）
          // v4.10.27：浮窗里手填的主题优先级最高——空白文档场景下它是唯一素材
          // v4.11.0：应用画像行为的 prompt 作为方向（用户点了某个具体行为）
          direction: _topic
            ? ('用户指定主题：' + _topic + '。请围绕该主题撰写正文内容。')
            : ((suggestion && suggestion.behaviorPrompt) || (suggestion && suggestion.sceneRule && suggestion.sceneRule.prompt) || ''),
          topic: _topic,   // 结构化透传（老服务端忽略该字段也不影响）
        }, _genImage);
        if (res && typeof res.content === 'string' && res.content.trim()) {
          content = res.content.trim();
          this.logger.info('predict-generate-ok', { chars: content.length, content_preview: content.slice(0, 500) });
          // v4.10.18：记录生成成功
          this._logEntry({
            phase: 'generated',
            status: 'ok',
            intent: (suggestion && suggestion.intent) || '',
            contentPreview: content.slice(0, 300),
            chars: content.length,
          });
          this._step('gen', { title: '已生成内容', status: 'done', detail: '共 ' + content.length + ' 字' });
        } else {
          // v4.10.42：透传服务端 error/reason；v4.12.0 不立即报错，先记原因走本机兜底。
          const errCode = res && res.error;
          const errReason = res && res.reason;
          remoteFailDetail = errCode
            ? ('服务端返回错误：' + errCode + (errReason ? '（' + errReason + '）' : ''))
            : '服务端未返回正文';
          this.logger.warn('predict-generate-no-content', {
            keys: res ? Object.keys(res) : null,
            error: errCode,
            reason: errReason,
          });
          this._logEntry({
            phase: 'generated',
            status: 'no-content',
            intent: (suggestion && suggestion.intent) || '',
            responseKeys: res ? Object.keys(res) : null,
            error: errCode,
            reason: errReason,
          });
        }
      } catch (e) {
        this.logger.warn('predict-generate-failed', { error: e.message });
        // v4.10.18：记录生成失败
        this._logEntry({
          phase: 'generated',
          status: 'failed',
          intent: (suggestion && suggestion.intent) || '',
          error: e.message,
        });
        remoteFailDetail = String(e.message || '生成异常');
      }
    } else {
      // 没有远端生成函数（未连接/旧环境）：直接走本机兜底，不再退建议文案。
      this.logger.warn('predict-generate-no-fn');
      remoteFailDetail = '远端生成通道不可用';
    }
    // v4.12.0：远端未生成正文时，用本机模型离线兜底；本机也不行才明确报错，
    // 绝不再把"需要我帮你做点什么吗"这类建议文案当正文插入。
    if (!content && remoteFailDetail) {
      content = await this._fallbackGenerate(suggestion, remoteFailDetail);
    }
    if (!content) {
      this._step('gen', { title: '生成失败', status: 'fail', detail: remoteFailDetail || '远端与本机均未生成内容' });
      this._notifyGenerateFailed(remoteFailDetail || '远端与本机均未生成内容');
      if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
      return;
    }
    // v4.11.0：建议类行为（游戏攻略/过程推荐等）只展示 + 写剪贴板，
    // 绝不往当前窗口里打字——在游戏里模拟输入是事故。
    if (suggestion && suggestion.noInsert) {
      try {
        if (this.actionExecutor) await this.actionExecutor.execute({ type: 'clipboard-keep', text: content });
      } catch (_) {}
      this._step('deliver', {
        title: '已生成建议',
        status: 'done',
        detail: content.length > 180 ? content.slice(0, 180) + '…' : content,
      });
      if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
      return content;
    }
    if (this.actionExecutor) {
      // v4.10.24：insertMode 配置决定回填方式。
      //   'type'（默认）= SendInput 逐字敲进当前窗体，不碰剪贴板；
      //   'paste' = 写剪贴板 + 模拟 Ctrl+V（旧行为，type 失败时也自动回退到它）。
      const mode = this.config.get('insertMode') || 'type';
      // v4.10.27：把触发时捕获的目标窗口句柄一起交给注入脚本，
      // 确保内容落在用户的文档窗口里，而不是被浮窗/主窗口抢焦点后的空处。
      const target = await this._resolveTargetWindow();
      const targetHwnd = target && target.hwnd ? target.hwnd : 0;
      if (targetHwnd) {
        this.logger.info('generate-deliver-target', { hwnd: String(targetHwnd), title: (target.title || '').slice(0, 80) });
        this._step('target', { title: '目标窗口已锁定', status: 'done', detail: (target.title || '当前窗口') });
      } else if (this._targetCaptureAttempted) {
        // v4.10.33：触发时发起过捕获却没拿到句柄——插入时刻的窗口已不可信
        //（实测：用户点按钮后切回对话页看记录，兜底现抓抓到的是对话窗口，
        // 内容会插错地方；注入脚本内的 Z 序回退同样会猜错）。绝不盲插：
        // 只写剪贴板并通知用户手动 Ctrl+V。
        this.logger.warn('generate-deliver-no-safe-target');
        this._step('target', { title: '未确定安全目标窗口', status: 'warn', detail: '插入时刻窗口已不可信，不盲插' });
        this._step('deliver', { title: '已放入剪贴板', status: 'warn', detail: '无法确定要插入的窗口，请到目标窗口按 Ctrl+V 粘贴（' + content.length + ' 字）' });
        await this.actionExecutor.execute({ type: 'clipboard-keep', text: content });
        this._notifyClipboardFallback(content.length);
        if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
        return;
      } else {
        this.logger.warn('generate-deliver-target-unknown');
        this._step('target', { title: '未捕获到目标窗口', status: 'warn', detail: '将尝试写入剪贴板' });
      }
      this._step('deliver', { title: '正在插入到目标窗口', status: 'pending', detail: (targetHwnd ? (target.title || '当前窗口') : '未锁定，将走剪贴板兜底') });
      const result = await this.actionExecutor.execute({
        type: mode === 'paste' ? 'clipboard-paste' : 'type-input',
        text: content,
        targetHwnd,
      });
      // v4.10.36：直接输入和自动粘贴都没能把内容送进目标窗口时（Windows 限制
      // 后台进程抢前台），内容已安全落在剪贴板。明确通知用户手动 Ctrl+V，
      // 不再像旧版那样静默"成功"、结果文档里什么都没有。
      if (result && result.ok === false && result.delivered === false) {
        this.logger.warn('generate-deliver-manual-paste', { chars: content.length });
        this._step('deliver', { title: '已生成但未自动送达', status: 'warn', detail: '内容已在剪贴板，请到目标窗口按 Ctrl+V 粘贴（' + content.length + ' 字）' });
        this._notifyClipboardFallback(content.length);
        return;
      }
    }
    this._notifyGenerated(content.length);
    // v4.10.40：插入成功步骤
    this._step('deliver', { title: '已直接输入到目标窗口', status: 'done', detail: '内容已写入当前窗体（' + content.length + ' 字）' });
    // v4.10.38：自动插入路径在 _onTrigger 中提前 return、不走其 finally，
    // 由这里收走「正在生成…」浮窗（手动点击路径的 finally 也会再收一次，幂等）。
    if (this.panel) { try { this.panel.cancelThinking(); } catch (_) {} }
  }

  /** 生成完成后的系统通知（Electron 主进程；测试/node 环境静默跳过）。 */
  _notifyGenerated(chars) {
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const n = new Notification({
          title: 'Hermes Buddy',
          body: '已生成 ' + chars + ' 字并直接输入到当前窗体',
          silent: true,
        });
        try { n.show(); } catch (_) {}
      }
    } catch (_) { /* node --test 环境无 electron */ }
  }

  /**
   * v4.10.42：生成失败时明确通知用户，而不是把建议文案当内容塞进去。
   */
  _notifyGenerateFailed(detail) {
    this.logger.info('predict-notify-generate-failed', { detail: String(detail || '').slice(0, 200) });
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const n = new Notification({
          title: 'Hermes Buddy',
          body: '生成失败：' + String(detail || '远端未返回正文').slice(0, 120) + '。建议检查服务端模型配置或稍后再试。',
          silent: true,
        });
        try { n.show(); } catch (_) {}
      }
    } catch (_) { /* node --test 环境无 electron */ }
  }

  /**
   * v4.10.33：无法确定安全目标窗口时的通知——内容只在剪贴板，等用户手动粘贴。
   */
  _notifyClipboardFallback(chars) {
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const n = new Notification({
          title: 'Hermes Buddy',
          body: '无法确定要插入的窗口，已把 ' + chars + ' 字生成内容放入剪贴板，请到目标窗口按 Ctrl+V 粘贴。',
          silent: true,
        });
        try { n.show(); } catch (_) {}
      }
    } catch (_) { /* node --test 环境无 electron */ }
  }

  /**
   * v4.10.22：源素材为空时的用户提示。明确告知「没识别到正文」，
   * 而不是静默失败或塞一个模板进去。
   */
  _notifyNoSourceContent() {
    this.logger.info('predict-notify-no-source-content');
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const n = new Notification({
          title: 'Hermes Buddy',
          body: '当前屏幕没有识别到正在编辑的正文内容，已跳过生成。请把光标放到文档正文中，或先选中一段文字再使用「生成并插入」。',
          silent: true,
        });
        try { n.show(); } catch (_) {}
      }
    } catch (_) { /* node --test 环境无 electron */ }
  }

  /** v4.10.34：VL 模型输出太泛（没有摘录文档正文）时的通知。 */
  _notifyVagueObservation() {
    this.logger.info('predict-notify-vague-observation');
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const n = new Notification({
          title: 'Hermes Buddy',
          body: '视觉模型没能读到文档内容（描述太泛），已跳过生成。请确保文档窗口处于前景且正文可见，稍后再试。',
          silent: true,
        });
        try { n.show(); } catch (_) {}
      }
    } catch (_) { /* node --test 环境无 electron */ }
  }

  /**
   * v4.12.0 统一分析：远端优先，断线/失败自动退回本机。
   *
   * 触发已由本地确定性规则决定，模型只负责触发后的「思考/解答」：
   *   - 远端通道可用（connected + supportsPredict）→ 走远端大模型，质量高；
   *   - 远端未连 / 不支持 predict / 超时 / 拒图 → 自动退回本机模型，全程无感；
   *   - 两者都不可用 → 抛错，由上层降级为规则模板。
   */
  async _analyze(behaviorContext, imageBase64) {
    if (imageBase64) this._lastImageBase64 = imageBase64;
    if (this._remoteUsable()) {
      try {
        return await _withTimeout(
          this._remoteAnalyze(behaviorContext, imageBase64, null),
          REMOTE_ANALYZE_TIMEOUT_MS,
          '远端模型响应超时'
        );
      } catch (e) {
        // 黑屏观察是截图本身无效，不该退回本机瞎猜，直接上抛静默处理
        if (/blank-screen/.test(e.message)) throw e;
        this.logger.warn('predict-remote-failed, fallback to local', { error: e.message });
        this._step('remote', { title: '远端不可用，退回本机', status: 'warn', detail: String(e.message || '远端失败') });
      }
    }
    return _withTimeout(
      this._localAnalyze(behaviorContext, imageBase64),
      LOCAL_ANALYZE_TIMEOUT_MS,
      '本地模型推理超时'
    );
  }

  /**
   * 远端通道是否可用：对象存在 + connected + supportsPredict。
   * 仅做预判；真正调用 reject（channel_no_predict/超时/拒图）仍由 _analyze 兜底。
   */
  _remoteUsable() {
    let ch = this.channel;
    if (!ch && this._resolveChannel) {
      try { ch = this._resolveChannel(); } catch (_) { ch = null; }
    }
    return !!(ch && ch.connected && ch.supportsPredict !== false);
  }

  /**
   * v4.10.3：清洗远端返回——服务端 JSON 解析失败兜底时会把 ```` ```json ```` 围栏
   * 原文（可能还被截断）塞进 suggestion，UI 会直接显示一坨代码。
   * 依次尝试：抽完整 JSON 对象 → 正则抽 suggestion 字段 → 剥围栏取首句。
   */
  _cleanRemoteResult(result) {
    if (!result || typeof result !== 'object') return result;
    const s = result.suggestion;
    if (typeof s !== 'string' || !/```|\{"/.test(s)) return result;
    const trimmed = s.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj && typeof obj.suggestion === 'string' && obj.suggestion.trim()) {
          result.suggestion = obj.suggestion.trim();
          if ((!result.reason || /```/.test(String(result.reason))) && typeof obj.reason === 'string' && obj.reason.trim()) {
            result.reason = obj.reason.trim();
          }
          return result;
        }
      } catch (_) { /* JSON 不完整，走字段抽取 */ }
    }
    const field = trimmed.match(/"suggestion"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (field) {
      try { result.suggestion = JSON.parse('"' + field[1] + '"'); } catch (_) { result.suggestion = field[1]; }
      return result;
    }
    result.suggestion = trimmed.replace(/```[a-z]*/gi, '').split('\n').filter(Boolean)[0] || '需要我帮你做点什么吗？';
    return result;
  }

  /** 本地小模型推断（判断意图 + 建议）。 */
  async _localAnalyze(behaviorContext, imageBase64) {
    if (this._predictFn) return this._predictFn(behaviorContext, imageBase64);
    const runner = this._runner();
    if (!runner) throw new Error('本地模型未就绪（请先安装 VLM 引擎）');
    return runner.analyze({ imageBase64, behaviorContext });
  }

  /**
   * v4.12.0：本机正文生成（远端断线/生成失败时的兜底）。
   * 调本机 runner.generate；测试可注入 this._localGenerateFn。
   */
  async _localGenerate({ topic, direction, observation }) {
    if (typeof this._localGenerateFn === 'function') {
      return this._localGenerateFn({ topic, direction, observation });
    }
    const runner = this._runner();
    if (!runner || typeof runner.generate !== 'function') return '';
    return runner.generate({
      topic: topic || '',
      direction: direction || '',
      observation: observation || '',
      imageBase64: this._lastImageBase64 || '',
    });
  }

  /**
   * v4.12.0：远端生成失败/未返回时的本机离线兜底。
   * @returns {Promise<string>} 本机生成的正文；不可用返回空串（调用方决定报错）。
   */
  async _fallbackGenerate(suggestion, remoteDetail) {
    this._step('gen', { title: '远端未生成，本机离线生成中', status: 'pending', detail: String(remoteDetail || '改用本机模型') });
    const topic = (suggestion && suggestion.topic) || this._lastWindowTitle || '';
    const direction = (suggestion && suggestion.behaviorPrompt) || '';
    let text = '';
    try {
      text = await _withTimeout(
        this._localGenerate({ topic, direction, observation: this._lastObservation || '' }),
        LOCAL_GENERATE_TIMEOUT_MS,
        '本机离线生文超时'
      );
    } catch (e) {
      this.logger.warn('predict-generate-local-failed', { error: e.message });
      text = '';
    }
    if (text && text.trim()) {
      text = text.trim();
      this.logger.info('predict-generate-local-ok', { chars: text.length });
      this._logEntry({
        phase: 'generated',
        status: 'ok-local',
        intent: (suggestion && suggestion.intent) || '',
        chars: text.length,
        contentPreview: text.slice(0, 300),
      });
      this._step('gen', { title: '本机已离线生成内容', status: 'done', detail: '共 ' + text.length + ' 字' });
      return text;
    }
    return '';
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
      // v4.11.0：远程视觉优先。
      // 设计前提改成「服务端接的是多模态模型」——图形判断一律交给远端，
      // 本机 3B VL 只读屏转述会丢信息（实测只输出"光标在文档中"这类空话），
      // 是过去意图判断不准的根因之一。只有远端明确吃不下图片时，才退回本机 VL。
      // v4.12.1：截图是否发远端统一由 remoteVision 决定（sendImageToServer 已移除）
      const remoteVision = this.config.get('remoteVision') !== false;
      const allowImage = remoteVision;
      let image = imageBase64;
      let observation = '';
      if (imageBase64 && allowImage) {
        this._step('vl', { title: '远端视觉模型看图', status: 'pending', detail: '截图已随请求上传，由服务端多模态模型判断' });
        this.logger.info('predict-vision-remote', { imageChars: imageBase64.length, remoteVision: true });
        // 本地筛选阶段若顺带产出了 observation，一并带上（多一路线索，不冲突）
        if (localJudgment && typeof localJudgment.observation === 'string' && localJudgment.observation.trim()) {
          observation = localJudgment.observation.trim();
        }
      } else if (imageBase64) {
        this._step('vl', { title: '本机视觉模型读图中', status: 'pending', detail: '把截图读成文字描述（未开启远端视觉）' });
        observation = await this._localVisionToText(behaviorContext, imageBase64, localJudgment);
        image = null;
        // v4.10.1：把描述内容截断进日志——出了「建议驴唇不对马嘴」的问题时
        // 能直接看出是 VL 描述错了还是远端模型想岔了。
        this.logger.info('predict-vision-local', {
          observationChars: observation.length,
          observationPreview: observation.slice(0, 120),
          imageSent: false,
        });
        if (observation) {
          this._step('vl', { title: '本机视觉读图完成', status: 'done', detail: '已读图（' + observation.length + ' 字）' });
        } else {
          this._step('vl', { title: '本机视觉未响应', status: 'warn', detail: '视觉模型未就绪/超时，已不带视觉信息继续' });
        }
      } else if (allowImage) {
        this._step('vl', { title: '视觉', status: 'info', detail: '已开启发送原图，直接上传服务端' });
      } else {
        this._step('vl', { title: '视觉', status: 'warn', detail: '无截图，未做视觉读图' });
      }

      const ctx = Object.assign({}, behaviorContext);
      // v4.10.3：VL 描述说「黑屏/没有可见内容」→ 截图根本没拍到有效画面
      // （黑帧/锁屏/最小化窗口）。把这种描述发给远端只会诱导它瞎猜
      // （实测连续 5 轮黑屏描述 → 远端给出 0.9 置信度的 api_lookup），
      // 直接放弃本轮，上层静默处理，不弹卡。
      if (observation && /(黑屏|全黑|纯黑|漆黑|没有可见|没有显示任何|black\s*screen|blank)/i.test(observation.slice(0, 100))) {
        this.logger.warn('predict-vision-blank', { observationPreview: observation.slice(0, 60) });
        this._step('vl', { title: '本机视觉读图失败', status: 'fail', detail: '黑屏/无可见内容，本轮已跳过' });
        throw new Error('blank-screen-observation');
      }
      if (observation) ctx.screenObservation = observation;
      // v4.10.2：留一份观察描述，用户点「生成并插入」时作为生成上下文
      this._lastObservation = observation;
      // v4.10.23：窗口标题（Word/WPS 的窗口标题就是文档名）随生成请求上行——
      // 小 VL 模型实测读不出文档正文，窗口标题是最可靠的主题线索。
      this._lastWindowTitle = String(ctx.title || behaviorContext.title || '');
      if (localJudgment) {
        ctx.localJudgment = { intent: localJudgment.intent, confidence: localJudgment.confidence };
        ctx.stage = 'deep_think';
      }
      this._remoteInFlight = true;
      this._remotePromise = ch.predict(ctx, image);
      // v4.10.40：远端推理步骤实时反馈
      this._step('remote', { title: '已发送远端推理', status: 'pending', detail: '等待 Hermes 服务端回馈…' });
      // v4.10.37：请求此刻才真正在途。重置思考安全网，只覆盖在途请求（对齐 90s），
      // 不含前面本机 VL 的 14~27s，避免正确结果在最后一刻被判超时丢弃。
      this._rearmPanelSafety();
      try {
        const result = await this._remotePromise;
        // v4.10.3：服务端 JSON 解析失败时可能把 ```json 围栏原文塞进 suggestion
        this._cleanRemoteResult(result);
        // v4.11.0：远端吃不下图片（上游是纯文本模型）→ 退回本机 VL 转文字再问一次
        if (image && _visionUnsupported(result)) {
          this._step('vl', { title: '远端不支持图片', status: 'warn', detail: '改用本机视觉模型读图后重试' });
          try {
            return await this._retryWithLocalVision(ch, ctx, imageBase64, localJudgment);
          } catch (e2) {
            this.logger.warn('predict-vision-fallback-failed', { error: e2.message });
          }
        }
        // v4.10.1：远端结论落日志——suggestion/reason 是排查「提示不对」的第一现场。
        this.logger.info('predict-remote-result', {
          windowClass: ctx.windowClass || null,
          exeName: ctx.exeName || null,
          intent: result && result.intent,
          confidence: result && result.confidence,
          suggestion: result && result.suggestion ? String(result.suggestion).slice(0, 80) : '',
          reason: result && result.reason ? String(result.reason).slice(0, 80) : '',
        });
        const rc = result && Number(result.confidence);
        this._step('remote', {
          title: '远端已回馈',
          status: 'done',
          detail: '意图：' + ((result && result.intent) || '未知') + (Number.isFinite(rc) ? '（置信度 ' + rc.toFixed(2) + '）' : ''),
        });
        return result;
      } catch (e) {
        // v4.11.0：带图的远端请求直接失败（上游拒图/超时）→ 用本机 VL 描述再试一次
        if (image) {
          try {
            return await this._retryWithLocalVision(ch, ctx, imageBase64, localJudgment);
          } catch (e2) {
            this.logger.warn('predict-vision-fallback-failed', { error: e2.message });
          }
        }
        this._step('remote', { title: '远端未回馈', status: 'fail', detail: String(e.message || '远端推理失败') + '，将降级处理' });
        throw e;
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
   * v4.11.0：远端吃不下图片时的退路——把截图交给本机 VL 读成文字，再问一次（不带图）。
   * 本机 VL 冷启动/不可用时抛错，由调用方决定继续降级还是放弃。
   */
  async _retryWithLocalVision(ch, ctx, imageBase64, localJudgment) {
    this._step('vl', { title: '改用本机视觉模型读图', status: 'pending', detail: '把截图读成文字描述后重新提问' });
    const observation = await this._localVisionToText(ctx, imageBase64, localJudgment);
    if (!observation) throw new Error('本机视觉模型不可用，无法降级');
    const ctx2 = Object.assign({}, ctx);
    ctx2.screenObservation = observation;
    ctx2.visionFallback = true;   // 让服务端知道这次是文字描述，不再是原图
    this._lastObservation = observation;
    this.logger.info('predict-vision-fallback', { observationPreview: observation.slice(0, 120) });
    this._step('vl', { title: '本机视觉读图完成', status: 'done', detail: '已读图（' + observation.length + ' 字），重新提问中' });
    const result = await ch.predict(ctx2, null);
    this._cleanRemoteResult(result);
    this._step('remote', {
      title: '远端已回馈（本机视觉降级）',
      status: 'done',
      detail: '意图：' + ((result && result.intent) || '未知'),
    });
    return result;
  }

  /**
   * v4.10.0：把截图交给本机 VL 模型，产出一段客观文字描述，供远端纯文本模型使用。
   *
   * @returns {string} 描述文本；本机模型不可用/超时/无内容时返回空串（调用方降级为「不带视觉信息」）。
   */
  async _localVisionToText(behaviorContext, imageBase64, localResult) {
    // 本地筛选阶段已经跑过一次 VLM：如果它顺带给出了 observation 就直接用，
    // 不再为同一张图付第二次 11~15s 的 CPU 推理代价。
    if (localResult && typeof localResult.observation === 'string' && localResult.observation.trim()) {
      return localResult.observation.trim();
    }
    if (!imageBase64) return '';
    // 本机模型还没热启时不要为「描述」去冷启动（2.6GB 加载可能 60s+）：
    // 宁可这一轮不带视觉信息，交给后台 warmLocalModel 预热，下一轮就有。
    if (!this._isLocalWarm()) {
      this.logger.info('predict-vision-local-cold, skip description');
      return '';
    }
    try {
      const text = await _withTimeout(
        this._describeScreen(behaviorContext, imageBase64),
        LOCAL_SCREEN_TIMEOUT_MS,
        '本机视觉描述超时'
      );
      return (text || '').trim();
    } catch (e) {
      // 描述失败不阻断主流程：服务端至少还有行为元数据可用
      this.logger.warn('predict-vision-local-failed', { error: e.message });
      return '';
    }
  }

  /** 调本机 runner 的 describe（旧 runner 无 describe 时退回 analyze 的 observation 字段）。 */
  async _describeScreen(behaviorContext, imageBase64) {
    if (typeof this._describeFn === 'function') {
      return this._describeFn(behaviorContext, imageBase64);
    }
    const runner = this._runner();
    if (!runner) return '';
    if (typeof runner.describe === 'function') {
      return runner.describe({ imageBase64, behaviorContext });
    }
    const r = await runner.analyze({ imageBase64, behaviorContext });
    return (r && r.observation) || '';
  }

  /** 懒建 LocalModelRunner（默认按 llama-engine 查找）；测试可注入 this.modelRunner。 */
  _runner() {
    if (this.modelRunner) return this.modelRunner;
    if (!this.buildRunner) return null;
    this.modelRunner = this.buildRunner(this.config);
    return this.modelRunner;
  }

  /** 本机模型是否已热启（决定读图描述是否复用，避免为描述而冷启动）。 */
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

  /**
   * 走模型分析时先弹「思考中」浮窗（带转圈 loading），分析完由 panel.show 换成结果。
   * 纯规则降级（不走模型）不弹，避免秒闪。
   */
  _showThinking(text) {
    if (!this.panel || typeof this.panel.showThinking !== 'function') return;
    try { this.panel.showThinking(text || '思考中…'); } catch (_) {}
  }

  /**
   * v4.10.40：开一轮流水线，推一条分隔步骤（步骤面板聊天小框观感）。
   */
  _beginFlowStep(label) {
    if (this.panel && typeof this.panel.beginFlow === 'function') {
      try { this.panel.beginFlow(label); } catch (_) {}
    }
  }

  /**
   * v4.10.40：向持久化步骤面板推送/更新一条步骤。
   * @param {string} id 同轮内用于去重更新
   * @param {{title?:string,status?:string,detail?:string}} opts
   */
  _step(id, opts = {}) {
    if (this.panel && typeof this.panel.pushStep === 'function') {
      try { this.panel.pushStep(id, opts); } catch (_) {}
    }
  }

  /**
   * v4.10.37：服务端请求真正发出后，把思考安全网重新计时为「只覆盖在途请求」。
   * 旧逻辑安全网从 showThinking 起按 45s 计时，本机 VL 的 14~27s 被计入，导致
   * 服务端 37~72s 的正常结果总被判超时。无 panel / 无 arm 方法时静默跳过。
   */
  _rearmPanelSafety(ms) {
    if (!this.panel || typeof this.panel.armThinkingTimeout !== 'function') return;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : PANEL_INFLIGHT_SAFETY_MS;
    try { this.panel.armThinkingTimeout(delay); } catch (_) {}
    this.logger.info('predict-panel-safety-rearmed', { ms: delay });
  }

  /**
   * v4.10.38：是否对该意图自动生成正文。
   * 要求 autoInsert 开启，且是明确「要出正文」的意图；reading_or_thinking 这类
   * 「发呆/斟酌」模糊意图不自动写（否则一发呆就往文档里塞字）。
   * v4.12.1：纳入 message_reply——微信/邮件回复本质是要一条可粘贴的回复正文，
   * 用户主动点猫后不应只拿到一句问话、停在确认框（实测"远端没信息"根因）。
   */
  _shouldAutoInsert(intent) {
    if (this.config.get('autoInsert') !== true) return false;
    return intent === 'word_writing' || intent === 'message_reply';
  }

  /** v4.11.0/v4.12.1：是否把截图发往服务端（判断与生成两阶段共用）。
   *  统一由 remoteVision 决定；旧的 sendImageToServer 已移除。 */
  _allowRemoteImage() {
    return this.config.get('remoteVision') !== false;
  }

  // ---------------- 配置 / 状态 ----------------

  getStatus() {
    const cooldownRemainingMs = Math.max(0, this.engine.cooldownUntil - Date.now());
    return {
      enabled: this._enabled,
      authorized: this.config.get('authorized'),
      sensitivity: this.config.get('sensitivity'),
      state: this.engine.state,
      cooldownRemainingMs,
      processing: this._processing,
      av: detectAntivirus().map((a) => a.name),
      crystallization: this.db.getCrystallization(),
      // v4.12.0：远端通道当前是否可用（供 UI 展示解答来源）
      remoteUsable: this._remoteUsable(),
      // v4.2
      proactivePatrolMinutes: Number(this.config.get('proactivePatrolMinutes')) || 0,
      genericWritingFallback: this.config.get('genericWritingFallback') !== false,
    };
  }

  /**
   * v4.12.6：本机模型改为「纯懒启动」。
   *
   * 用户诉求＝推理默认走远端，不要被本地 2.6GB 模型拖累/拖卡。
   * 因此：
   *   - 远端可用时：完全不自动拉起本地模型（零进程、零占用）；
   *     远端万一在某轮失败，runner.generate 自身会 `await start()` 按需顶上
   *     （兜底路径天然懒启动，见 local-model-runner.generate）。
   *   - 远端不可用时（断线）：立即启动本地模型兜底，保证离线仍可用。
   * 之前的「延迟 30s 预热」已取消 —— 即便延迟，30s 后仍会无谓占用内存，
   * 且它启动那一刻仍可能造成短暂卡顿。
   */
  async warmLocalModel() {
    const runner = this._runner();
    if (!runner) return { ok: false, reason: '本地模型未安装' };
    if (runner.started) return { ok: true, reason: '本地模型已就绪' };
    // 远端可用 → 不预热，零占用
    if (this._remoteUsable()) {
      this.logger.info('predict-local-skipped-remote-usable');
      return { ok: false, reason: '远端可用，本地模型按需懒启动' };
    }
    // 远端不可用 → 立即拉起兜底
    this.logger.info('predict-local-start-offline-fallback');
    if (!this._enabled) return { ok: false, reason: '预测已关闭' };
    try {
      await runner.start();
      return { ok: true, reason: '本地模型已启动（离线兜底）' };
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
    // v4.10.18：记录主动触发
    this._logEntry({
      phase: 'trigger',
      rule: 'proactive',
      reason: '用户主动预测（点桌宠/按钮）',
    });
    try {
      // v4.10.27：主动预测也要趁早抓目标句柄（点按钮后前台会是本应用，
      // 这里捕获时脚本会自动沿 Z 序跳到用户上一个窗口）
      this._startTargetCapture();
      // 跳过 TRIGGERED：直接进入 ANALYZING（截图 → 模型）
      this.engine.state = 'ANALYZING';

      // v4.10.12：取一次前台窗口（截图源匹配 + 身份兜底都用它）。
      // 注意：主动点猫时 OS 前台就是桌宠自己，这里拿到的 wi 是桌宠身份，
      // 不能直接当「用户正在用的应用」——真实身份要从截图源标题反推（见 _applyScreenIdentity）。
      let wi = null;
      try { wi = await this.resolveWindow(); } catch (_) { /* 前台解析失败不拦截 */ }
      const fgTitle = (wi && wi.title) || '';

      let imageBase64 = null;
      let shotSource = null;
      if (this.capture) {
        try {
          const shot = await _withTimeout(
            this.capture.captureActiveWindow({
              skipName: /hermes buddy|hermes-buddy|桌宠|buddy/i,
              fgTitle,
            }),
            CAPTURE_AWAIT_TIMEOUT_MS,
            '截图取源超时'
          );
          imageBase64 = shot && shot.base64;
          shotSource = shot && shot.source;
        } catch (e) {
          this.logger.warn('predict-now-capture-failed', { error: e.message });
        }
      }

      // v4.10.12：用截到的真实窗口标题覆盖桌宠前台身份（点猫误判根因）。
      const ctx = this.engine._snapshot();
      this._applyScreenIdentity(ctx, shotSource, wi);
      const rule = this._inferRuleFromContext(ctx);
      // v4.11.0：主动推测同样记录行为模式（供结晶判断哪些行为是真需求）
      const pHit = lookupApp({ exeName: ctx.exeName, windowClass: ctx.windowClass, title: ctx.title })
        || lookupApp(wi || {});
      if (pHit && this.config.get('appProfilesEnabled') !== false) {
        this._lastProfile = pHit.profile;
        for (const b of behaviorsOf(pHit.profile)) {
          this._recordBehavior(pHit.profile.id, b.id, b.intent, b.suggestion, true);
        }
      }
      const behaviorContext = Object.assign({ rule, proactive: true }, ctx);

      this._showThinking('思考中…');
      let result;
      try {
        result = await this._analyze(behaviorContext, imageBase64);
      } catch (e) {
        // v4.10.3：黑屏观察 → 静默放弃（与 _onTrigger 同理，别瞎弹卡）
        if (/blank-screen/.test(e.message)) {
          this.logger.warn('predict-skip-blank-observation');
          this.engine.modelTimeout();
          return { shown: false, reason: '截图为黑帧，跳过本轮预测' };
        }
        // v4.12.0：远端与本机模型都不可用 → 降级为窗口类型推断
        this.logger.warn('predict-now-analyze-failed, degrade', { error: e.message });
        result = {
          intent: rule || 'none',
          confidence: 0.7,
          suggestion: (rule && RULE_TEMPLATE[rule]) || PROACTIVE_TEMPLATE,
          reason: '主动预测：模型未就绪，已降级为窗口类型推断（' + e.message + '）',
        };
      }
      if (!result) { this.engine.modelTimeout(); return { shown: false, reason: '没有拿到模型结果' }; }
      _ungenericServerDegrade(result);   // v4.9.3：服务端降级话术 → 场景规则模板
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
      // v4.10.18：记录分析结果
      this._logEntry({
        phase: 'analyzed',
        rule: rule || '',
        intent: result.intent || '',
        confidence: result.confidence || 0,
        suggestion: (result.suggestion || '').slice(0, 200),
        reason: (result.reason || '').slice(0, 200),
        suggest: r2.suggest,
        proactive: true,
      });
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

      // v4.11.0：主动预测也带上应用画像的行为按钮（用户可直接点某个行为）
      if (pHit) {
        const ps = this._profileSuggestion(pHit, wi || {});
        suggestion.behaviors = ps.behaviors;
        suggestion.appProfile = ps.appProfile;
        suggestion.behaviorPrompt = ps.behaviorPrompt;
        suggestion.behaviorId = ps.behaviorId;
      }

      // v4.12.1：用户主动点猫＝明确要答案。明确「要出正文」的意图（写作/微信
      // 邮件回复）直接生成正文投递，不再停在确认框——旧逻辑等 23s 只看到一句
      // 问话、还需再点一次才出正文，用户没点到或超时，导致「远端没信息」。
      if (this._shouldAutoInsert(suggestion.intent)) {
        this.logger.info('predict-now-auto-generate', { intent: suggestion.intent });
        this._logEntry({
          phase: 'decision', rule: rule || '', intent: suggestion.intent,
          suggestion: (suggestion.suggestion || '').slice(0, 200),
          choice: 'auto-generate', proactive: true,
        });
        this.engine.userDecision(true);
        this._step('decide', { title: '正在为你生成', status: 'pending', detail: '主动预测：明确意图直接出正文（不再等待点击）' });
        this._showThinking('正在生成…（可能需要约 1 分钟）');
        this._rearmPanelSafety(PANEL_GENERATE_SAFETY_MS);
        try {
          await this._generateAndDeliver(suggestion, '');
        } catch (e) {
          this.logger.warn('predict-now-auto-generate-failed', { error: e.message });
        }
        return { shown: true, choice: 'auto-generate', intent: suggestion.intent };
      }

      let choice = 'later';
      if (this.panel) {
        const shown = this._decorateSuggestion(suggestion);
        // 游戏里看画面给建议即可，不该让用户手填主题
        if (pHit && isGame(pHit.profile)) { shown.needTopic = false; shown.topicHint = ''; }
        choice = await this.panel.show(shown);
      }
      // v4.10.18：记录用户决策（带主题时只记长度，避免整段主题进日志）
      this._logEntry({
        phase: 'decision',
        rule: rule || '',
        intent: suggestion.intent || '',
        suggestion: (suggestion.suggestion || '').slice(0, 200),
        choice: choice,
        proactive: true,
      });
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

module.exports = { PredictController, RULE_TEMPLATE, PROACTIVE_TEMPLATE, hasUsableSourceContent, normalizeSceneRules };
