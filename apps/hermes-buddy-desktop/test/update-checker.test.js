const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseVersion, pickAsset, mirrorUrl, checkForUpdates, ASSET_NAME } = require('../src/update-checker');

test('compares semantic versions including prereleases', () => {
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '2.0.0-dev'), 1, '正式版应大于预发布');
  assert.equal(compareVersions('2.0.0-dev', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.0-rc1', '2.0.0-dev'), 1);
  assert.equal(compareVersions('1.9.9', '2.0.0-dev'), -1);
  assert.deepEqual(parseVersion('v3.1').parts, [3, 1, 0]);
});

test('prefers the canonical installer asset name', () => {
  const release = { assets: [{ name: 'other.exe', browser_download_url: 'u1' }, { name: ASSET_NAME, browser_download_url: 'u2' }] };
  assert.equal(pickAsset(release).browser_download_url, 'u2');
  assert.equal(pickAsset({ assets: [{ name: 'setup.exe', browser_download_url: 'u3' }] }).browser_download_url, 'u3');
  assert.equal(pickAsset({ assets: [] }), null);
});

test('builds a mainland-friendly mirror url', () => {
  assert.equal(mirrorUrl('https://github.com/x/y/releases/download/v1/a.exe'), 'https://ghfast.top/github.com/x/y/releases/download/v1/a.exe');
  assert.equal(mirrorUrl(null), null);
});

test('reports an available update with download links', async () => {
  const result = await checkForUpdates({
    currentVersion: '2.0.0-dev',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v2.1.0',
        html_url: 'https://github.com/chensj923/hermes-agent-suite/releases/tag/v2.1.0',
        assets: [{ name: ASSET_NAME, browser_download_url: 'https://github.com/chensj923/hermes-agent-suite/releases/download/v2.1.0/hermes-suite-windows-x86_64.exe' }],
        body: '双语说明'
      })
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, 'v2.1.0');
  assert.match(result.mirrorUrl, /^https:\/\/ghfast\.top\//);
});

test('same version is not an update', async () => {
  const result = await checkForUpdates({ currentVersion: '2.0.0-dev', fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v2.0.0-dev', assets: [] }) }) });
  assert.equal(result.updateAvailable, false);
});

test('network problems degrade quietly', async () => {
  // 显式传 null 表示运行时没有 fetch，避免默认参数回落到真实网络请求。
  assert.deepEqual(await checkForUpdates({ currentVersion: '1.0.0', fetchImpl: null }), { ok: false, reason: 'no_fetch' });
  const httpFail = await checkForUpdates({ currentVersion: '1.0.0', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(httpFail, { ok: false, reason: 'http_503' });
  const thrown = await checkForUpdates({ currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.equal(thrown.reason, 'network');
});
