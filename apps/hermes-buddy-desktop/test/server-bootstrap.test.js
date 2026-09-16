'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('generateBootstrapScript: includes Hermes 本体安装状态检查', () => {
  const out = generateBootstrapScript({ host: 'h', llmPort: 8800 });
  assert.ok(out.includes('Hermes 本体检查'), '应包含 Hermes 本体检查段落');
  assert.ok(out.includes('config.yaml'), '应检查 config.yaml 是否存在');
  assert.ok(out.includes(':22122'), '应检查 Gateway 22122 端口监听');
  assert.ok(out.includes('HERMES_HOME/venv/bin/hermes'), '应识别隔离 venv 安装的 hermes');
});

test('deploy.sh: 完整部署会安装 Hermes 本体（隔离 venv，不污染系统 Python）', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'deploy.sh'), 'utf-8');
  assert.ok(sh.includes('install_hermes'), '应有 install_hermes 函数');
  assert.ok(sh.includes('INSTALL_HERMES'), '应由 INSTALL_HERMES 门控（仅完整部署触发）');
  assert.ok(sh.includes('ensure_python_uv'), '应引导 Python/uv 环境（针对干净 Ubuntu）');
  assert.ok(sh.includes('hermes-agent'), '应安装 hermes-agent 包');
  assert.ok(sh.includes('hermes-gateway.service'), '应注册 hermes-gateway 服务');
  assert.ok(sh.includes('HERMES_VENV="$HERMES_HOME/venv"'), '应使用隔离 venv');
  // 推理机（CUDA/PyTorch）不能被动系统 Python，禁止 --break-system-packages
  assert.ok(!sh.includes('--break-system-packages'), '不应使用 --break-system-packages');
});