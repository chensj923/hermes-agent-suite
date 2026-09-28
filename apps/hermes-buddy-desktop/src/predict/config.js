'use strict';

/**
 * 智能预测子系统配置（纯 JS，零 Electron 依赖，可在 node 下直接测试）。
 *
 * 数据目录由调用方注入（主进程用 app.getPath('userData')/predict，测试用临时目录），
 * 这样本模块不 import('electron')，node --test 也能直接加载。
 */

const fs = require('fs');
const path = require('path');

/** 默认配置。改这里等于改默认值；落盘文件只存差异字段，merge 时以落盘为准。 */
const DEFAULT_CONFIG = {
  // 总开关。安装向导里用户授权后才置 true。
  enabled: false,
  // v4.12.0：运行模式已彻底移除，用户不再选择 local/remote/hybrid。
  // 触发永远由本地确定性规则（app-profiles 画像 + 行为引擎 + 结晶）判断；
  // 连着远端通道时思考/解答走远端大模型，断线自动退回本机模型，全程无感。
  // 本地 VLM 具体用哪个
  vlmModel: 'qwen2.5-vl-3b',
  // v4.7：用户指定本地 GGUF 模型/视觉投影文件的绝对路径（空 = 用 userData/vlm 目录里自动下载的那份）
  vlmModelPath: '',
  vlmMmprojPath: '',
  // 灵敏度乘子：>1 更敏感（阈值更低、更易触发），<1 更迟钝。默认 1。
  sensitivity: 1.0,
  // 全局冷却（毫秒）：一次建议后到下一次允许建议的最小间隔。
  cooldownInitialMs: 5 * 60 * 1000,
  cooldownMaxMs: 30 * 60 * 1000,
  // 模型返回置信度达到该值才弹窗，否则视为「不该打扰」。
  confidenceThreshold: 0.6,
  // 行为上下文窗口（毫秒）：超过即认为上下文过期，不触发。
  contextWindowMs: 30 * 1000,
  // 应用窗口类名映射（规则用逻辑名匹配，便于用户扩展）。值来自 Win32 GetClassName。
  // v4.2 扩充：覆盖 WPS / PPT / PDF 阅读器 / 终端 / 微信 / Office 新版等常见窗口类，
  // 否则在 Word/Excel 之外的应用里一条规则都命中不了（触发率低的根因）。
  appClassMap: {
    // 写作 / 文档
    word: ['OpusApp', 'Wps_Application', 'WinWord', 'Chrome_WidgetWin_1_Doc', 'Notepad', 'AkitaMainWindow'],
    // 表格 / 数据录入
    excel: ['XLMainClient', 'ETMainClass', 'EXCEL7', 'TAppMainFrame'],
    // 浏览器（Chrome / Edge / Firefox / 360 / QQ 浏览器）
    browser: ['Chrome_WidgetWin_1', 'MozillaWindowClass', '360se6_Frame', 'QQBrowser_WidgetWin_1'],
    // 编辑器 / IDE
    vscode: ['Chrome_WidgetWin_1'], // VSCode 与 Chrome 同窗类，真正区分靠 exe 名，hook 层处理
    ide: ['CASCADIA_HOST', 'VisualStudioIDE', 'VSCodeIDE', 'Qt5152QWindowIcon', 'SunAwtFrame', 'py.exe'],
    // PPT / 演示
    ppt: ['PPTFrameClass', 'PP11FrameClass', 'screenClass'],
    // PDF / 阅读器
    pdf: ['AcrobatSDIWindow', 'AcroRd32ChWnd', 'SUMATRA_PDF_FRAME', 'FoxitReader'],
    // 终端
    terminal: ['ConsoleWindowClass', 'mintty', 'VirtualConsoleClass', 'PseudoConsoleWindow'],
    // 即时通讯（微信 / 企业微信 / QQ）
    im: ['WeChatMainWndForPC', 'WeWorkWindow', 'TXGuiFoundation']
  },
  // 隐私边界（写入安装向导，用户可见）。
  privacy: {
    keyboardRecordsRhythmOnly: true, // 只记按键节奏（时间戳），不记内容
    screenshotOnlyOnTrigger: true, // 仅触发时截一帧
    screenshotDeleteAfterMs: 30 * 1000, // 分析完 30 秒内删除
    behaviorLogTtlMs: 7 * 24 * 60 * 60 * 1000, // 行为日志只留 7 天
    oneClickOff: true // 一键关闭，立即停止所有监听
  },
  // v4.12.1：截图是否直接发给远端看图（远程视觉）。默认 true——已实测远端具备
  // 视觉能力，图形判断一律交给远端；本机 3B VL 转述会丢信息（实测只输出「光标
  // 在文档中」这类空话）。远端明确拒图时客户端自动退回本机 VL（不受此值影响）。
  // 置 false 则固定走「本机 VL 读成文字再发服务端」（服务端是纯文本模型时才需要）。
  // 旧的 sendImageToServer 开关已移除（与本字段语义重叠、设置页无入口）。
  remoteVision: true,
  // v4.11.0：应用画像库（约 100 种软件 × 3 个常用行为）开关。命中应用时
  // 直接把这个应用最常用的 3 件事摆给用户选，而不是让远端模型从零猜。
  appProfilesEnabled: true,
  // v4.12.14：语音（TTS/STT）。TTS 用 Windows SAPI 离线朗读回复；STT 用本地
  // Whisper（media-engines 一键安装）把麦克风语音转成文字。speakerId/micId 由渲染层
  // enumerateDevices 取得（audiooutput / audioinput 的 deviceId）；voiceName 为 SAPI 语音名。
  voice: {
    enabled: false,        // 总开关（设置里打开）
    speakerId: '',         // 扬声器 deviceId（空=系统默认）
    micId: '',             // 麦克风 deviceId（空=系统默认）
    voiceName: '',         // SAPI 语音名（空=系统默认中文语音）
    rate: 0,               // SAPI 语速 -10..10
    volume: 100,           // SAPI 音量 0..100
    hotkey: 'Ctrl+Alt+F1', // 推话筒快捷键（globalShortcut 注册）
    readAloud: true,       // 预测回复自动朗读
    sttEnabled: true       // 允许 STT（麦克风收音）
  },
  // 确认框等点击，而是直接走远端生成并把正文打进目标窗口（WPS/Word）；生成期间
  // 浮窗保留并显示「正在生成…」。仅对明确写作意图生效，reading_or_thinking 等
  // 模糊意图仍只提示不自动写。置 false 回到「先确认再生成」的旧行为。
  autoInsert: true,
  // v4.2：通用兜底规则。开启后「任意窗口里打字停顿 + 输入量足够」即触发写作类预判，
  // 不再要求必须是 Word——解决在 WPS / 记事本 / 微信 / 浏览器表单 / IDE 里完全不触发的问题。
  genericWritingFallback: true,
  // v4.2：桌宠主动巡检间隔（分钟）。0 = 关闭（默认）。>0 时桌宠可见期间每隔 N 分钟
  // 主动看一次屏幕，判断出有事可做才弹窗；无模型时跳过，避免无效打扰。
  proactivePatrolMinutes: 0,
  // 安装时用户是否已显式授权（钩子授权）。未授权则整体不启用，无降级。
  authorized: false
};

