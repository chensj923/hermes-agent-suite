'use strict';

/**
 * 通道「模型清单透传」端到端冒烟。
 *
 * 起一个假上游（/v1/models + /v1/chat/completions）+ 本地 buddy-channel.py，
 * 再用真实的 ChannelClient 连上去，验证两件事：
 *   1. listModels() 能拿到上游 /models 的真实模型清单（而不是默认那一个）；
 *   2. sendMessage({model}) 能把选中的模型透传给服务端，服务端确实用它去请求上游。
 *
 * 用法：node scripts/test-channel-models-smoke.js
 * 需要 python：可用 PYTHON_BIN 环境变量指定解释器（Windows 上默认是 python）。
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ChannelClient } = require('../apps/hermes-buddy-desktop/src/agent/channel');

const UPSTREAM_PORT = Number(process.env.SMOKE_UPSTREAM_PORT || 18799);
const CHANNEL_PORT = Number(process.env.SMOKE_CHANNEL_PORT || 18899);
const TOKEN = 'smoke-token';
const PYTHON = process.env.PYTHON_BIN || 'python';
const CHANNEL_PY = path.join(__dirname, '..', 'packages', 'hermes-buddy-channel', 'buddy-channel.py');

const seen = { modelRequests: [], lastChatModel: null };
let failures = 0;
let childStderr = [];   // 通道进程 stderr，失败时打印，避免盲调

function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`);
  }
}

// ------------------------------------------------------------------ 假上游
const upstream = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/v1/models') {
    seen.modelRequests.push(url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] }));
    return;
  }
  if (url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) {}
      seen.lastChatModel = parsed.model || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hello from ' + (parsed.model || '?') } }] }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

function waitForChannel(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port: CHANNEL_PORT, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('通道服务在超时内没有起来'));
        else setTimeout(probe, 300);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    probe();
  });
}

/**
 * 旧服务端（welcome 不带 channel_version，等同 1.0）必须被拒绝：
 * 客户端要直接断开并提示重新部署，而不是带着残缺能力继续跑。
 */
async function outdatedServerIsRejected() {
  const { ChannelClient: Client } = require('../apps/hermes-buddy-desktop/src/agent/channel');
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const legacy = http.createServer();
  legacy.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    // 老版本 welcome：只有 version:"1"，没有 channel_version
    socket.on('data', (chunk) => {
      const b = Buffer.from(chunk);
      const len = b[1] & 0x7F;
      const mask = b.slice(2, 6);
      const payload = Buffer.from(b.slice(6, 6 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      try { JSON.parse(payload.toString('utf-8')); } catch (_) { return; }
      const body = Buffer.from(JSON.stringify({ type: 'welcome', session: 'sess-old', model: 'm', version: '1' }));
      try { socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body])); } catch (_) {}
    });
  });
  const port = 18911;
  await new Promise((r) => legacy.listen(port, '127.0.0.1', r));
  const client = new Client({
    url: `ws://127.0.0.1:${port}/api/buddy/channel`,
    token: 't',
    tools: { invoke: async () => ({ ok: true, text: '' }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    emit: () => {},
  });
  let rejected = null;
  try {
    await client.connect();
  } catch (error) {
    rejected = error;
  }
  try { client.close(); } catch (_) {}
  legacy.close();

  check('旧服务端被拒绝（不会静默连上）', !!rejected, rejected ? '' : 'connect() 竟然成功了');
  check('错误码是 channel_outdated', rejected && rejected.code === 'channel_outdated', rejected && String(rejected.code));
  check('提示里明确要求重新部署', !!rejected && /重新部署|deploy\.sh/.test(rejected.message), rejected && rejected.message);
  check('通道确已断开', client.closed === true || client.connected === false);
}

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
  console.log(`假上游已启动: http://127.0.0.1:${UPSTREAM_PORT}/v1`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-smoke-'));
  const child = spawn(PYTHON, [CHANNEL_PY], {
    env: {
      ...process.env,
      BUDDY_CHANNEL_PORT: String(CHANNEL_PORT),
      BUDDY_CHANNEL_KEY: TOKEN,
      BUDDY_UPSTREAM_BASE: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      BUDDY_UPSTREAM_KEY: 'upstream-key',
      BUDDY_UPSTREAM_MODEL: 'model-a',
      HERMES_HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childStderr = [];
  const stderrBuf = childStderr;
  child.stderr.on('data', (d) => stderrBuf.push(d.toString()));
  child.stdout.resume();

  try {
    await waitForChannel(15000);
    console.log(`通道服务已启动: ws://127.0.0.1:${CHANNEL_PORT}`);

    const client = new ChannelClient({
      url: `ws://127.0.0.1:${CHANNEL_PORT}/api/buddy/channel`,
      token: TOKEN,
      tools: { invoke: async () => ({ ok: true, text: 'ok' }) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      emit: () => {},
    });
    await client.connect();

    // 1) 模型清单透传
    const models = await client.listModels();
    console.log(`listModels() => ${JSON.stringify(models)}`);
    check('拿到上游真实模型清单', Array.isArray(models) && models.length === 3, JSON.stringify(models));
    check('清单包含 model-c', models.includes('model-c'), JSON.stringify(models));
    check('默认模型排在最前', models[0] === 'model-a', JSON.stringify(models));
    check('确实请求了上游 /v1/models', seen.modelRequests.includes('/v1/models'));

    // 2) 选中的模型要真的发到上游
    const result = await client.sendMessage('你好', [], { model: 'model-c', timeoutMs: 20000 });
    console.log(`sendMessage(model=model-c) => ${JSON.stringify(result && result.text)}`);
    check('服务端用选中的模型请求了上游', seen.lastChatModel === 'model-c', String(seen.lastChatModel));

    client.close();

    // 3) 旧服务端必须被挡下来并提示重新部署
    console.log('\n--- 旧服务端（v1.0，无 channel_version）---');
    await outdatedServerIsRejected();
  } finally {
    child.kill('SIGKILL');
    upstream.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }

  if (failures) {
    console.error(`\n${failures} 项失败。`);
    if (stderrBuf.length) console.error('--- channel stderr ---\n' + stderrBuf.join('').slice(-2000));
    process.exit(1);
  }
  console.log('\n全部通过。');
}

main().catch((error) => {
  console.error('冒烟失败:', error && error.message);
  if (childStderr.length) console.error('--- channel stderr ---\n' + childStderr.join('').slice(-3000));
  process.exit(1);
});
