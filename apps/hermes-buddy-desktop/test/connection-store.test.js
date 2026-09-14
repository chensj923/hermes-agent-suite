const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConnectionStore, normalizeConnectionInput, publicView, migrate, SCHEMA_VERSION } = require('../src/connection-store');

// 模拟 Electron safeStorage：用 base64 代替 DPAPI，保证落盘内容不是可读明文。
function fakeSafeStorage({ available = true, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      if (failDecrypt) throw new Error('DPAPI 解密失败');
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('密文格式错误');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    }
  };
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-store-')); }

test('normalizes user input and derives the llm url', () => {
  const connection = normalizeConnectionInput({ baseUrl: '192.168.0.246:22124', apiKey: ' secret ' });
  assert.equal(connection.baseUrl, 'http://192.168.0.246:22124');
  // managementUrl 不再自动推导（服务端 8700 没有 /api/provisioning 端点），仅显式填写时保留
  assert.equal(connection.managementUrl, '');
  // llmUrl 没填 → 同主机上的 Buddy 直通代理 8811（22122 是 agent 端点，不能用）
  assert.equal(connection.llmUrl, 'http://192.168.0.246:8811/v1/chat/completions');
  assert.equal(connection.apiKey, 'secret');
  assert.equal(connection.profile, 'buddy');
  assert.equal(connection.model, 'hermes-agent');
  assert.equal(connection.schemaVersion, SCHEMA_VERSION);
});

test('baseUrl is optional — LLM-only mode derives gateway from llmUrl', () => {
  const connection = normalizeConnectionInput({
    llmUrl: 'http://192.168.0.246:8800/v1/chat/completions',
    apiKey: 'k'
  });
  assert.equal(connection.baseUrl, 'http://192.168.0.246:22122');
  assert.equal(connection.managementUrl, '');
  assert.equal(connection.llmUrl, 'http://192.168.0.246:8800/v1/chat/completions');
});

test('blank baseUrl + blank managementUrl: gateway stays empty (degraded mode)', () => {
  const connection = normalizeConnectionInput({ llmUrl: 'http://h:8800/v1', apiKey: 'k' });
  assert.equal(connection.baseUrl, 'http://h:22122');
  // managementUrl 不再自动推导，留空
  assert.equal(connection.managementUrl, '');
});

test('rejects unusable input before touching the disk', () => {
  // 既没 baseUrl 也没 llmUrl：会卡在 llmUrl 推导上
  assert.throws(() => normalizeConnectionInput({ baseUrl: '', apiKey: 'k' }), /推理端点|Hermes/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: '' }), /API Key 不能为空/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'a b' }), /不能包含空格/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'k', profile: 'Bad Name' }), /Profile 名非法/);
  // 协议非法
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'ftp://h:1', apiKey: 'k' }), /Gateway/);
});

test('publicView never exposes the api key', () => {
  const view = publicView(normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'super-secret' }));
  assert.equal(JSON.stringify(view).includes('super-secret'), false);
  assert.equal(view.configured, true);
  assert.deepEqual(publicView(null), { configured: false });
});

test('migrates v1 connection files in place', () => {
  const migrated = migrate({ baseUrl: 'http://h:22124', apiKey: 'k' });
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.managementUrl, '');
  // migrate 先把 baseUrl 的 22124 纠正为 22122，llmUrl 再落到同主机的直通代理 8811
  assert.equal(migrated.llmUrl, 'http://h:8811/v1/chat/completions');
  assert.equal(migrated.migratedFrom, 1);
  // 没有 baseUrl 也能迁：apiKey 是唯一硬性要求
  const llmOnly = migrate({ llmUrl: 'http://h:8800/v1', apiKey: 'k', schemaVersion: 1 });
  assert.equal(llmOnly.baseUrl, 'http://h:22122');
  assert.equal(llmOnly.llmUrl, 'http://h:8800/v1');
  assert.equal(migrate({ baseUrl: 'http://h' }), null);
  assert.equal(migrate(null), null);
});

