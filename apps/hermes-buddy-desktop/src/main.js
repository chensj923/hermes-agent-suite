'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const provisioning = require('@hermes/provisioning');
const registry = require('@hermes/capability-registry');
const { createLogger } = require('./logger');
const { ConnectionStore } = require('./connection-store');
const { SessionManager } = require('./session-manager');
const { checkForUpdates } = require('./update-checker');
const { install: installTool } = require('./toolchain');

// 打包冒烟：启动 → 加载完成 → 退出，用于 CI 校验主进程与渲染层能起来。
const SMOKE_TEST = process.argv.includes('--smoke-test');
const TEXT_FLUSH_MS = 25;
const CONFIRM_TIMEOUT_MS = 120000;
// 只允许把这些外链交给系统浏览器，其余一律拒绝。
const EXTERNAL_ALLOWLIST = [/^https:\/\/github\.com\//i, /^https:\/\/ghfast\.top\//i];

let mainWindow = null;
let manager = null;
let logger = { info() {}, warn() {}, error() {}, debug() {} };
const pendingConfirms = new Map();

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
    const result = await manager.connect(connection);
    return { ...result, workspace: manager.describeWorkspace() };
  });
  handle('buddy:resume', async () => {
    const result = await manager.resume();
    return { ...result, status: manager.status() };
  });
  handle('buddy:disconnect', () => manager.disconnect());
  handle('buddy:models', () => manager.models());
  handle('buddy:history', () => manager.history());
  handle('buddy:clear-history', () => manager.clearHistory());
  handle('buddy:provisioning-status', () => manager.provisioningStatus());

  // ---- 诊断 + 服务端准备脚本（连接前给用户一个清晰的"哪步没配"清单） ----
  handle('buddy:diagnose', async (_event, options = {}) => {
    return diagnose({ llmUrl: options.llmUrl, gatewayBaseUrl: options.gatewayBaseUrl, managementUrl: options.managementUrl });
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
        { requestId, text: request && request.text, onConfirm: (payload) => requestConfirm(event.sender, payload) },
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
  handle('buddy:skills', () => ({ skills: manager.listSkills() }));
  handle('buddy:skills:read', (_event, name) => ({ skill: manager.readSkill(name) }));
  handle('buddy:skills:save', (_event, { name, content, description } = {}) => ({ skill: manager.saveSkill(name, content, description) }));
  handle('buddy:skills:remove', (_event, name) => manager.removeSkill(name));

  // ---- 环境与依赖 ----
  handle('buddy:toolchain', () => ({ tools: manager.toolchain() }));
  handle('buddy:toolchain:install', (_event, id) => installTool(id));

  // ---- 其它 ----
  handle('buddy:update', () => checkForUpdates({ currentVersion: app.getVersion() }));
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
}

function builtinSkillsDir() {
  // 打包后 extraResources 把 skills 放到 resources 下，开发时直接指向仓库目录。
  const packaged = path.join(process.resourcesPath || '', 'skills');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', 'skills');
  return fs.existsSync(dev) ? dev : packaged;
}

function bootstrap() {
  const userData = app.getPath('userData');
  logger = createLogger({ dir: path.join(userData, 'logs'), level: process.env.BUDDY_LOG_LEVEL || 'info' });
  const store = new ConnectionStore({ dir: userData, safeStorage, logger });
  manager = new SessionManager({
    store,
    provisioning,
    logger,
    registry,
    product: 'buddy',
    deployment: 'windows',
    appDir: userData,
    builtinSkillsDir: builtinSkillsDir()
  });
  registerIpc();
  createWindow();
  logger.info('started', { version: app.getVersion(), userData, smoke: SMOKE_TEST });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(bootstrap);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  process.on('uncaughtException', (error) => logger.error('uncaught-exception', { error: error.message }));
  process.on('unhandledRejection', (reason) => logger.error('unhandled-rejection', { error: String(reason) }));
}
