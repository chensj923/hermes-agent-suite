'use strict';

/**
 * v4.0 install-wizard 单测：读取/合并/删除 install-auth.json。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');

const { readInstallAuth, deleteInstallAuth, mergeInstallAuth, firstRunNeeded, INSTALL_AUTH_FILE } = require('../src/predict/install-wizard');
const { PredictConfig } = require('../src/predict/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-'));
}

function makeAppDir() {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'predict'), { recursive: true });
  return dir;
}

function writeAuthFile(appDir, authorized, defenderExcluded) {
  fs.writeFileSync(
    path.join(appDir, 'predict', INSTALL_AUTH_FILE),
    JSON.stringify({ authorized, defenderExcluded })
  );
}

test('readInstallAuth：文件不存在时返回 null', () => {
  const appDir = makeAppDir();
  assert.strictEqual(readInstallAuth(appDir), null);
});

test('readInstallAuth：authorized=true + defenderExcluded=true', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, true, true);
  const r = readInstallAuth(appDir);
  assert.deepStrictEqual(r, { authorized: true, defenderExcluded: true });
});

test('readInstallAuth：authorized=false', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, false, false);
  const r = readInstallAuth(appDir);
  assert.deepStrictEqual(r, { authorized: false, defenderExcluded: false });
});

test('readInstallAuth：JSON 损坏时返回 null', () => {
  const appDir = makeAppDir();
  fs.writeFileSync(path.join(appDir, 'predict', INSTALL_AUTH_FILE), '{bad json');
  assert.strictEqual(readInstallAuth(appDir), null);
});

test('deleteInstallAuth：删除后 readInstallAuth 返回 null', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, true, false);
  assert.ok(readInstallAuth(appDir));
  deleteInstallAuth(appDir);
  assert.strictEqual(readInstallAuth(appDir), null);
});

test('mergeInstallAuth：authorized=true 时写 config.authorized=true 并删文件', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, true, true);
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  cfg.set({ authorized: false });
  const r = mergeInstallAuth(appDir, cfg, null);
  assert.deepStrictEqual(r, { authorized: true, defenderExcluded: true });
  assert.strictEqual(cfg.get('authorized'), true);
  // 文件应被删除
  assert.strictEqual(readInstallAuth(appDir), null);
});

test('mergeInstallAuth：authorized=false 时不改 config（不覆盖用户已有授权）', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, false, false);
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  cfg.set({ authorized: true });  // 用户已手动授权
  mergeInstallAuth(appDir, cfg, null);
  // 不应该被覆盖为 false
  assert.strictEqual(cfg.get('authorized'), true);
  // 但文件应被删除（只读一次）
  assert.strictEqual(readInstallAuth(appDir), null);
});

test('mergeInstallAuth：文件不存在时返回 null', () => {
  const appDir = makeAppDir();
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  const r = mergeInstallAuth(appDir, cfg, null);
  assert.strictEqual(r, null);
});

test('firstRunNeeded：已授权 -> false', () => {
  const appDir = makeAppDir();
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  cfg.set({ authorized: true });
  assert.strictEqual(firstRunNeeded(appDir, cfg), false);
});

test('firstRunNeeded：未授权 + 无安装文件 -> true', () => {
  const appDir = makeAppDir();
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  cfg.set({ authorized: false });
  assert.strictEqual(firstRunNeeded(appDir, cfg), true);
});

test('firstRunNeeded：未授权 + 安装文件 authorized=true -> false', () => {
  const appDir = makeAppDir();
  writeAuthFile(appDir, true, false);
  const cfg = new PredictConfig({ dataDir: path.join(appDir, 'predict') });
  cfg.set({ authorized: false });
  // 安装文件 authorized=true，不需要引导（等 merge 后就授权了）
  assert.strictEqual(firstRunNeeded(appDir, cfg), false);
});
