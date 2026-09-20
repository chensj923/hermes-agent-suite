'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const provisioning = require('@hermes/provisioning');
const registry = require('@hermes/capability-registry');
const { describeGatewayError } = require('@hermes/connection');
const { createLogger } = require('./logger');
const { ConnectionStore } = require('./connection-store');
const { SessionManager } = require('./session-manager');
const { checkForUpdates } = require('./update-checker');
const { install: installTool } = require('./toolchain');
const { diagnose } = require('./diagnostics');
const { generateBootstrapScript } = require('./server-bootstrap');
const { Updater } = require('./updater');
const mediaEngines = require('./media-engines');
// v4.0 预测模式：杀软检测 / Defender 排除区 / VLM 引擎查找（模块级 require 安全，实例化才可能在 bootstrap 失败）。
const { detectAntivirus, addDefenderExclusion } = require('./predict/behavior-hooks');
const llamaEngine = require('./predict/llama-engine');
const { createTray, destroyTray, resolveCloseBehavior } = require('./tray');

// 打包冒烟：启动 → 加载完成 → 退出，用于 CI 校验主进程与渲染层能起来。
const SMOKE_TEST = process.argv.includes('--smoke-test');
const TEXT_FLUSH_MS = 25;
const CONFIRM_TIMEOUT_MS = 120000;
// 只允许把这些外链交给系统浏览器，其余一律拒绝。
const EXTERNAL_ALLOWLIST = [/^https:\/\/github\.com\//i, /^https:\/\/ghfast\.top\//i];

let mainWindow = null;
let manager = null;
let updater = null;
let predictController = null;   // v4.0 预测模式编排器（bootstrap 中惰性创建）
let pet = null;                 // v4.1 桌宠猫咪（bootstrap 中惰性创建）
let trayInstance = null;        // v4.8.3 常驻系统托盘
let predictLogCallback = null;  // v4.10.18 推理记录实时推送给渲染层的回调
let isQuitting = false;         // 真正退出时置 true，关闭到托盘时保持 false
let logger = { info() {}, warn() {}, error() {}, debug() {} };
const pendingConfirms = new Map();

// GPU 硬件加速在某些 Windows 10 机器上会导致 Electron 启动即崩（GPU 进程 crash），
// 没有日志、没有 crash dump，表现为 exit code=0 静默退出。先全局禁用 GPU，
// 确保至少能启动；性能影响对 Buddy 这种工具型应用可忽略。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

// CI / 远程会话里通常没有可用 GPU，冒烟时关掉硬件加速，避免 GPU 进程拖垮启动。
if (SMOKE_TEST) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

function safeSend(sender, channel, payload) {
  if (sender && !sender.isDestroyed()) sender.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    show: !SMOKE_TEST,
    backgroundColor: '#f6f7f9',
    title: 'Hermes Buddy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // 渲染层是纯本地页面，任何跳转和新窗口都视为异常。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) { event.preventDefault(); logger.warn('navigation-blocked', { url }); }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_ALLOWLIST.some((pattern) => pattern.test(url))) shell.openExternal(url);
    else logger.warn('external-blocked', { url });
    return { action: 'deny' };
  });
  // v4.8.3：关闭主窗口时隐藏到托盘常驻，不退出进程，保持预测/巡检继续运行。
  mainWindow.on('close', (event) => {
    if (resolveCloseBehavior({ isQuitting, hasTray: Boolean(trayInstance), platform: process.platform }) === 'hide-to-tray') {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (SMOKE_TEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      logger.info('smoke-test-ok', { version: app.getVersion() });
      setTimeout(() => app.exit(0), 200);
    });
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      logger.error('smoke-test-failed', { code, description });
      app.exit(1);
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}

/** 恢复并聚焦主窗口（桌宠右键菜单 / IPC 共用）。 */
function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * v4.2 主动预测：不看规则、不受冷却，「现在就看一眼屏幕」。
 * 桌宠点击 / 设置页按钮 / 巡检定时器共用。结果通过猫的气泡或浮层反馈。
 */
async function runProactivePredict() {
  if (!predictController) return { error: '预测模式未初始化' };
  try {
    if (pet) pet.speak('喵～ 我在想…');
    const r = await predictController.predictNow();
    if (r.shown) return r;
    if (r.busy) { if (pet) pet.speak('我还在想上一件事喵～'); return r; }
    // 没弹窗：交给猫一句话交代，避免点了没反应
    if (pet) pet.speak('这会儿好像没什么要帮忙的喵～');
    return r;
  } catch (e) {
    if (pet) pet.speak('要先在设置里启用预测模式喵～');
    return { error: e.message };
  }
}

/** v4.2 桌宠主动巡检：配置 proactivePatrolMinutes>0 且桌宠可见时，定时主动看一次屏幕。 */
let petPatrolTimer = null;
function startPetPatrol() {
  if (petPatrolTimer) return;
  let lastRun = 0;
  petPatrolTimer = setInterval(() => {
    try {
      if (!predictController || !pet || !pet.isVisible()) return;
      const cfg = predictController.config;
      const minutes = Number(cfg.get('proactivePatrolMinutes')) || 0;
      if (minutes <= 0) return;
      if (!cfg.get('enabled') || !cfg.get('authorized')) return;
      // v4.4：三档模式都带模型（local/remote/hybrid），都能从巡检拿到增量信息；
      // 模型真的不可用时控制器会降级为规则预判，这里不再按模式名跳过。
      if (!cfg.get('model')) return;
      const intervalMs = minutes * 60 * 1000;
      const now = Date.now();
      if (now - lastRun < intervalMs) return;
      lastRun = now;
      runProactivePredict();
    } catch (_) { /* 巡检失败不影响正常使用 */ }
  }, 60 * 1000);
  petPatrolTimer.unref?.();
}

function stopPetPatrol() {
  if (petPatrolTimer) {
    clearInterval(petPatrolTimer);
    petPatrolTimer = null;
  }
}

/**
 * 危险命令要由人来点头。主进程在这里挂起等待渲染层回复，
 * 超时或窗口已关都按"拒绝"处理——宁可不做，也不能自作主张。
 */
function requestConfirm(sender, payload) {
  return new Promise((resolve) => {
    if (!sender || sender.isDestroyed()) { resolve(false); return; }
    const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      logger.warn('confirm-timeout', { command: payload.command });
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, (approved) => {
      clearTimeout(timer);
      resolve(Boolean(approved));
    });
    safeSend(sender, 'buddy:confirm:request', { id, ...payload });
  });
}

/** IPC 统一入口：校验来源，并保证抛给渲染层的只有一句人话。 */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (mainWindow && event.sender !== mainWindow.webContents) throw new Error('非法调用来源');
    try {
      return await handler(event, ...args);
    } catch (error) {
      const message = (error && error.message) || String(error);
      logger.warn('ipc-failed', { channel, error: message });
      throw new Error(message);
    }
  });
}

