'use strict';

/**
 * 语音管理器（主进程）。
 *
 * 职责：
 *  - TTS：用 Windows SAPI（System.Speech.Synthesis，离线）把文本渲染成 WAV，
 *    再发给渲染层用 <audio>.setSinkId(扬声器) 播放 —— 这样能精确选扬声器。
 *  - STT：复用 media-preprocess（ffmpeg 转 16k 单声道 WAV + Whisper 转写），
 *    麦克风采集在渲染层（getUserMedia）完成，stop 后把音频 blob 发回主进程。
 *  - 热键：globalShortcut 注册「推话筒」快捷键，按下开始收音、再按/超时停止并转写。
 *  - 语音指令：转写文本交给 onVoiceCommand 回调（由 main 接预测/对话管线），结果再朗读。
 *
 * 设计：语音管理器不持有聊天/预测细节，只负责 音<->文 与状态；业务语义通过
 * onVoiceCommand / getSettings / getPet / getMainWindow / getPredict 注入。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const pre = require('../media-preprocess');

// 打包后脚本随 app 进 asar，外部进程（powershell）无法直接 -File 读取 asar 内文件，
// 故运行时抽到真实磁盘（带 UTF-8 BOM，避免中文注释被按 ANSI 解析乱码）。
function extractPs1(name) {
  const src = path.join(__dirname, name);
  const content = fs.readFileSync(src, 'utf8');
  const tmp = path.join(os.tmpdir(), 'hermes-voice-' + crypto.randomUUID() + '-' + name);
  fs.writeFileSync(tmp, '﻿' + content, 'utf8'); // BOM
  return tmp;
}

const LIST_VOICES_PS = 'list-voices.ps1';
const TTS_PS = 'tts.ps1';

class VoiceManager {
  constructor({ logger, appDir, getPet, getMainWindow, getPredict, onVoiceCommand } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.appDir = appDir || '';
    this.getPet = getPet || (() => null);
    this.getMainWindow = getMainWindow || (() => null);
    this.getPredict = getPredict || (() => null);
    this.onVoiceCommand = typeof onVoiceCommand === 'function' ? onVoiceCommand : null;
    this._listening = false;
    this._listenTimer = null;
    this._hotkey = '';
    this._globalShortcut = null; // 懒取，避免循环依赖
    // v4.12.16：独立隐藏采集窗（file:// 可靠上下文跑 getUserMedia）
    this._captureWin = null;
    this._captureReady = false;
    this._probeR = null;
  }

  setGlobalShortcut(gs) { this._globalShortcut = gs; }
  setOnVoiceCommand(fn) { this.onVoiceCommand = fn; }

  // ---------------- 采集窗（v4.12.16）----------------
  /** 创建一个常驻隐藏的 file:// 窗口专门跑 getUserMedia + MediaRecorder。 */
  initCaptureWindow() {
    if (this._captureWin || this._captureReady) return;
    let electron;
    try { electron = require('electron'); } catch (_) { return; }
    const { BrowserWindow } = electron;
    try {
      const win = new BrowserWindow({
        width: 1, height: 1,
        show: false, frame: false, transparent: false,
        skipTaskbar: true, resizable: false, alwaysOnTop: false,
        webPreferences: {
          preload: path.join(__dirname, 'capture-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      win.on('closed', () => { this._captureWin = null; this._captureReady = false; });
      win.webContents.on('ipc-message', (_e, channel, ...args) => {
        if (channel === 'vc:state') this._onCaptureState(args[0]);
        else if (channel === 'vc:error') this._onCaptureErrorMsg(args[0]);
        else if (channel === 'vc:captured') this._onCaptured(args[0]);
      });
      win.loadFile(path.join(__dirname, 'capture.html'))
        .then(() => { this._captureReady = true; this.logger.info('voice-capture-window-ready'); })
        .catch((e) => this.logger.warn('voice-capture-window-load-failed', { error: e.message }));
      this._captureWin = win;
    } catch (e) {
      this.logger.warn('voice-capture-window-failed', { error: e.message });
    }
  }

  _sendCapture(cmd) {
    if (this._captureWin && !this._captureWin.isDestroyed()) {
      try { this._captureWin.webContents.send('vc:cmd', cmd); return true; } catch (_) {}
    }
    return false;
  }

  _reportVoiceTranscript(text) {
    const w = this.getMainWindow();
    if (w && !w.isDestroyed()) { try { w.webContents.send('buddy:voice:transcript', { text }); } catch (_) {} }
  }

  _reportVoiceError(msg) {
    const w = this.getMainWindow();
    if (w && !w.isDestroyed()) { try { w.webContents.send('buddy:voice:error', { message: String(msg || '') }); } catch (_) {} }
  }

  async _onCaptured(payload) {
    try {
      const text = await this.handleCapture(payload || {});
      this._reportVoiceTranscript(text);
    } catch (e) {
      this.logger.warn('voice-capture-handle-failed', { error: e.message });
      this._reportVoiceError(String((e && e.message) || e));
    }
  }

  _onCaptureState(s) {
    if (s && s.state === 'ok' && this._probeR) {
      try { this._probeR.resolve(true); } catch (_) {}
      this._probeR = null;
    }
  }

  _onCaptureErrorMsg(e) {
    this.logger.warn('voice-capture-error', { name: e && e.name, message: e && e.message });
    const msg = ((e && e.name) ? (e.name + '：') : '') + (e && e.message ? e.message : '麦克风打开失败');
    this._reportVoiceError(msg);
    // 出错则收起「收听中」指示并复位状态
    const pet = this.getPet();
    if (pet && pet.win && !pet.win.isDestroyed()) {
      try { pet.win.webContents.send('pet:listen', { on: false }); } catch (_) {}
    }
    this._listening = false;
    if (this._listenTimer) { clearTimeout(this._listenTimer); this._listenTimer = null; }
    if (this._probeR) {
      try { this._probeR.reject(new Error(msg)); } catch (_) {}
      this._probeR = null;
    }
  }

  /** 设置面板「测试麦克风」：在采集窗里实际 getUserMedia 一次，返回可用/具体错误。 */
  probeMic() {
    return new Promise((resolve, reject) => {
      if (!this._captureWin || this._captureWin.isDestroyed()) { reject(new Error('采集窗口未就绪')); return; }
      this._probeR = { resolve, reject };
      if (!this._sendCapture({ cmd: 'probe', micId: this.getSettings().micId || '' })) {
        this._probeR = null; reject(new Error('无法向采集窗发指令')); return;
      }
      setTimeout(() => {
        if (this._probeR) { this._probeR.reject(new Error('麦克风测试超时（8 秒无响应）')); this._probeR = null; }
      }, 8000);
    });
  }

  // ---------------- 设置 ----------------
  getSettings() {
    const pc = this.getPredict();
    const def = { enabled: false, speakerId: '', micId: '', voiceName: '', rate: 0, volume: 100, hotkey: 'Ctrl+Alt+F1', readAloud: true, sttEnabled: true, lang: 'zh' };
    if (!pc || !pc.config || typeof pc.config.get !== 'function') return def;
    const v = pc.config.get('voice');
    return Object.assign({}, def, v || {});
  }

  async saveSettings(patch) {
    const pc = this.getPredict();
    if (!pc || !pc.config || typeof pc.config.set !== 'function') return false;
    const cur = this.getSettings();
    const next = Object.assign({}, cur, patch || {});
    pc.config.set('voice', next);
    // 热键变化则重新注册
    if (patch && patch.hotkey && patch.hotkey !== this._hotkey) this.registerHotkey(next.hotkey);
    return true;
  }

  // ---------------- TTS ----------------
  /** 返回 SAPI 已安装语音列表 [{Name,Id,Culture,Gender}]。 */
  async getVoices() {
    const ps = extractPs1(LIST_VOICES_PS);
    try {
      const { stdout } = await execFileAsync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', ps], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
      const txt = String(stdout || '').trim();
      if (!txt) return [];
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      this.logger.warn('voice-list-voices-failed', { error: e.message });
      return [];
    } finally {
      try { fs.unlinkSync(ps); } catch (_) {}
    }
  }

  async _renderTts(text, cfg) {
    const outDir = path.join(os.tmpdir(), 'hermes-voice-' + crypto.randomUUID());
    fs.mkdirSync(outDir, { recursive: true });
    const wav = path.join(outDir, 'tts.wav');
    const ps = extractPs1(TTS_PS);
    const args = ['-ExecutionPolicy', 'Bypass', '-File', ps, '-Text', text, '-OutWav', wav, '-Rate', String(cfg.rate || 0), '-Volume', String(cfg.volume == null ? 100 : cfg.volume)];
    if (cfg.voiceName) { args.push('-Voice'); args.push(cfg.voiceName); }
    try {
      await execFileAsync('powershell', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    } finally {
      try { fs.unlinkSync(ps); } catch (_) {}
    }
    return wav;
  }

  /**
   * 朗读文本。会同时弹出气泡（pet.speak）与真出声（SAPI->WAV->渲染层）。
   * @returns {Promise<boolean>} 是否真的出了声
   */
  async speak(text) {
    if (!text) return false;
    const cfg = this.getSettings();
    if (!cfg.enabled) return false;
    const pet = this.getPet();
    if (pet && typeof pet.speak === 'function') {
      try { pet.speak(String(text).slice(0, 40)); } catch (_) {}
    }
    try {
      const wav = await this._renderTts(String(text), cfg);
      const target = (pet && pet.win && !pet.win.isDestroyed()) ? pet.win : this.getMainWindow();
      if (target && !target.isDestroyed()) {
        target.webContents.send('pet:speak-audio', { path: wav, speakerId: cfg.speakerId || '' });
      }
      return true;
    } catch (e) {
      this.logger.warn('voice-tts-failed', { error: e.message });
      return false;
    }
  }

  // ---------------- STT ----------------
  /** Whisper/ffmpeg 是否已安装。 */
  engineReady() {
    const ffmpeg = pre.findEngine('ffmpeg', this.appDir);
    const whisper = pre.findEngine('whisper', this.appDir);
    const model = pre.findWhisperModel(this.appDir);
    return !!(ffmpeg && whisper && model);
  }

  /** 渲染层把采集到的音频（base64）发回主进程后转写。 */
  async handleCapture({ data, mime } = {}) {
    if (!data) throw new Error('空音频');
    const cfg = this.getSettings();
    if (!cfg.sttEnabled) throw new Error('STT 未启用');
    if (!this.engineReady()) throw new Error('语音引擎未安装（请在设置里安装 Whisper/ffmpeg）');
    const clean = await this.transcribe(String(data), String(mime || 'audio/webm'));
    if (this.onVoiceCommand) {
      const wi = await this._foregroundWindow().catch(() => null);
      await this.onVoiceCommand(clean, wi);
    }
    return clean;
  }

  async transcribe(base64, mime) {
    const ffmpeg = pre.findEngine('ffmpeg', this.appDir);
    const whisper = pre.findEngine('whisper', this.appDir);
    const model = pre.findWhisperModel(this.appDir);
    if (!ffmpeg || !whisper || !model) throw new Error('语音引擎未安装（Whisper/ffmpeg）');
    const tmp = path.join(os.tmpdir(), 'hermes-voice-' + crypto.randomUUID());
    fs.mkdirSync(tmp, { recursive: true });
    const ext = /webm/i.test(mime) ? '.webm' : (/ogg/i.test(mime) ? '.ogg' : '.wav');
    const src = path.join(tmp, 'capture' + ext);
    fs.writeFileSync(src, Buffer.from(base64, 'base64'));
    const wav = path.join(tmp, 'capture.wav');
    // v4.12.17：这两个函数此前没从 media-preprocess 导出，调用直接 TypeError。
    await pre.toWav16k(ffmpeg, src, wav);
    // whisper.cpp 默认按英文转写，不指定语言中文会变成音译乱码
    const txt = await pre.runTranscribe(whisper, wav, tmp, model, { lang: this.getSettings().lang || 'zh' });
    const clean = pre.cleanTranscript(txt);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    return clean;
  }

  async _foregroundWindow() {
    const pc = this.getPredict();
    if (pc && typeof pc.resolveWindow === 'function') {
      try { return await pc.resolveWindow(); } catch (_) { return null; }
    }
    return null;
  }

  // ---------------- 监听（推话筒）----------------
  setListening(on) {
    const was = this._listening;
    this._listening = !!on;
    if (was !== this._listening) {
      this.logger.info('voice-listening-changed', { listening: this._listening });
    }
    // 桌宠只做「收听中」指示
    const pet = this.getPet();
    if (pet && pet.win && !pet.win.isDestroyed()) {
      try { pet.win.webContents.send('pet:listen', { on: this._listening }); } catch (_) {}
    }
    // 实际收音交给独立采集窗（v4.12.16，file:// 可靠上下文）
    if (this._listening) {
      if (!this._sendCapture({ cmd: 'start', micId: this.getSettings().micId || '' })) {
        this.logger.warn('voice-capture-start-failed', { reason: 'capture-window-unavailable' });
        this._reportVoiceError('采集窗口未就绪，无法收音（请重启应用后再试）');
        this._listening = false;
        if (pet && pet.win && !pet.win.isDestroyed()) {
          try { pet.win.webContents.send('pet:listen', { on: false }); } catch (_) {}
        }
        return false;
      }
      if (this._listenTimer) clearTimeout(this._listenTimer);
      this._listenTimer = setTimeout(() => this.setListening(false), 12000); // 安全网：最长 12s
    } else {
      this._sendCapture({ cmd: 'stop' });
      if (this._listenTimer) { clearTimeout(this._listenTimer); this._listenTimer = null; }
    }
    return this._listening;
  }

  toggleListening() {
    this.setListening(!this._listening);
    return this._listening;
  }

  // 按住说话按钮（按下开始，松开结束）
  pushToTalk(pressed) {
    this.setListening(!!pressed);
  }

  isListening() { return this._listening; }

  // ---------------- 热键 ----------------
  registerHotkey(accelerator) {
    const gs = this._globalShortcut;
    if (!gs) {
      this.logger.warn('voice-hotkey-no-globalShortcut');
      return false;
    }
    if (this._hotkey && this._hotkey !== accelerator) {
      try { gs.unregister(this._hotkey); } catch (_) {}
    }
    if (!accelerator) { this._hotkey = ''; return true; }
    // 用户选的快捷键可能被系统/显卡驱动占用，失败后尝试若干备选；结果会写日志。
    const candidates = [accelerator, 'Ctrl+Alt+Space', 'Ctrl+Shift+Space', 'Alt+Shift+Space']
      .filter((v, i, a) => a.indexOf(v) === i);
    try {
      if (gs.isRegistered(accelerator)) gs.unregister(accelerator);
      for (const cand of candidates) {
        const ok = gs.register(cand, () => { try { this.toggleListening(); } catch (_) {} });
        if (ok) {
          this._hotkey = cand;
          if (cand !== accelerator) {
            this.logger.warn('voice-hotkey-fallback-used', { requested: accelerator, actual: cand });
          } else {
            this.logger.info('voice-hotkey-registered', { accelerator: cand });
          }
          return true;
        }
        this.logger.warn('voice-hotkey-register-failed', { accelerator: cand });
      }
      this._hotkey = '';
      this.logger.error('voice-hotkey-all-failed', { requested: accelerator });
      return false;
    } catch (e) {
      this.logger.error('voice-hotkey-register-error', { error: e.message, accelerator });
      this._hotkey = '';
      return false;
    }
  }

  unregisterHotkey() {
    const gs = this._globalShortcut;
    if (gs && this._hotkey) { try { gs.unregister(this._hotkey); } catch (_) {} this._hotkey = ''; }
  }

  status() {
    const cfg = this.getSettings();
    return {
      enabled: cfg.enabled,
      sttEnabled: cfg.sttEnabled,
      readAloud: cfg.readAloud,
      hotkey: cfg.hotkey,
      hotkeyRegistered: Boolean(this._hotkey),
      actualHotkey: this._hotkey || '',
      listening: this._listening,
      captureReady: this._captureReady,
      engineReady: this.engineReady(),
      speakerId: cfg.speakerId || '',
      micId: cfg.micId || '',
      lang: cfg.lang || 'zh',
    };
  }
}

module.exports = { VoiceManager };
