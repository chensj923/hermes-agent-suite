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
  }

  setGlobalShortcut(gs) { this._globalShortcut = gs; }
  setOnVoiceCommand(fn) { this.onVoiceCommand = fn; }

  // ---------------- 设置 ----------------
  getSettings() {
    const pc = this.getPredict();
    const def = { enabled: false, speakerId: '', micId: '', voiceName: '', rate: 0, volume: 100, hotkey: 'Ctrl+Alt+F1', readAloud: true, sttEnabled: true };
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
    await pre.toWav16k(ffmpeg, src, wav);
    const txt = await pre.runTranscribe(whisper, wav, tmp, model);
    return pre.cleanTranscript(txt);
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
    this._listening = !!on;
    const pet = this.getPet();
    if (pet && pet.win && !pet.win.isDestroyed()) {
      pet.win.webContents.send('pet:listen', { on: this._listening });
    }
    if (this._listening) {
      if (this._listenTimer) clearTimeout(this._listenTimer);
      this._listenTimer = setTimeout(() => this.setListening(false), 12000); // 安全网：最长 12s
    } else if (this._listenTimer) {
      clearTimeout(this._listenTimer);
      this._listenTimer = null;
    }
  }

  toggleListening() {
    this.setListening(!this._listening);
    return this._listening;
  }

  isListening() { return this._listening; }

  // ---------------- 热键 ----------------
  registerHotkey(accelerator) {
    const gs = this._globalShortcut;
    if (!gs) return false;
    if (this._hotkey && this._hotkey !== accelerator) {
      try { gs.unregister(this._hotkey); } catch (_) {}
    }
    if (!accelerator) { this._hotkey = ''; return true; }
    try {
      if (gs.isRegistered(accelerator)) gs.unregister(accelerator);
      const ok = gs.register(accelerator, () => { try { this.toggleListening(); } catch (_) {} });
      this._hotkey = ok ? accelerator : '';
      return ok;
    } catch (e) {
      this.logger.warn('voice-hotkey-register-failed', { error: e.message, accelerator });
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
      listening: this._listening,
      engineReady: this.engineReady(),
      speakerId: cfg.speakerId || '',
      micId: cfg.micId || '',
    };
  }
}

module.exports = { VoiceManager };