function registerIpc() {
  // ---- 连接 ----
  handle('buddy:connection', () => manager.status());
  handle('buddy:status', () => manager.status());
  handle('buddy:connect', async (_event, connection) => {
    // 全局超时保护：通道模式下 WS 连接最多约 18 秒（10s HTTP + 8s welcome），
    // Gateway 已改为后台异步不阻塞。给 20 秒上限兜底。
    const timeoutMs = 20000;
    const result = await Promise.race([
      manager.connect(connection),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('连接超时（20 秒），请检查 Hermes 主机地址和端口（Dashboard 默认 9119，WS 通道默认 8822）是否正确')),
        timeoutMs
      ))
    ]);
    return { ...result, workspace: manager.describeWorkspace() };
  });
  handle('buddy:resume', async () => {
    const result = await manager.resume();
    return { ...result, status: manager.status(), gatewayWarning: manager.lastGatewayError ? describeGatewayError(manager.lastGatewayError) : null };
  });
  handle('buddy:disconnect', () => manager.disconnect());
  handle('buddy:disconnect-and-clear-cache', () => {
    // 彻底清除所有缓存文件（配置 + 子目录）
    const appData = app.getPath('userData');
    const fs = require('fs');
    const path = require('path');
    const dirs = ['gateway-cache', 'logs', 'memory', 'persona', 'skills'];
    dirs.forEach((subDir) => {
      const dirPath = path.join(appData, subDir);
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    });
    // 清除配置文件
    const store = manager.store;
    if (store) {
      try {
        const configPath = store.filePath;
        if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
        // 清理 quarantine 文件
        const backupPaths = ['decrypt-failed', 'parse-failed', 'incomplete'];
        backupPaths.forEach((reason) => {
          const backupPath = `${configPath}.${reason}`;
          if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
        });
      } catch (e) {
        manager.logger.warn('clear-config-failed', { error: e.message });
      }
    }
    // 重置 session
    manager.abort();
    manager.connection = null;
    manager.brain = null;
    manager.gateway = null;
    manager.session = null;
    manager.messages = [];
    manager.lastGatewayError = null;
    manager.workspace = null;
    manager.tools = null;
    manager.memory = null;
    manager.skills = null;
    manager.loop = null;
    manager.logger.info('cache-cleared');
    return { cleared: true };
  });
  // ---- 多连接（多网关）：列出 / 激活 / 删除已保存的 Hermes 连接 ----
  handle('buddy:profiles', () => manager.listProfiles());
  handle('buddy:profile:activate', async (_event, id) => {
    // 切换前先关掉当前通道 / 推理端点，避免旧连接的 WS 残留（多网关切换时尤其重要）
    if (manager.channel) { try { manager.channel.close(); } catch (_) {} manager.channel = null; }
    manager.brain = null;
    manager.loop = null;
    manager.setActiveProfile(String(id));
    const result = await manager.resume();
    return { ...result, status: manager.status(), gatewayWarning: manager.lastGatewayError ? describeGatewayError(manager.lastGatewayError) : null };
  });
  handle('buddy:profile:remove', (_event, id) => manager.removeProfile(String(id)));
  handle('buddy:profile:probe', async (_event, profile) => manager.probeProfileVersion(profile));

  handle('buddy:models', () => manager.models());
  handle('buddy:history', () => manager.history());
  handle('buddy:clear-history', () => manager.clearHistory());
  handle('buddy:provisioning-status', () => manager.provisioningStatus());

  // ---- 诊断 + 服务端准备脚本（连接前给用户一个清晰的"哪步没配"清单） ----
  handle('buddy:diagnose', async (_event, options = {}) => {
    return diagnose({
      mode: options.mode,
      channelUrl: options.channelUrl,
      llmUrl: options.llmUrl,
      gatewayBaseUrl: options.gatewayBaseUrl,
      managementUrl: options.managementUrl
    });
  });
  handle('buddy:bootstrap-script', (_event, options = {}) => {
    return { script: generateBootstrapScript(options), generatedAt: new Date().toISOString() };
  });
  handle('buddy:bootstrap-export', async (_event, { script, host } = {}) => {
    const safeName = String(host || 'hermes-bootstrap').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const filePath = path.join(app.getPath('downloads'), `${safeName}.sh`);
    await fs.promises.writeFile(filePath, String(script || ''), { encoding: 'utf8', mode: 0o600 });
    return { path: filePath };
  });

  // 让 Docker / 无 systemd 客户直接下载独立启动脚本（不依赖 SSH 一键部署）。
  handle('buddy:download-channel-script', async () => {
    const init = await initDeployIfNeeded();
    if (!init.ok) return { error: init.error || '部署包未就绪，请先在部署页点「初始化部署包」' };
    const src = path.join(DEPLOY_DIR, 'start-channel.sh');
    if (!fs.existsSync(src)) return { error: '未找到 start-channel.sh（部署包可能不完整，请重新初始化）' };
    const target = path.join(app.getPath('downloads'), 'start-channel.sh');
    await fs.promises.copyFile(src, target);
    try { fs.chmodSync(target, 0o755); } catch (_) { /* Windows 上无妨 */ }
    return { path: target };
  });

  // 下载 deploy.sh 部署脚本（给客户自己在 Hermes 上跑，适配 Docker / 无 SSH 场景）。
  handle('buddy:download-deploy-sh', async () => {
    const init = await initDeployIfNeeded();
    if (!init.ok) return { error: init.error || '部署包未就绪，请先在部署页点「初始化部署包」' };
    const src = path.join(DEPLOY_DIR, 'deploy.sh');
    if (!fs.existsSync(src)) return { error: '未找到 deploy.sh（部署包可能不完整，请重新初始化）' };
    const target = path.join(app.getPath('downloads'), 'deploy.sh');
    await fs.promises.copyFile(src, target);
    try { fs.chmodSync(target, 0o755); } catch (_) { /* Windows 上无妨 */ }
    return { path: target };
  });

  // ---- 服务端部署压缩包（随安装包自带，含 8811 代理 + 8822 通道 + 执行脚本） ----
  // 安装包只打一个 tar.gz 进 extraResources；安装后初始化时从 tar.gz 解包到
  // userData/server-deploy/（可读写、路径稳定），之后导出/推送都从那里走。
  const DEPLOY_DIR = path.join(app.getPath('userData'), 'server-deploy');

  /** 在 resources/ 和开发路径里找 tar.gz。 */
  function resolveBundleInResources() {
    const candidates = [
      path.join((process.resourcesPath || ''), 'server-deploy', 'hermes-buddy-server-deploy.tar.gz'),
      path.join(app.getAppPath(), 'server-deploy', 'hermes-buddy-server-deploy.tar.gz'),
      path.join(__dirname, '..', 'server-deploy', 'hermes-buddy-server-deploy.tar.gz'),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* 下一个 */ }
    }
    return null;
  }

  /**
   * 初始化：从安装包里的 tar.gz 解包到 userData/server-deploy/。
   * 用系统 tar（Windows 10+ / Linux / macOS 都自带）解压。
   * 首次解包后写 .initialized 标记；后续调用跳过（除非 force=true）。
   */
  async function extractBundle(bundlePath, destDir) {
    await fs.promises.mkdir(destDir, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', bundlePath, '-C', destDir], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error('tar 解压失败(退出码 ' + code + '): ' + err));
        else resolve();
      });
    });
  }

  handle('buddy:deploy-init', async (_event, { force = false } = {}) => {
    const marker = path.join(DEPLOY_DIR, '.initialized');
    const appVersion = app.getVersion();
    if (!force) {
      try {
        if (fs.existsSync(marker)) {
          const saved = fs.readFileSync(marker, 'utf8').trim();
          if (saved === appVersion) return { ok: true, dir: DEPLOY_DIR, cached: true };
        }
      } catch (_) { /* 继续 */ }
    }
    const bundle = resolveBundleInResources();
    if (!bundle) {
      return { ok: false, dir: DEPLOY_DIR, error: '安装包内未找到 hermes-buddy-server-deploy.tar.gz' };
    }
    try {
      // force 或版本变了，清旧目录再解包
      await fs.promises.rm(DEPLOY_DIR, { recursive: true, force: true }).catch(() => {});
      await extractBundle(bundle, DEPLOY_DIR);
    } catch (e) {
      return { ok: false, dir: DEPLOY_DIR, error: e.message };
    }
    // 解包后给脚本加可执行权限
    for (const f of ['deploy.sh', 'deploy.ps1']) {
      try { fs.chmodSync(path.join(DEPLOY_DIR, f), 0o755); } catch (_) { /* Windows 上无妨 */ }
    }
    await fs.promises.writeFile(marker, appVersion, 'utf8');
    const files = fs.existsSync(DEPLOY_DIR) ? fs.readdirSync(DEPLOY_DIR).filter(f => !f.startsWith('.')) : [];
    return { ok: true, dir: DEPLOY_DIR, files, cached: false };
  });

  /** 初始化后的路径优先；没初始化过就回退到 resources/ 里的 tar.gz。 */
  function resolveDeployBundle() {
    const local = path.join(DEPLOY_DIR, 'hermes-buddy-server-deploy.tar.gz');
    try { if (fs.existsSync(local)) return local; } catch (_) { /* 下一个 */ }
    return resolveBundleInResources();
  }
  function resolveDeployPs1() {
    const local = path.join(DEPLOY_DIR, 'deploy.ps1');
    try { if (fs.existsSync(local)) return local; } catch (_) { /* 下一个 */ }
    return null;  // 只在初始化后才有
  }

  /** 如果还没初始化过、或版本变了就解包（用于 deploy-to-server 自动前置）。 */
  async function initDeployIfNeeded() {
    const marker = path.join(DEPLOY_DIR, '.initialized');
    const appVersion = app.getVersion();
    // 写入版本标记；版本不匹配就强制重新解包
    try {
      if (fs.existsSync(marker)) {
        const saved = fs.readFileSync(marker, 'utf8').trim();
        if (saved === appVersion) return { ok: true, dir: DEPLOY_DIR, cached: true };
        // 版本变了，继续重新解包
      }
    } catch (_) { /* 继续 */ }
    const bundle = resolveBundleInResources();
    if (!bundle) return { ok: false, error: '安装包内未找到 hermes-buddy-server-deploy.tar.gz' };
    try {
      // 清旧目录再解包，避免旧文件残留
      await fs.promises.rm(DEPLOY_DIR, { recursive: true, force: true }).catch(() => {});
      await extractBundle(bundle, DEPLOY_DIR);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    for (const f of ['deploy.sh', 'deploy.ps1']) {
      try { fs.chmodSync(path.join(DEPLOY_DIR, f), 0o755); } catch (_) { /* Windows 上无妨 */ }
    }
    await fs.promises.writeFile(marker, appVersion, 'utf8');
    return { ok: true, dir: DEPLOY_DIR, cached: false };
  }

  handle('buddy:deploy-bundle-path', () => resolveDeployBundle());
  handle('buddy:export-deploy-bundle', async () => {
    const src = resolveDeployBundle();
    if (!src) return { error: '未找到部署压缩包（请先点「初始化部署包」，或确认安装包完整）' };
    const target = path.join(app.getPath('downloads'), 'hermes-buddy-server-deploy.tar.gz');
    await fs.promises.copyFile(src, target);
    return { path: target, source: src };
  });
  handle('buddy:deploy-keypick', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SSH 私钥',
      properties: ['openFile'],
      filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', 'rsa', 'ppk', 'ed25519', 'ecdsa'] }],
    });
    if (res.canceled || !res.filePaths.length) return { path: '' };
    return { path: res.filePaths[0] };
  });
  handle('buddy:deploy-to-server', (event, opts = {}) => {
    return new Promise(async (resolve) => {
      const sender = event.sender;
      // 同时写日志和发 IPC 进度，这样用户关掉 UI 也能在 buddy.log 里看到部署过程
      const send = (text) => {
        logger.info('deploy-progress', { text: text.trim() });
        safeSend(sender, 'buddy:deploy:progress', { text });
      };

      // 确保部署包已初始化到 userData（首次运行自动提取）
      const initResult = await initDeployIfNeeded();
      if (!initResult.ok) {
        send('ERROR: ' + initResult.error + '\n');
        return resolve({ ok: false, error: initResult.error });
      }
      const bundle = resolveDeployBundle();
      if (!bundle) {
        send('ERROR: 未找到部署压缩包（请确认安装包完整）\n');
        return resolve({ ok: false, error: 'missing bundle' });
      }

      const host = String(opts.host || '').trim();
      const user = String(opts.user || 'root').trim();
      const keyPath = String(opts.keyPath || '').trim();
      const password = String(opts.password || '').trim();
      const sshPort = Number(opts.sshPort) || 22;
      const upstreamBase = String(opts.upstreamBase || '').trim();
      const upstreamKey = String(opts.upstreamKey || '').trim();
      const upstreamModel = String(opts.upstreamModel || '').trim();
      const installHermes = !!opts.installHermes;
      const hermesIndexUrl = String(opts.hermesIndexUrl || '').trim();
      const hermesExtraIndexUrl = String(opts.hermesExtraIndexUrl || '').trim();
      const hermesPkg = String(opts.hermesPkg || 'hermes-agent').trim();

      if (!host) { send('ERROR: 请先填 Hermes 主机地址。\n'); return resolve({ ok: false, error: 'no host' }); }
      if (!keyPath && !password) { send('ERROR: 请填 SSH 私钥路径或 SSH 密码（二选一）。\n'); return resolve({ ok: false, error: 'no auth' }); }

      const remoteTar = '/tmp/hermes-buddy-server-deploy.tar.gz';
      const remoteDir = '/tmp/hermes-buddy-deploy';
      // 通过环境变量把上游参数传给 deploy.sh。
      // 关键：sudo 会清除环境变量，必须用 `sudo -E env VAR=... bash deploy.sh`，
      // 而不是 `sudo VAR=... bash deploy.sh`（sudo 不支持 VAR=value 前缀语法）。
      const envVars = [
        upstreamBase ? `BUDDY_UPSTREAM_BASE=${JSON.stringify(upstreamBase)}` : '',
        upstreamKey ? `BUDDY_UPSTREAM_KEY=${JSON.stringify(upstreamKey)}` : '',
        upstreamModel ? `BUDDY_UPSTREAM_MODEL=${JSON.stringify(upstreamModel)}` : '',
        installHermes ? 'INSTALL_HERMES=1' : '',
        hermesIndexUrl ? `HERMES_INDEX_URL=${JSON.stringify(hermesIndexUrl)}` : '',
        hermesExtraIndexUrl ? `HERMES_EXTRA_INDEX_URL=${JSON.stringify(hermesExtraIndexUrl)}` : '',
        hermesPkg ? `HERMES_PKG=${JSON.stringify(hermesPkg)}` : '',
      ].filter(Boolean).join(' ');
      const deployCmd = envVars ? `env ${envVars} bash deploy.sh` : 'bash deploy.sh';
      // 有 sudo 时用 sudo -E env ...（-E 保留环境 + env 显式传递）；
      // 无 sudo 时直接 env ... bash deploy.sh
      const remoteCmd = `mkdir -p ${remoteDir} && tar -xzf ${remoteTar} -C ${remoteDir} && cd ${remoteDir} && (command -v sudo >/dev/null 2>&1 && sudo -E ${deployCmd} || ${deployCmd})`;

      // ---- 判断认证方式 ----
      const useKey = keyPath && fs.existsSync(keyPath);
      const usePass = password && !useKey;

      if (!useKey && !usePass) {
        send('ERROR: 密钥路径无效且未填密码，请至少提供一种认证方式。\n');
        return resolve({ ok: false, error: 'invalid auth' });
      }

      send(`[deploy] 连接 ${user}@${host}:${sshPort}（${useKey ? '密钥认证' : '口令认证'}）\n`);

      // ---- 用 ssh2 纯 JS 客户端连接 ----
      let ssh2;
      try {
        ssh2 = require('ssh2');
      } catch (e) {
        send('ERROR: ssh2 模块未找到，请联系开发者。\n');
        return resolve({ ok: false, error: 'ssh2 module missing' });
      }

      const conn = new ssh2.Client();
      const connConfig = {
        host,
        port: sshPort,
        username: user,
        readyTimeout: 30000,
        algorithms: { serverHostKey: ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-dss'] },
      };
      if (useKey) {
        try {
          connConfig.privateKey = fs.readFileSync(keyPath, 'utf8');
          send(`[deploy] 已读取密钥: ${keyPath}\n`);
        } catch (e) {
          send(`ERROR: 读取密钥失败: ${e.message}\n`);
          return resolve({ ok: false, error: e.message });
        }
      } else {
        connConfig.password = password;
      }

      conn.on('ready', () => {
        send('[deploy] SSH 连接成功，开始上传压缩包...\n');

        // ---- SFTP 上传 tar.gz ----
        conn.sftp((err, sftp) => {
          if (err) {
            send(`ERROR: SFTP 会话失败: ${err.message}\n`);
            conn.end();
            return resolve({ ok: false, error: err.message });
          }

          const fileSize = fs.statSync(bundle).size;
          send(`[deploy] 上传 ${path.basename(bundle)} (${(fileSize / 1024).toFixed(1)} KB) -> ${remoteTar}\n`);

          const readStream = fs.createReadStream(bundle);
          const writeStream = sftp.createWriteStream(remoteTar, { mode: 0o644 });

          let uploaded = 0;
          readStream.on('data', (chunk) => {
            uploaded += chunk.length;
            const pct = Math.round((uploaded / fileSize) * 100);
            if (pct % 25 === 0) send(`[deploy] 上传进度: ${pct}%\n`);
          });

          writeStream.on('error', (e) => {
            send(`ERROR: SFTP 写入失败: ${e.message}\n`);
            conn.end();
            resolve({ ok: false, error: e.message });
          });

          writeStream.on('close', () => {
            send('[deploy] 上传完成，执行远程部署...\n');

            // ---- SSH 执行远程命令 ----
            conn.exec(remoteCmd, (err, stream) => {
              if (err) {
                send(`ERROR: 远程执行失败: ${err.message}\n`);
                conn.end();
                return resolve({ ok: false, error: err.message });
              }

              stream.on('data', (d) => send(d.toString()));
              stream.on('stderr', (d) => send(d.toString()));
              stream.on('close', (code) => {
                send(`\n[deploy] 远程命令退出码: ${code}\n`);
                logger.info('deploy-complete', { host, code: code ?? 0, ok: code === 0 });
                conn.end();
                resolve({ ok: code === 0, code: code ?? 0 });
              });
            });
          });

          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (e) => {
        send(`ERROR: SSH 连接失败: ${e.message}\n`);
        resolve({ ok: false, error: e.message });
      });

      conn.on('close', () => {
        send('[deploy] SSH 连接已关闭。\n');
      });

      // ---- 连接超时兜底 ----
      setTimeout(() => {
        if (conn._sock && !conn._sock.destroyed) {
          // 还连着就不管
        }
      }, 35000);

      send('[deploy] 正在连接...\n');
      conn.connect(connConfig);
    });
  });

  // ---- SSH 检查：连上 Hermes 主机，检查是否已部署、取回 API Key、验证通道健康 ----
  handle('buddy:ssh-check', (event, opts = {}) => {
    return new Promise(async (resolve) => {
      const sender = event.sender;
      const send = (text) => {
        logger.info('ssh-check-progress', { text: text.trim() });
        safeSend(sender, 'buddy:deploy:progress', { text });
      };

      const host = String(opts.host || '').trim();
      const user = String(opts.user || 'root').trim();
      const keyPath = String(opts.keyPath || '').trim();
      const password = String(opts.password || '').trim();
      const sshPort = Number(opts.sshPort) || 22;

      if (!host) { send('ERROR: 请先填 Hermes 主机地址。\n'); return resolve({ ok: false, error: 'no host' }); }
      if (!keyPath && !password) { send('ERROR: 请填 SSH 私钥路径或密码。\n'); return resolve({ ok: false, error: 'no auth' }); }

      const useKey = keyPath && fs.existsSync(keyPath);
      const usePass = password && !useKey;

      send(`[check] 连接 ${user}@${host}:${sshPort}（${useKey ? '密钥认证' : '口令认证'}）\n`);

      let ssh2;
      try { ssh2 = require('ssh2'); } catch (e) {
        send('ERROR: ssh2 模块未找到。\n');
        return resolve({ ok: false, error: 'ssh2 missing' });
      }

      const conn = new ssh2.Client();
      const connConfig = {
        host, port: sshPort, username: user, readyTimeout: 20000,
        algorithms: { serverHostKey: ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-dss'] },
      };
      if (useKey) {
        try { connConfig.privateKey = fs.readFileSync(keyPath, 'utf8'); } catch (e) {
          send(`ERROR: 读取密钥失败: ${e.message}\n`); return resolve({ ok: false, error: e.message });
        }
      } else { connConfig.password = password; }

      conn.on('ready', () => {
        send('[check] SSH 连接成功，正在检查 Hermes 部署状态…\n');
        // 检查脚本：看 .hermes 目录、hermes 命令、8822 通道健康、取 API_SERVER_KEY
        const checkCmd = `echo "===HERMES_CHECK===" && (
          HERMES_HOME="\${HERMES_HOME:-/root/.hermes}"
          echo "hermes_home_exists=$([ -d "$HERMES_HOME" ] && echo yes || echo no)"
          echo "hermes_cli=$(command -v hermes 2>/dev/null || echo none)"
          echo "gateway_port=$(ss -tlnp 2>/dev/null | grep ':22122' | head -1 || echo none)"
          echo "channel_port=$(ss -tlnp 2>/dev/null | grep ':8822' | head -1 || echo none)"
          echo "proxy_port=$(ss -tlnp 2>/dev/null | grep ':8811' | head -1 || echo none)"
          echo "channel_health=$(curl -s -m 3 http://127.0.0.1:8822/health 2>/dev/null || echo none)"
          echo "proxy_health=$(curl -s -m 3 http://127.0.0.1:8811/health 2>/dev/null || echo none)"
          CHANNEL_VER=$(grep -oE '^CHANNEL_VERSION *= *"[0-9.]+"' "$HERMES_HOME/buddy-channel.py" 2>/dev/null | grep -oE '[0-9.]+' | head -1)
          echo "channel_version=\${CHANNEL_VER:-none}"
          CHANNEL_BLD=$(grep -oE '^CHANNEL_BUILD *= *"[0-9]+"' "$HERMES_HOME/buddy-channel.py" 2>/dev/null | grep -oE '[0-9]+' | head -1)
          echo "channel_build=\${CHANNEL_BLD:-0}"
          echo "proxy_env=$([ -f "$HERMES_HOME/buddy-proxy.env" ] && echo yes || echo no)"
          API_KEY=""
          [ -f "$HERMES_HOME/.api_server_key" ] && API_KEY=$(cat "$HERMES_HOME/.api_server_key" 2>/dev/null | tr -d '\\r\\n')
          if [ -z "$API_KEY" ] && [ -f "$HERMES_HOME/data/.env" ]; then
            API_KEY=$(grep -E "^API_SERVER_KEY=" "$HERMES_HOME/data/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r\\n' || true)
          fi
          if [ -z "$API_KEY" ] && [ -f "$HERMES_HOME/.env" ]; then
            API_KEY=$(grep -E "^API_SERVER_KEY=" "$HERMES_HOME/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r\\n' || true)
          fi
          echo "api_key=$API_KEY"
          echo "===END_CHECK==="
        )`;

        conn.exec(checkCmd, (err, stream) => {
          if (err) { send(`ERROR: 远程执行失败: ${err.message}\n`); conn.end(); return resolve({ ok: false, error: err.message }); }
          let output = '';
          stream.on('data', (d) => { output += d.toString(); });
          stream.on('stderr', (d) => { send(d.toString()); });
          stream.on('close', () => {
            conn.end();
            // 解析检查结果
            const lines = output.split('\n');
            const result = {};
            for (const line of lines) {
              const m = line.match(/^(\w+)=(.*)$/);
              if (m) result[m[1]] = m[2];
            }
            const deployed = result.hermes_home_exists === 'yes' || result.channel_port !== 'none';
            const channelUp = result.channel_health && result.channel_health !== 'none' && result.channel_health.includes('ok');
            const proxyUp = result.proxy_health && result.proxy_health !== 'none' && result.proxy_health.includes('ok');
            const apiKey = result.api_key || '';
            const channelVersion = result.channel_version || 'none';
            const channelBuild = parseInt(result.channel_build || '0', 10) || 0;
            const proxyEnv = result.proxy_env || 'no';
            // 与 src/agent/channel.js 的 REQUIRED_CHANNEL_VERSION 保持一致
            const REQUIRED_CHANNEL_VERSION = '2.2';
            const REQUIRED_CHANNEL_BUILD = 8;
            const verAtLeast = (v, req) => {
              if (!v || v === 'none') return false;
              const a = String(v).split('.').map((n) => parseInt(n, 10) || 0);
              const b = String(req).split('.').map((n) => parseInt(n, 10) || 0);
              for (let i = 0; i < Math.max(a.length, b.length); i++) {
                const x = a[i] || 0, y = b[i] || 0;
                if (x !== y) return x > y;
              }
              return true;
            };
            // 已部署但服务端通道脚本缺失或版本低于客户端要求 → 需要升级部署
            const channelOutdated = deployed && !verAtLeast(channelVersion, REQUIRED_CHANNEL_VERSION);
            // v4.10.3：协议版本够了但脚本内容版本过旧 -> 也需要升级部署
            const channelBuildStale = deployed && verAtLeast(channelVersion, REQUIRED_CHANNEL_VERSION) && channelBuild < REQUIRED_CHANNEL_BUILD;

            send(`[check] Hermes 目录: ${result.hermes_home_exists || '?'}\n`);
            send(`[check] Hermes CLI: ${result.hermes_cli || 'none'}\n`);
            send(`[check] Gateway 22122: ${result.gateway_port !== 'none' ? '监听中' : '未监听'}\n`);
            send(`[check] WS 通道 8822: ${result.channel_port !== 'none' ? '监听中' : '未监听'}\n`);
            send(`[check] 推理代理 8811: ${result.proxy_port !== 'none' ? '监听中' : '未监听'}\n`);
            send(`[check] 通道健康: ${channelUp ? 'OK' : '不可达'}\n`);
            send(`[check] 通道版本: ${channelVersion} (build ${channelBuild})${channelOutdated ? '（版本过旧，需要 ' + REQUIRED_CHANNEL_VERSION + '+）' : ''}${channelBuildStale ? '（脚本过旧，需要 build ' + REQUIRED_CHANNEL_BUILD + '+）' : ''}\n`);
            send(`[check] 上游配置 buddy-proxy.env: ${proxyEnv === 'yes' ? '存在' : '不存在'}\n`);
            send(`[check] API Key: ${apiKey ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : '未找到'}\n`);

            if (!deployed) {
              send('[check] Hermes 尚未部署，请先执行部署。\n');
            } else if (!apiKey) {
              send('[check] 已部署但未找到 API Key，请手动检查服务端配置。\n');
            } else if (channelOutdated) {
              send('[check] 服务端通道版本过旧，需要升级部署。\n');
            } else if (channelBuildStale) {
              send('[check] 服务端通道脚本过旧（缺少新功能），请重新部署以更新。\n');
            } else {
              send('[check] 检查完成，可以连接。\n');
            }

            logger.info('ssh-check-complete', { host, deployed, channelUp, proxyUp, apiKeyFound: !!apiKey, channelVersion, channelBuild, channelOutdated, channelBuildStale, proxyEnv });
            resolve({ ok: true, deployed, channelUp, proxyUp, apiKey, host, channelVersion, channelBuild, channelOutdated, channelBuildStale, proxyEnv });
          });
        });
      });

      conn.on('error', (e) => {
        send(`ERROR: SSH 连接失败: ${e.message}\n`);
        resolve({ ok: false, error: e.message });
      });

      conn.connect(connConfig);
    });
  });

  // ---- 对话 ----
  handle('buddy:chat', async (event, request) => {
    const requestId = String((request && request.requestId) || `req-${Date.now()}`);
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const text = pending;
      pending = '';
      safeSend(event.sender, 'buddy:chat:event', { requestId, type: 'text', text });
    };
    const forward = (chatEvent) => {
      // 文本增量合并后再过 IPC，长回复才不会把渲染进程刷爆。
      if (chatEvent.type === 'text') {
        pending += chatEvent.text || '';
        if (!timer) timer = setTimeout(flush, TEXT_FLUSH_MS);
        return;
      }
      flush();
      safeSend(event.sender, 'buddy:chat:event', chatEvent);
    };
    try {
      return await manager.send(
        {
          requestId,
          // 多模态：渲染层构造的高层 parts（text/image/file/audio/video）
          parts: (request && request.parts) || undefined,
          text: request && request.text,
          model: request && request.model,
          onConfirm: (payload) => requestConfirm(event.sender, payload)
        },
        forward
      );
    } finally {
      if (timer) clearTimeout(timer);
      flush();
      safeSend(event.sender, 'buddy:chat:event', { requestId, type: 'closed' });
    }
  });
  handle('buddy:chat:abort', (_event, requestId) => ({ aborted: manager.abort(requestId) }));

  // 渲染层把用户的选择送回来，唤醒挂起的确认
  handle('buddy:confirm:reply', (_event, { id, approved } = {}) => {
    const resolver = pendingConfirms.get(String(id));
    if (!resolver) return { ok: false, reason: 'no_pending_confirm' };
    pendingConfirms.delete(String(id));
    resolver(approved);
    return { ok: true };
  });

  // ---- 本地媒体引擎（Whisper / ffmpeg 的一键安装） ----
  // 引擎装在 <userData>/media，不需要管理员权限，也不写 PATH。
  handle('buddy:media-engines:status', () => mediaEngines.getStatus(app.getPath('userData')));
  handle('buddy:media-engines:open-dir', () => mediaEngines.openDir(app.getPath('userData')));
  handle('buddy:media-engines:install', async (event, opts = {}) => {
    try {
      return await mediaEngines.install({
        appDir: app.getPath('userData'),
        components: opts.components || ['whisper', 'model', 'ffmpeg'],
        model: opts.model || 'base',
        onProgress: (p) => safeSend(event.sender, 'buddy:media-engines:progress', p || {}),
      });
    } catch (error) {
      return { error: String((error && error.message) || error || '安装失败') };
    }
  });

  // ---- 智能体 ----
  handle('buddy:agents', () => manager.listAgents());
  handle('buddy:agents:create', (_event, input) => manager.createAgent(input || {}));
  handle('buddy:agents:update', (_event, { id, patch } = {}) => manager.updateAgent(id, patch || {}));
  handle('buddy:agents:remove', (_event, id) => manager.removeAgent(id));
  handle('buddy:agents:activate', (_event, id) => manager.activateAgent(id));

  // ---- 工作区 ----
  handle('buddy:workspace', () => manager.describeWorkspace());
  handle('buddy:workspace:set', (_event, dir) => manager.setWorkspace(dir));
  handle('buddy:workspace:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Hermes 工作目录',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true };
    return manager.setWorkspace(result.filePaths[0]);
  });
  // 纯选路径，不产生任何副作用（供智能体配置使用）。
  handle('buddy:workspace:dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择智能体工作目录',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });
  handle('buddy:workspace:open', async (_event, target) => {
    const dir = target && String(target).trim() ? target : (manager.workspace ? manager.workspace.dir : null);
    if (!dir) throw new Error('还没有工作目录');
    const opened = await shell.openPath(dir);
    if (opened) throw new Error(opened);
    return { opened: true, path: dir };
  });

  // ---- 权限 ----
  handle('buddy:permission:set', (_event, level) => manager.setPermission(level));

  // ---- 角色 / 记忆 / 技能 ----
  handle('buddy:persona', () => ({ persona: manager.getPersona() }));
  handle('buddy:persona:save', (_event, text) => manager.savePersona(text));
  handle('buddy:memory', (_event, scope = 'project') => ({ scope, content: manager.getMemory(scope) }));
  handle('buddy:memory:save', (_event, { scope = 'project', content } = {}) => manager.saveMemory(content, scope));
  handle('buddy:memory:remember', (_event, { scope = 'project', line } = {}) => manager.rememberLine(line, scope));
  handle('buddy:memory:diagnostics', () => manager.memoryDiagnostics());
  handle('buddy:skills', () => ({ skills: manager.listSkills() }));
  handle('buddy:skills:read', (_event, name) => ({ skill: manager.readSkill(name) }));
  handle('buddy:skills:save', (_event, { name, content, description } = {}) => ({ skill: manager.saveSkill(name, content, description) }));
  handle('buddy:skills:remove', (_event, name) => manager.removeSkill(name));

  // ---- 环境与依赖 ----
  handle('buddy:toolchain', () => ({ tools: manager.toolchain() }));
  handle('buddy:toolchain:install', (_event, id) => installTool(id));

  // ---- 其它 ----
  handle('buddy:update', async () => {
    const result = await checkForUpdates({ currentVersion: app.getVersion(), fetchImpl: updater.fetchImpl });
    // 探测成功且确实有新版本时，把本地已下载好的安装包状态一并带上，UI 可以直接显示"重启即更新"。
    if (result.ok && result.updateAvailable) {
      result.readyToInstall = updater.hasReadyInstaller();
    }
    return result;
  });
  // 后台下载更新：进度经 buddy:update:progress 推给渲染层，聊天不受影响。
  handle('buddy:update:download', async (_event, info = {}) => {
    const urls = info.useMirror === false
      ? [info.downloadUrl]
      : [info.mirrorUrl || info.downloadUrl, info.downloadUrl]; // 大陆网络默认镜像优先，失败回落直连
    const download = updater.download(urls, {
      expectedSize: Number(info.size) || 0,
      onProgress: (progress) => safeSend(mainWindow && mainWindow.webContents, 'buddy:update:progress', progress)
    });
    return download;
  });
  handle('buddy:update:install', () => {
    const result = updater.install();
    // 给安装器 1 秒启动时间，然后退出旧进程；NSIS /S 完成后会自动拉起新版本。
    setTimeout(() => app.exit(0), 1000);
    return result;
  });
  handle('buddy:open-external', async (_event, url) => {
    const target = String(url || '');
    if (!EXTERNAL_ALLOWLIST.some((pattern) => pattern.test(target))) throw new Error('该链接不在允许列表中');
    await shell.openExternal(target);
    return { opened: true };
  });
  handle('buddy:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    logFile: logger.file || null,
    appDir: app.getPath('userData'),
    encryptionAvailable: manager.store.isEncryptionAvailable()
  }));

  // ---- 预测模式（v4.0）：事件驱动主动预判 ----
  const getPredict = () => {
    if (!predictController) throw new Error('预测模式组件未初始化（可能初始化失败，请查看 buddy.log）');
    return predictController;
  };

  /** 安装目录（exe 路径），给 Defender 加排除区用。 */
  function predictAppPath() {
    try {
      const p = app.getPath('exe');
      return p || '';
    } catch (_) { return ''; }
  }

  handle('buddy:predict:status', () => getPredict().getStatus());
  handle('buddy:predict:enable', async () => getPredict().enable());
  handle('buddy:predict:disable', async () => getPredict().disable());
  handle('buddy:predict:one-click-off', async () => getPredict().oneClickOff());
  handle('buddy:predict:set-model', (_event, model) => getPredict().setModel(model));
  handle('buddy:predict:set-sensitivity', (_event, s) => getPredict().setSensitivity(s));
  handle('buddy:predict:set-authorized', (_event, v) => getPredict().setAuthorized(v));
  handle('buddy:predict:crystallization', () => getPredict().getCrystallization());
  handle('buddy:predict:trigger', (_event, rule) => getPredict().triggerRule(rule || 'word_writing'));
  // VLM 引擎现状（是否已装 llama-server / 模型 / mmproj），UI 据此提示安装。
  // v4.7：把用户指定的本地模型/视觉投影路径一起算进去（自定义优先于自动下载的那份）。
  handle('buddy:predict:engine-status', () => {
    const cfg = getPredict().config;
    const modelKey = cfg.get('vlmModel') || 'qwen2.5-vl-3b';
    const st = llamaEngine.getStatus(app.getPath('userData'), modelKey, {
      modelPath: cfg.get('vlmModelPath') || '',
      mmprojPath: cfg.get('vlmMmprojPath') || '',
    });
    // v4.8：顺带把手动下载直链给设置页（用户可以自己用下载器先下完再导入）
    st.links = llamaEngine.downloadLinks(modelKey);
    return st;
  });
  // 杀软检测 + 可选给 Defender 加排除区（火绒/360 引导手动，不自动动）。
  handle('buddy:predict:av', async (_event, { addExclusion } = {}) => {
    const list = detectAntivirus();
    let defenderExcluded = false;
    if (addExclusion && list.some((a) => a.key === 'defender')) {
      const r = await addDefenderExclusion(predictAppPath(), {});
      defenderExcluded = Boolean(r && r.ok);
    }
    return { antivirus: list, defenderExcluded };
  });

  // ---- VLM 引擎一键安装（v4.1）：llama.cpp + GGUF + mmproj，进度实时推给渲染层 ----
  let engineInstallPromise = null;   // 并发守卫：同一时间只允许一次安装
  handle('buddy:predict:install-engine', async (_event) => {
    if (engineInstallPromise) return { error: '已有安装任务在进行中' };
    // v4.4：model 只表示运行模式，具体本地模型 id 在 vlmModel
    const vlmModel = (predictController && predictController.config.get('vlmModel')) || 'qwen2.5-vl-3b';
    // v4.7：已指定本地 GGUF 则跳过 2GB 模型下载，只补 llama-server / mmproj
    engineInstallPromise = llamaEngine.ensure({
      appDir: app.getPath('userData'),
      model: vlmModel,
      modelPath: (predictController && predictController.config.get('vlmModelPath')) || '',
      mmprojPath: (predictController && predictController.config.get('vlmMmprojPath')) || '',
      onProgress: (p) => safeSend(mainWindow && mainWindow.webContents, 'buddy:predict:engine-progress', p || {}),
    }).then(
      (status) => { engineInstallPromise = null; return { status }; },
      (e) => { engineInstallPromise = null; return { error: e.message }; }
    );
    return engineInstallPromise;
  });

  // v4.2：主动预测「现在就看一眼屏幕」（桌宠点击 / 设置页按钮 / 巡检共用）
  handle('buddy:predict:now', async () => runProactivePredict());
  // v4.2：桌宠巡检间隔（分钟，0=关闭）
  handle('buddy:predict:set-patrol', (_event, minutes) => {
    const m = Math.max(0, Math.min(120, Number(minutes) || 0));
    getPredict().config.set({ proactivePatrolMinutes: m });
    return getPredict().getStatus();
  });

  // v4.10.18：推理记录--主进程持有一份回调，push 时转发给渲染层
  handle('buddy:predict:log', () => {
    const pc = getPredict();
    return pc ? pc.getLog() : [];
  });
  handle('buddy:predict:clear-log', () => {
    const pc = getPredict();
    if (pc) pc.clearLog();
    return { ok: true };
  });
  // PredictController 构造时注入 onLogEntry 回调 -> 实时推给渲染层
  // 在 registerIpc 之前注册，但回调引用 mainWindow（延迟取）
  predictLogCallback = (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('buddy:predict:log-entry', entry); } catch (_) {}
    }
  };

  // ---- 桌宠猫咪（v4.1）：最小化主窗口为桌面小猫，预测浮层弹在猫旁边 ----
  handle('buddy:pet:minimize', async () => {
    if (!pet) throw new Error('桌宠未初始化');
    const bounds = await pet.show();
    if (mainWindow) { try { mainWindow.hide(); } catch (_) {} }
    try { pet.speak('喵～ 想我的时候就点点我！'); } catch (_) {}
    return { ok: true, bounds };
  });
  handle('buddy:pet:restore', async () => {
    restoreMainWindow();
    return { ok: true };
  });
  handle('buddy:pet:hide', async () => {
    if (pet) pet.hide();
    return { ok: true };
  });
  handle('buddy:pet:status', () => ({
    available: Boolean(pet && pet.available),
    visible: pet ? pet.isVisible() : false,
  }));

  // v4.7：本地推理模型（GGUF）—— 让用户直接指定已下载好的文件，跳过 2GB 下载
  handle('buddy:predict:model-pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地 GGUF 推理模型',
      properties: ['openFile'],
      filters: [{ name: 'llama.cpp GGUF 模型', extensions: ['gguf'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const file = r.filePaths[0];
    if (!/\.gguf$/i.test(file)) return { error: '不是 GGUF 模型文件（.gguf）' };
    getPredict().config.set({ vlmModelPath: file });
    getPredict().resetRunner();
    return { ok: true, path: file };
  });
  handle('buddy:predict:mmproj-pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择视觉投影文件（mmproj，通常文件名以 mmproj 开头）',
      properties: ['openFile'],
      filters: [{ name: 'mmproj GGUF', extensions: ['gguf'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const file = r.filePaths[0];
    getPredict().config.set({ vlmMmprojPath: file });
    getPredict().resetRunner();
    return { ok: true, path: file };
  });
  handle('buddy:predict:model-reset', () => {
    getPredict().config.set({ vlmModelPath: '', vlmMmprojPath: '' });
    getPredict().resetRunner();
    return { ok: true };
  });

  // v4.6：桌宠本地模型导入（支持 Cubism 3/4/5 的 *.model3.json 文件夹）
  handle('buddy:pet:model-pick', async () => {
    if (!pet) throw new Error('桌宠未初始化');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Live2D 模型文件夹（内含 .model3.json）',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const res = pet.setModel(r.filePaths[0]);
    return { ok: true, file: res.file, dir: r.filePaths[0] };
  });
  handle('buddy:pet:model-reset', async () => {
    if (!pet) throw new Error('桌宠未初始化');
    return pet.clearModel();
  });
  handle('buddy:pet:model-status', () => {
    const m = pet ? pet.getModel() : null;
    return {
      custom: Boolean(m),
      name: m ? m.file : 'Hiyori.model3.json（内置）',
      dir: m ? m.dir : '',
    };
  });
}

function builtinSkillsDir() {
  // 打包后 extraResources 把 skills 放到 resources 下，开发时直接指向仓库目录。
  const packaged = path.join(process.resourcesPath || '', 'skills');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', 'skills');
  return fs.existsSync(dev) ? dev : packaged;
}

async function clearSessionCache() {
  // 每次启动强制清掉 Chromium 的 HTTP / 渲染缓存，防止安装新版本后仍加载旧 asar 里的页面。
  try {
    const { session } = require('electron');
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'localstorage', 'websql'] });
    logger.info('session-cache-cleared');
  } catch (error) {
    logger.warn('session-cache-clear-failed', { error: error.message });
  }
}

