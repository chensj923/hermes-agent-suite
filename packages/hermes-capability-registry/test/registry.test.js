const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities, validateCapability, capabilitiesForDeployment, resolveRequirements, CapabilityError } = require('../src');

test('ships valid manifests for both shipped products', () => {
  const ids = loadCapabilities().map((capability) => capability.id);
  assert.ok(ids.includes('home-base'));
  assert.ok(ids.includes('buddy-desktop'));
});

test('rejects malformed manifests early', () => {
  assert.throws(() => validateCapability({ id: 'Bad Id', deployment: ['windows'] }), CapabilityError);
  assert.throws(() => validateCapability({ id: 'x-1', deployment: [] }), CapabilityError);
  assert.throws(() => validateCapability({ id: 'x-1', deployment: ['toaster'] }), CapabilityError);
  assert.throws(() => validateCapability({ id: 'x-1', requires: ['telepathy'], deployment: ['windows'] }), CapabilityError);
  assert.throws(() => validateCapability({ id: 'x-1', skills: 'hermes', deployment: ['windows'] }), CapabilityError);
});

test('filters manifests by deployment location', () => {
  const windows = capabilitiesForDeployment('windows').map((capability) => capability.id);
  const server = capabilitiesForDeployment('server').map((capability) => capability.id);
  assert.ok(windows.includes('buddy-desktop'));
  assert.ok(!server.includes('buddy-desktop'));
  assert.ok(server.includes('home-base'));
  assert.throws(() => capabilitiesForDeployment('phone'), CapabilityError);
});

test('resolves skills for a product and reports uncovered requirements', () => {
  const buddy = resolveRequirements(['chat', 'desktop-tools'], 'windows');
  assert.deepEqual(buddy.skills, ['hermes-buddy-desktop']);
  assert.deepEqual(buddy.missing, []);

  // server 部署下没有桌面工具清单，缺口必须显式暴露给安装向导。
  const onServer = resolveRequirements(['desktop-tools'], 'server');
  assert.deepEqual(onServer.skills, []);
  assert.deepEqual(onServer.missing, ['desktop-tools']);

  const home = resolveRequirements(['voice', 'vision', 'home-control'], 'hybrid');
  assert.deepEqual(home.skills, ['hermes-home-manager']);
  assert.deepEqual(home.missing, ['home-control']);
});
