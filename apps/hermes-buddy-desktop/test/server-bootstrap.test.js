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
  // v2.3.10：脚本第 4 步 = 在 Hermes 本机部署「推理直通代理」（8811），
  // 复用 Hermes 自己配好的上游并原样透传 tools；Buddy 只认 Hermes 一个地址。
  assert.ok(out.includes('buddy-inference-proxy.py'));
  assert.ok(out.includes('8811'));
  assert.ok(out.includes('BUDDY_UPSTREAM_BASE'));
  assert.ok(out.includes('systemd'));
  assert.ok(!out.includes('hermes proxy run')); // run 不是合法子命令（v2.3.8 教训）
  assert.ok(out.includes('SHOW_KEYS')); // 密钥默认打码，便于把输出贴出来求助
  // Gateway 重启绝不带 --host（v2.3.7 教训）
  assert.ok(!/gateway run --host/.test(out));
});

test('generateBootstrapScript: 直通代理是零依赖 Python，且开机自启', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8811 });
  assert.ok(out.includes('hermes-buddy-inference.service'));
  assert.ok(out.includes('systemctl enable --now'));
  assert.ok(out.includes('ThreadingHTTPServer')); // 只用标准库
  assert.ok(out.includes('原样透传') || out.includes('tools'));
  // 上游密钥只落在服务端，不能出现在 Buddy 侧
  assert.ok(out.includes('BUDDY_UPSTREAM_KEY'));
});

test('generateBootstrapScript: skips gateway block when port is 0', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8800, gatewayPort: 0 });
  // gatewayPort=0 时不应出现“预期 Gateway 端口”提示
  assert.ok(!out.includes('预期 Gateway 端口'));
  // 但推理直通代理的部署逻辑仍在
  assert.ok(out.includes('buddy-inference-proxy.py'));
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