async function bootstrap() {
  await clearSessionCache();
  const userData = app.getPath('userData');
  logger = createLogger({ dir: path.join(userData, 'logs'), level: process.env.BUDDY_LOG_LEVEL || 'info' });
  updater = new Updater({ logger });
  // 更新请求优先走 Chromium 网络栈（net.fetch）：跟随系统代理、读 Windows 证书库，
  // 对 SakuraCat 等 MITM 代理兼容；证书仍失败时 fetchLenient 会降级重试。
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') updater.fetchImpl = net.fetch;
  } catch (error) {
    logger.warn('net-fetch-unavailable', { error: error.message });
  }
  const store = new ConnectionStore({ dir: userData, safeStorage, logger });

  // 网络请求优先走 Chromium 网络栈（net.fetch）：跟随系统代理、读 Windows 证书库，
  // 对 SakuraCat 等 MITM 代理兼容；Node 的 globalThis.fetch 不读系统代理，
  // 局域网请求被代理拦截时会卡死（v2.3.21 修复：之前 SessionManager 用 globalThis.fetch
  // 导致通道模式下 Gateway /api/sessions POST 卡住，触发 30 秒 IPC 超时）。
  let buddyFetchImpl = globalThis.fetch;
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') buddyFetchImpl = net.fetch;
  } catch (error) {
    logger.warn('net-fetch-unavailable-for-session', { error: error.message });
  }

  manager = new SessionManager({
    store,
    provisioning,
    logger,
    registry,
    product: 'buddy',
    deployment: 'windows',
    appDir: userData,
    builtinSkillsDir: builtinSkillsDir(),
    fetchImpl: buddyFetchImpl
  });

  // ---- 预测模式（v4.0）：事件驱动主动预判 ----
  // 所有依赖惰性加载，初始化失败不应拖垮主连接流程。
  try {
    const { PredictController } = require('./predict/predict-controller');
    const { captureActiveWindow } = require('./predict/capture');
    const { PredictPanel } = require('./predict/predict-panel');
    const { ActionExecutor } = require('./predict/action-executor');
    const { LocalModelRunner } = require('./predict/local-model-runner');
    const llama = require('./predict/llama-engine');
    const { getForegroundWindowInfo } = require('./predict/win-info');
    const { addDefenderExclusion } = require('./predict/behavior-hooks');

    const panel = new PredictPanel({
      logger,
      // 桌宠可见时，预测浮层优先弹在猫咪旁边（pet 在下方惰性创建）
      anchorProvider: () => (pet ? pet.panelAnchor() : null),
      // v4.8.4：面板「思考中」安全网触发时重置控制器，避免模型卡死后 _processing 永久锁死
      onThinkingTimeout: () => {
        if (predictController) predictController.onThinkingTimeout();
      },
    });
    const actionExecutor = new ActionExecutor({ clipboard: require('electron').clipboard, logger });
    predictController = new PredictController({
      appDir: userData,
      logger,
      capture: { captureActiveWindow },
      panel,
      actionExecutor,
      resolveWindow: async () => getForegroundWindowInfo(),
      // v4.10.2：「生成并插入」的内容生成——走同一条远端通道，
      // 服务端按 stage=generate_content 走生成分支返回 {content}
      generateContentFn: (payload) => {
        const ch = manager && manager.channel ? manager.channel : null;
        if (!ch) return Promise.reject(new Error('远端通道未连接'));
        return ch.predict(payload, null);
      },
      // 远端预测模式（model='remote'）需要通道客户端。manager.channel 在通道模式连接后才有值，
      // predict-controller._analyze 在运行时通过 resolveChannel 惰性取最新的，不锁死在构造时刻。
      resolveChannel: () => (manager && manager.channel ? manager.channel : null),
      buildRunner: (cfg) => {
        const server = llama.findLlamaServer(userData);
        const vlmModel = cfg.get('vlmModel') || 'qwen2.5-vl-3b';
        // v4.7：用户指定的本地 GGUF / mmproj 优先
        const modelPath = llama.findVlmModel(userData, vlmModel, cfg.get('vlmModelPath'))
          || llama.findVlmModel(userData, 'qwen2.5-vl-3b');
        const mmproj = llama.findMmproj(userData, cfg.get('vlmMmprojPath'));
        if (!server || !modelPath) return null;
        return new LocalModelRunner({ llamaServerPath: server, modelPath, mmprojPath: mmproj, logger });
      },
      // v4.10.18：推理记录实时推送--注入 onLogEntry 回调，
      // registerIpc 中会把 predictLogCallback 赋值为转发给 mainWindow 的函数。
      onLogEntry: (entry) => {
        if (typeof predictLogCallback === 'function') predictLogCallback(entry);
      },
    });
    logger.info('predict-controller-ready');

    // v4.0：读取 NSIS 安装向导写的授权文件，合并到 PredictConfig
    try {
      const { mergeInstallAuth } = require('./predict/install-wizard');
      const authResult = mergeInstallAuth(userData, predictController.config, logger);
      if (authResult) {
        logger.info('install-auth-merged', { authorized: authResult.authorized, defenderExcluded: authResult.defenderExcluded });
      }
    } catch (e) {
      logger.warn('install-auth-merge-failed', { error: e.message });
    }

    // v4.1：桌宠猫咪。v4.2：菜单「立即预测」走主动预测。v4.3：点猫弹菜单 + 自定义文案。
    try {
      const { DesktopPet } = require('./predict/desktop-pet');
      pet = new DesktopPet({
        logger,
        dataDir: userData,
        onPredict: () => runProactivePredict(),
        onRestore: () => restoreMainWindow(),
        onHide: () => logger.info('pet-hidden'),
      });
      logger.info('desktop-pet-ready');
      startPetPatrol();
    } catch (e) {
      pet = null;
      logger.warn('desktop-pet-init-failed', { error: e.message });
    }
  } catch (e) {
    logger.error('predict-init-failed', { error: e.message });
  }

  registerIpc();
  createWindow();

  // v4.8.3：常驻系统托盘。主窗口隐藏/关闭后仍可通过托盘恢复，预测保持运行。
  try {
    trayInstance = createTray({
      logger,
      handlers: {
        onShowMainWindow: restoreMainWindow,
        onShowPet: () => { if (pet) pet.show().catch(() => {}); },
        onProactivePredict: () => { runProactivePredict().catch(() => {}); },
        onQuit: () => { isQuitting = true; app.quit(); },
      },
      hasPet: Boolean(pet),
    });
  } catch (e) {
    logger.warn('tray-create-failed', { error: e.message });
  }

  logger.info('started', { version: app.getVersion(), userData, smoke: SMOKE_TEST });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // v4.5：pet:// 特权协议必须在 app ready 之前注册（Live2D 模型 fetch 用）
  try { require('./predict/desktop-pet').DesktopPet.registerSchemes(); } catch (_) {}
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(bootstrap);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  app.on('before-quit', () => {
    isQuitting = true;
    try { predictController && predictController.disable().catch(() => {}); } catch (_) {}
    try { stopPetPatrol(); } catch (_) {}
    try { if (pet) pet.destroy(); } catch (_) {}
    try { destroyTray(); trayInstance = null; } catch (_) {}
  });
  app.on('window-all-closed', () => {
    // v4.8.3：有托盘时隐藏到后台常驻，保持预测/巡检运行；无托盘降级为原来退出行为。
    if (!trayInstance && process.platform !== 'darwin') app.quit();
  });
  process.on('uncaughtException', (error) => logger.error('uncaught-exception', { error: error.message }));
  process.on('unhandledRejection', (reason) => logger.error('unhandled-rejection', { error: String(reason) }));
}
