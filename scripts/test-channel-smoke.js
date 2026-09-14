'use strict';

/**
 * WS 工具通道端到端冒烟测试。
 *
 * 启动 hermes-buddy-channel（mock LLM 模式 + 强制鉴权），用真实的 Buddy 客户端
 * （channel.js + ToolRegistry + CommandGuard）跑一遍，验证：
 *   1) echo 命令在本地执行并把输出回传给服务端；
 *   2) format c: 被命令护栏硬拦截，客户端发 tool_rejected，服务端回灌模型；
 *   3) 任务以 task_done 结束。
 *
 * 不依赖真实模型、不需要 Windows（护栏检查在执行前发生，纯字符串逻辑）。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'apps', 'hermes-buddy-desktop', 'src');
const CHANNEL_PY = path.join(ROOT, 'packages', 'hermes-buddy-channel', 'buddy-channel.py');

const PORT = 8833;
const TOKEN = 'test-key-123';
const BASE = `http://127.0.0.1:${PORT}`;

function pickPython() {
  const candidates = [
    'C:\\Users\\chens\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe',
    process.env.BUDDY_PYTHON,
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch (_) { /* 下一个 */ }
  }
  return null;
}

function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE}/health`, (res) => {
        if (res.statusCode === 200) { res.resume(); return resolve(true); }
        res.resume();
        if (Date.now() > deadline) return reject(new Error('health 超时'));
        setTimeout(tick, 200);
      });
      req.on('error', () => { if (Date.now() > deadline) return reject(new Error('health 超时')); setTimeout(tick, 200); });
    };
    tick();
  });
}

async function main() {
  const PY = pickPython();
  if (!PY) { console.error('FAIL: 找不到可用的 python'); process.exit(2); }
  if (!fs.existsSync(CHANNEL_PY)) { console.error('FAIL: 找不到', CHANNEL_PY); process.exit(2); }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-channel-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ws-'));
  const logFile = path.join(tempHome, 'channel.log');

  const srv = spawn(PY, [CHANNEL_PY], {
    env: {
      ...process.env,
      HERMES_HOME: tempHome,
      BUDDY_CHANNEL_MOCK_LLM: '1',
      BUDDY_CHANNEL_PORT: String(PORT),
      BUDDY_CHANNEL_HOST: '127.0.0.1',
      API_SERVER_KEY: TOKEN,
    },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'w')],
  });

  const cleanup = () => { try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {} try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch (_) {} };

  let failed = false;
  try {
    await waitHealth(15000);
  } catch (e) {
    console.error('FAIL: 服务端未就绪 -', e.message);
    try { console.error(fs.readFileSync(logFile, 'utf8')); } catch (_) {}
    cleanup();
    process.exit(1);
  }

  // 真实客户端依赖
  const { Workspace } = require(path.join(SRC, 'workspace'));
  const { ToolRegistry } = require(path.join(SRC, 'tools'));
  const { ChannelClient } = require(path.join(SRC, 'agent', 'channel'));

  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const workspace = new Workspace({ root: workspaceDir, logger });
  workspace.ensure();
  const tools = new ToolRegistry({ workspace, logger, permission: 'read-write' });

  const events = [];
  const client = new ChannelClient({
    url: `ws://127.0.0.1:${PORT}/api/buddy/channel?token=${TOKEN}`,
    token: TOKEN,
    tools,
    logger,
    emit: (e) => events.push(e),
    autoConfirm: true,
  });

  let result;
  try {
    result = await client.sendMessage('请帮我验证通道');
  } catch (e) {
    console.error('FAIL: 运行出错 -', e.message);
    failed = true;
  }
  client.close();

  const echoResult = events.find((e) => e.type === 'tool_result' && e.text && /channel-ok/.test(e.text));
  const blockedResult = events.find((e) => e.type === 'tool_result' && e.blocked);
  const done = events.find((e) => e.type === 'done');

  console.log('--- 事件摘要 ---');
  for (const e of events) {
    if (e.type === 'tool_result') console.log(`  tool_result name=${e.name} blocked=${!!e.blocked} ok=${e.ok}`);
    if (e.type === 'text') console.log(`  text: ${(e.text || '').slice(0, 60)}`);
    if (e.type === 'done') console.log(`  done turns=${e.turns} stopped=${e.stopped}`);
    if (e.type === 'error') console.log(`  error: ${e.message}`);
  }

  const checks = [
    ['echo 命令在本地执行并回传 channel-ok', Boolean(echoResult)],
    ['format c: 被命令护栏拦截 (blocked)', Boolean(blockedResult)],
    ['收到 task_done 收尾', Boolean(done)],
    ['最终答复非空', Boolean(result && result.text)],
  ];
  console.log('--- 断言 ---');
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    if (!ok) failed = true;
  }

  cleanup();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
