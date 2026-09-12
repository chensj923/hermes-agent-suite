'use strict';

/**
 * 自动更新：GitHub Releases 探针（checkForUpdates 见 update-checker.js）
 * + 后台下载 + NSIS 静默安装 + 重启替换。
 *
 * 为什么不是"真热更"：Electron 的主进程与渲染层同在 app.asar 里，运行中无法整体替换；
 * 能做到的最接近体验是——下载全程后台进行（聊天不受任何影响，即"热"），
 * 下载完成后一键"重启并安装"，NSIS /S 静默覆盖后自动拉起新版本，全程无需用户点安装向导。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { fetchLenient } = require('./fetch-lenient');

const INSTALLER_NAME = 'hermes-suite-windows-x86_64.exe';

class Updater {
  constructor({ logger, fetchImpl = globalThis.fetch, tempDir = null } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.fetchImpl = fetchImpl;
    this.tempDir = tempDir || path.join(require('os').tmpdir(), 'hermes-buddy-update');
    this.downloading = false;
    this.installerPath = null;
  }

  /** 是否已经有一份下载完的安装包在本地。 */
  hasReadyInstaller() {
    try {
      return this.installerPath && fs.statSync(this.installerPath).size > 1024 * 1024;
    } catch (_) { return false; }
  }

  clearDownloaded() {
    this.installerPath = null;
  }

  /**
   * 下载安装包到临时目录。先试直连，失败自动切 ghfast 镜像。
   * @param {string[]} urls 候选下载地址（按优先级）
   * @param {{ expectedSize?: number, onProgress?: (p: object) => void }} options
   */
  async download(urls, { expectedSize = 0, onProgress = null } = {}) {
    if (this.downloading) throw new Error('已有更新在下载中');
    this.downloading = true;
    try {
      fs.mkdirSync(this.tempDir, { recursive: true });
      const target = path.join(this.tempDir, INSTALLER_NAME);
      let lastError = null;
      for (const url of urls.filter(Boolean)) {
        try {
          const size = await this.downloadOne(url, target, { expectedSize, onProgress });
          if (expectedSize && size !== expectedSize) throw new Error(`文件不完整（${size}/${expectedSize}）`);
          this.installerPath = target;
          this.logger.info('update-downloaded', { url, size });
          return { ok: true, path: target, size };
        } catch (error) {
          lastError = error;
          this.logger.warn('update-download-failed', { url, error: error.message });
        }
      }
      throw lastError || new Error('所有下载地址都失败了');
    } finally {
      this.downloading = false;
    }
  }

  async downloadOne(url, target, { expectedSize, onProgress }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 84MB 弱网也要给足时间
    try {
      const response = await fetchLenient(this.fetchImpl, url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'hermes-buddy-desktop' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || expectedSize || 0;
      let received = 0;
      let lastPercent = -1;
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function' && total) {
          const percent = Math.min(100, Math.round((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress({ percent, receivedBytes: received, totalBytes: total });
          }
        }
      });
      const tmpFile = `${target}.part`;
      await pipeline(source, fs.createWriteStream(tmpFile));
      fs.renameSync(tmpFile, target);
      return fs.statSync(target).size;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 静默安装并重启：NSIS /S 覆盖安装（per-user 无需 UAC），
   * 安装进程退出后拉起新版本，随后旧进程退出。
   * @param {{ relaunchPath?: string }} options relaunchPath 默认取当前 exe（安装覆盖同一路径）。
   */
  install({ relaunchPath = null } = {}) {
    if (!this.hasReadyInstaller()) throw new Error('还没有下载好的安装包');
    const target = relaunchPath || process.execPath;
    if (process.platform !== 'win32') throw new Error('自动安装仅支持 Windows');
    // cmd 等待安装器退出后再启动新版本；detached 让它不随旧进程一起死。
    const script = `"${this.installerPath}" /S & timeout /t 3 /nobreak >nul & start "" "${target}"`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    this.logger.info('update-install-started', { installer: this.installerPath, relaunch: target });
    return { ok: true, installer: this.installerPath };
  }
}

module.exports = { Updater, INSTALLER_NAME };
