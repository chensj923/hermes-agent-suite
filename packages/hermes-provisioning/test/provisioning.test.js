const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('@hermes/capability-registry');
const {
  buildProvisioningRequest, provision, fetchProvisioningStatus, deriveManagementUrl,
  normalizeDevices, assertCredentialFree, ProvisioningError, DeviceError, SCHEMA_VERSION
} = require('../src');

function fakeGateway(handler) {
  return { request: async (path, options) => handler(path, options) };
}

test('builds a credential-free manifest for the buddy product', () => {
  const payload = buildProvisioningRequest({ product: 'buddy', deployment: 'windows' });
  assert.deepEqual(payload, {
    schema_version: SCHEMA_VERSION,
    product: 'buddy',
    profile: 'buddy',
    deployment: 'windows',
    capabilities: ['chat', 'desktop-tools'],
    devices: []
  });
});

test('rejects products deployed where they cannot run', () => {
  assert.throws(() => buildProvisioningRequest({ product: 'buddy', deployment: 'server' }), /不支持 server 部署/);
  assert.throws(() => buildProvisioningRequest({ product: 'ghost', deployment: 'windows' }), ProvisioningError);
  assert.throws(() => buildProvisioningRequest({ product: 'home', deployment: 'toaster' }), /未知部署位置/);
});

test('normalizes devices and blocks credentials in endpoints', () => {
  const devices = normalizeDevices([{ type: 'Camera' }, { id: 'mic 1!', type: 'microphone', endpoint: 'rtsp://192.168.0.10/live' }]);
  assert.deepEqual(devices, [
    { id: 'camera-1', type: 'camera', endpoint: '' },
    { id: 'mic1', type: 'microphone', endpoint: 'rtsp://192.168.0.10/live' }
  ]);
  assert.throws(() => normalizeDevices([{ type: 'camera', endpoint: 'rtsp://user:pass@host/live' }]), DeviceError);
  assert.throws(() => normalizeDevices([{ type: 'camera', endpoint: 'rtsp://host/live?token=abc' }]), DeviceError);
  assert.throws(() => normalizeDevices([{ type: 'camera', endpoint: '192.168.0.10' }]), /必须带协议前缀/);
  assert.throws(() => normalizeDevices([{ type: 'bad type!' }]), DeviceError);
  assert.throws(() => normalizeDevices([{ id: 'dup', type: 'camera' }, { id: 'dup', type: 'speaker' }]), /重复 id/);
  assert.throws(() => normalizeDevices('camera'), /必须是数组/);
});

test('assertCredentialFree walks nested structures', () => {
  assert.throws(() => assertCredentialFree({ devices: [{ type: 'camera', token: 'x' }] }), /不允许出现在部署清单里/);
  assert.doesNotThrow(() => assertCredentialFree({ devices: [{ type: 'camera', endpoint: 'rtsp://host' }] }));
});

test('provision posts the manifest and echoes the local skill plan', async () => {
  let seen;
  const gateway = fakeGateway((path, options) => {
    seen = { path, body: JSON.parse(options.body) };
    return { ok: true, profile: 'buddy', missing_skills: [] };
  });
  const result = await provision({ gateway, product: 'buddy', deployment: 'windows', registry });
  assert.equal(seen.path, '/api/provisioning/products');
  assert.equal(seen.body.product, 'buddy');
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.skills, ['hermes-buddy-desktop']);
  assert.deepEqual(result.warnings, []);
});

test('provision warns about device types with no server-side skill', async () => {
  const gateway = fakeGateway(() => ({ ok: true }));
  const result = await provision({ gateway, product: 'home', deployment: 'hybrid', devices: [{ type: 'toaster' }] });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /toaster/);
});

test('provision refuses to continue when the local registry cannot cover the product', async () => {
  const gateway = fakeGateway(() => ({ ok: true }));
  // home 需要 home-control，registry 目前只有 voice/vision 清单。
  await assert.rejects(() => provision({ gateway, product: 'home', deployment: 'server', registry }), /未覆盖: home-control/);
});

test('provisioning status degrades gracefully on older gateways', async () => {
  const missing = Object.assign(new Error('nope'), { code: 'not_found', status: 404 });
  const gateway = fakeGateway(() => { throw missing; });
  assert.deepEqual(await fetchProvisioningStatus(gateway), { configured: false, reason: '服务端未提供 provisioning 状态端点' });

  const ok = fakeGateway(() => ({ product: 'buddy', deployment: 'windows' }));
  assert.deepEqual(await fetchProvisioningStatus(ok), { configured: true, product: 'buddy', deployment: 'windows' });
});

test('management url keeps the host and swaps the port', () => {
  assert.equal(deriveManagementUrl('http://192.168.0.246:22124'), 'http://192.168.0.246:8700');
  assert.equal(deriveManagementUrl('https://hermes.example', 9800), 'https://hermes.example:9800');
});

test('provision requires a gateway client', async () => {
  await assert.rejects(() => provision({ product: 'buddy', deployment: 'windows' }), /缺少 Gateway 客户端/);
});
