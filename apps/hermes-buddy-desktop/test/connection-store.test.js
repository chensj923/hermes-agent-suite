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

test('normalizes user input and derives the management url', () => {
  const connection = normalizeConnectionInput({ baseUrl: '192.168.0.246:22124', apiKey: ' secret ' });
  assert.equal(connection.baseUrl, 'http://192.168.0.246:22124');
  assert.equal(connection.managementUrl, 'http://192.168.0.246:8700');
  assert.equal(connection.apiKey, 'secret');
  assert.equal(connection.profile, 'buddy');
  assert.equal(connection.model, 'hermes-agent');
  assert.equal(connection.schemaVersion, SCHEMA_VERSION);
});

test('rejects unusable input before touching the disk', () => {
  assert.throws(() => normalizeConnectionInput({ baseUrl: '', apiKey: 'k' }), /地址不能为空/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: '' }), /API Key 不能为空/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'a b' }), /不能包含空格/);
  assert.throws(() => normalizeConnectionInput({ baseUrl: 'http://h:1', apiKey: 'k', profile: 'Bad Name' }), /Profile 名非法/);
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
  assert.equal(migrated.managementUrl, 'http://h:8700');
  assert.equal(migrated.migratedFrom, 1);
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
