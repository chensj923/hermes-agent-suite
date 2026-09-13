'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateBootstrapScript, clampPort } = require('../src/server-bootstrap');

test('clampPort: defaults on garbage', () => {
  assert.equal(clampPort('', 8800), 8800);
  assert.equal(clampPort('abc', 8800), 8800);
  assert.equal(clampPort(0, 8800), 8800);
  assert.equal(clampPort(-5, 8800), 8800);
  assert.equal(clampPort(99999, 8800), 8800);
});

test('clampPort: keeps valid integers', () => {
  assert.equal(clampPort(8800, 22122), 8800);
  assert.equal(clampPort('22122', 8800), 22122);
});

test('generateBootstrapScript: emits a bash header', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8800 });
  assert.match(out, /^#!\/usr\/bin\/env bash/);
  assert.ok(out.includes('set -euo pipefail'));
  // v2.3.8：脚本第 4 步 = 探测/启动 hermes proxy 纯推理端点（默认 8800）
  assert.ok(out.includes('hermes proxy'));
  assert.ok(out.includes('probe_stateless'));
  assert.ok(out.includes('8800'));
  // Gateway 重启绝不带 --host（v2.3.7 教训）
  assert.ok(!/gateway run --host/.test(out));
});

test('generateBootstrapScript: skips gateway block when port is 0', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8800, gatewayPort: 0 });
  // gatewayPort=0 时不应出现“预期 Gateway 端口”提示
  assert.ok(!out.includes('预期 Gateway 端口'));
  // 但纯推理端点（hermes proxy）探测/启动逻辑仍在
  assert.ok(out.includes('hermes proxy'));
});

test('generateBootstrapScript: includes API key discovery block', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8800 });
  assert.ok(out.includes('.api_server_key'));
  assert.ok(out.includes('data/.env'));
});

test('generateBootstrapScript: sanitizes host', () => {
  const out = generateBootstrapScript({ host: "evil;rm -rf /" });
  assert.ok(!out.includes('rm -rf'));
  assert.ok(out.includes('evilrm-rf'));
});