test('saves atomically and reloads through safeStorage', () => {
  const dir = tempDir();
  const store = new ConnectionStore({ dir, safeStorage: fakeSafeStorage() });
  const connection = normalizeConnectionInput({ baseUrl: 'http://h:22124', apiKey: 'k' });
  const saved = store.save(connection);
  assert.ok(saved.savedAt);
  assert.equal(fs.existsSync(`${store.filePath}.tmp`), false, '临时文件必须被 rename 掉');
  // 落盘内容必须是密文，不能出现明文密钥。
  assert.equal(fs.readFileSync(store.filePath, 'utf8').includes('"apiKey":"k"'), false);
  const loaded = store.load();
  assert.equal(loaded.apiKey, 'k');
  assert.equal(store.exists(), true);
  store.clear();
  assert.equal(store.exists(), false);
  assert.equal(store.load(), null);
});

test('refuses to save when DPAPI is unavailable', () => {
  const store = new ConnectionStore({ dir: tempDir(), safeStorage: fakeSafeStorage({ available: false }) });
  assert.throws(() => store.save(normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'k' })), /凭据加密不可用/);
  assert.equal(store.exists(), false);
});

test('quarantines a file that cannot be decrypted on this machine', () => {
  const dir = tempDir();
  const writable = new ConnectionStore({ dir, safeStorage: fakeSafeStorage() });
  writable.save(normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'k' }));
  const broken = new ConnectionStore({ dir, safeStorage: fakeSafeStorage({ failDecrypt: true }) });
  assert.equal(broken.load(), null);
  assert.equal(fs.existsSync(broken.filePath), false);
  assert.equal(fs.existsSync(`${broken.filePath}.decrypt-failed`), true);
});

test('quarantines corrupted json instead of crashing at startup', () => {
  const dir = tempDir();
  const store = new ConnectionStore({ dir, safeStorage: fakeSafeStorage() });
  fs.writeFileSync(store.filePath, Buffer.from('enc:not-json', 'utf8'));
  assert.equal(store.load(), null);
  assert.equal(fs.existsSync(`${store.filePath}.parse-failed`), true);
});

// ---------- 通道模式（决策在 Hermes 服务端外挂通道，本机只执行工具）----------

test('channel mode derives ws channel url from host and skips llmUrl', () => {
  const c = normalizeConnectionInput({ mode: 'channel', baseUrl: '192.168.0.246', apiKey: 'k' });
  assert.equal(c.mode, 'channel');
  assert.equal(c.channelUrl, 'ws://192.168.0.246:8822/api/buddy/channel');
  assert.equal(c.llmUrl, '', '通道模式不需要本地 LLM 端点');
  assert.equal(c.baseUrl, 'http://192.168.0.246');
});

test('channel mode maps https host to wss and honors explicit override', () => {
  const tls = normalizeConnectionInput({ mode: 'channel', baseUrl: 'https://hermes.example.com', apiKey: 'k' });
  assert.equal(tls.channelUrl, 'wss://hermes.example.com:8822/api/buddy/channel');
  const overridden = normalizeConnectionInput({
    mode: 'channel', baseUrl: 'h:22122', channelUrl: 'ws://h:9999/custom', apiKey: 'k'
  });
  assert.equal(overridden.channelUrl, 'ws://h:9999/custom');
});

test('channel mode rejects when host (baseUrl) is missing', () => {
  assert.throws(() => normalizeConnectionInput({ mode: 'channel', apiKey: 'k' }), /通道模式需要填写/);
});

test('channel mode round-trips through publicView and migrate', () => {
  const c = normalizeConnectionInput({ mode: 'channel', baseUrl: 'h:22122', apiKey: 'k' });
  const v = publicView(c);
  assert.equal(v.mode, 'channel');
  assert.equal(v.channelUrl, 'ws://h:8822/api/buddy/channel');
  assert.equal(v.llmUrl, '');
  const m = migrate({ mode: 'channel', baseUrl: 'http://h:22122', apiKey: 'k', schemaVersion: 1 });
  assert.equal(m.mode, 'channel');
  assert.equal(m.channelUrl, 'ws://h:8822/api/buddy/channel');
  assert.equal(m.llmUrl, '', '迁移后通道模式仍不应带 LLM 端点');
});