class PredictConfig {
  constructor({ dataDir, defaults } = {}) {
    if (!dataDir) throw new Error('PredictConfig 需要 dataDir');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this._defaults = Object.assign({}, DEFAULT_CONFIG, defaults || {});
    this._cache = null;
  }

  _ensureDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /** 深合并：数组/基本类型直接覆盖；对象递归。落盘值优先于默认。 */
  _merge(base, over) {
    if (base === null || typeof base !== 'object' || Array.isArray(base)) {
      return over === undefined ? base : over;
    }
    const out = Object.assign({}, base);
    for (const k of Object.keys(over || {})) {
      const bv = base[k];
      const ov = over[k];
      if (bv && typeof bv === 'object' && !Array.isArray(bv) && ov && typeof ov === 'object' && !Array.isArray(ov)) {
        out[k] = this._merge(bv, ov);
      } else {
        out[k] = ov;
      }
    }
    return out;
  }

  load() {
    let dirty = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._cache = this._merge(this._defaults, parsed);
    } catch (_) {
      // 文件不存在或损坏 → 用默认。注意：不写盘，等 set() 才落盘。
      this._cache = JSON.parse(JSON.stringify(this._defaults));
    }
    // v4.12.0 迁移：彻底移除运行模式。老用户落盘里可能残留 model 键，
    // 显式删除避免旧值造成困惑；若旧值是本地模型 id，先保留到 vlmModel。
    const legacyModels = ['qwen2.5-vl-3b', 'smolvlm2'];
    if (Object.prototype.hasOwnProperty.call(this._cache, 'model')) {
      const old = this._cache.model;
      if (legacyModels.includes(old)) this._cache.vlmModel = old;
      delete this._cache.model;
      dirty = true;
    }
    if (!legacyModels.includes(this._cache.vlmModel)) {
      this._cache.vlmModel = this._defaults.vlmModel || 'qwen2.5-vl-3b';
      dirty = true;
    }
    // v4.12.1 迁移：sendImageToServer 开关已移除（与 remoteVision 语义重叠、
    // 设置页无入口）。老用户落盘残留 false 时，每轮都冷启动本机 2.6GB 小模型
    // 读图（实测 23s）并与桌宠抢资源，是卡顿直接根因。显式删除该键：截图是否
    // 发远端统一由 remoteVision 决定（默认 true）；远端拒图时自动退回本机 VL。
    if (Object.prototype.hasOwnProperty.call(this._cache, 'sendImageToServer')) {
      delete this._cache.sendImageToServer;
      dirty = true;
    }
    if (dirty) {
      try { this._ensureDir(); fs.writeFileSync(this.file, JSON.stringify(this._cache, null, 2), 'utf8'); } catch (_) {}
    }
    return this._cache;
  }

  /** 返回整个配置对象（含默认值）。首次访问自动 load。 */
  _all() {
    if (!this._cache) this.load();
    return this._cache;
  }

  /**
   * 读配置。
   * - get()（无参）→ 返回整个配置对象
   * - get('enabled') → 返回该字段
   * - get('privacy.behaviorLogTtlMs') → 支持点路径
   */
  get(key) {
    const all = this._all();
    if (key === undefined) return all;
    return String(key).split('.').reduce((o, k) => (o == null ? undefined : o[k]), all);
  }

  /** 局部合并并落盘。patch 只能包含 config 已知字段。 */
  set(patch) {
    const p = Object.assign({}, patch || {});
    // v4.12.0：运行模式已移除，即便外部（旧 UI/IPC）误传 model 也直接丢弃
    delete p.model;
    // v4.12.1：sendImageToServer 已移除，发图统一由 remoteVision 控制
    delete p.sendImageToServer;
    const next = this._merge(this._all(), p);
    this._cache = next;
    this._ensureDir();
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /** 配置文件路径（供诊断/UI 展示）。 */
  filePath() {
    return this.file;
  }
}

module.exports = { PredictConfig, DEFAULT_CONFIG };
