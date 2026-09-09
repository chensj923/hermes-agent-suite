'use strict';
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createGateway, deriveManagementUrl, provision } = require('@hermes/provisioning');

const configPath = () => path.join(app.getPath('userData'), 'buddy.connection');
function loadConnection() {
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(configPath()))); } catch (_) { return null; }
}
function saveConnection(connection) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，无法保存 API Key');
  fs.writeFileSync(configPath(), safeStorage.encryptString(JSON.stringify(connection)), { mode: 0o600 });
}
async function verifyAndProvision(connection) {
  const sessionGateway = createGateway(connection);
  await sessionGateway.health();
  const session = await sessionGateway.createSession('buddy');
  const managementGateway = createGateway({ baseUrl: connection.managementUrl || deriveManagementUrl(connection.baseUrl), apiKey: connection.apiKey });
  const deployment = await provision({ gateway: managementGateway, product: 'buddy', deployment: 'windows' });
  saveConnection(connection);
  return { session, deployment };
}
function createWindow() {
  const win = new BrowserWindow({ width: 880, height: 700, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(() => { ipcMain.handle('buddy:connection', () => loadConnection() ? { configured: true } : { configured: false }); ipcMain.handle('buddy:connect', (_, connection) => verifyAndProvision(connection)); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
