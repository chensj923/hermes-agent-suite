'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const { ChannelClient, maskFrame } = require('../src/agent/channel.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 起一个最小的 WS 服务端：完成 101 握手后立刻下发 welcome。 */
function startMockChannel(onUpgrade) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    if (onUpgrade) onUpgrade(req, socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 用客户端要求的最低版本，别写死——协议一升级测试就假失败
const { REQUIRED_CHANNEL_VERSION } = require('../src/agent/channel');

function sendWelcome(socket, session = 'sess-test') {
  const payload = Buffer.from(JSON.stringify({ type: 'welcome', session, version: REQUIRED_CHANNEL_VERSION }));
  const header = payload.length <= 125
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xFF]);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * 真实服务端是「收到客户端 hello 之后」才回 welcome。
 * mock 必须保持这个时序：101 一响就发的话，客户端还没挂上 data 监听，帧会被丢掉。
 */
function sendWelcomeAfterHello(socket, session = 'sess-test') {
  socket.once('data', () => sendWelcome(socket, session));
}

function makeClient(port) {
  return new ChannelClient({
    url: `ws://127.0.0.1:${port}/api/buddy/channel`,
    token: 'test-token',
    tools: { invoke: async () => ({ ok: true, text: 'ok' }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    autoConfirm: true
  });
}

test('构造 WS 帧：mask 位与长度编码正确', () => {
  const small = maskFrame(0x1, 'hi');
  assert.equal(small[0], 0x81);
  assert.equal(small[1] & 0x80, 0x80, '客户端帧必须带 mask 位');
  assert.equal(small[1] & 0x7F, 2);

  const big = maskFrame(0x1, 'x'.repeat(300));
  assert.equal(big[1] & 0x7F, 126, '300 字节应走 16 位长度');
  assert.equal(big.readUInt16BE(2), 300);
});

test('connect() 在握手+welcome 后 resolve 并拿到 sessionId', async () => {
  const { server, port } = await startMockChannel((_req, socket) => sendWelcomeAfterHello(socket, 'sess-abc'));
  const client = makeClient(port);
  try {
    await client.connect();
    assert.equal(client.connected, true);
    assert.equal(client.sessionId, 'sess-abc');
  } finally {
    client.close();
    server.close();
  }
});

test('握手后初始化抛异常时 connect() 必须 reject，不能永久悬挂', async () => {
  // 回归：曾经 _startHeartbeat 未定义，异常抛在 upgrade 事件回调里逃出 Promise，
  // 导致 openPromise 悬挂，表现为"连接超时（20 秒）"而不是真实错误。
  const { server, port } = await startMockChannel(() => {});
  const client = makeClient(port);
  client.send = () => { throw new Error('boom'); };   // 让 upgrade 初始化阶段炸掉
  try {
    await assert.rejects(
      () => client.connect(),
      (error) => {
        assert.match(error.message, /初始化失败|boom/);
        return true;
      }
    );
  } finally {
    client.close();
    server.close();
  }
});

test('服务端拒绝握手（非 101）时 connect() 快速失败', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = makeClient(server.address().port);
  try {
    await assert.rejects(() => client.connect(), /401|拒绝/);
  } finally {
    client.close();
    server.close();
  }
});

test('心跳方法存在且可安全重复启停', async () => {
  const { server, port } = await startMockChannel((_req, socket) => sendWelcomeAfterHello(socket));
  const client = makeClient(port);
  try {
    await client.connect();
    assert.equal(typeof client._startHeartbeat, 'function');
    assert.equal(typeof client._stopHeartbeat, 'function');
    client._startHeartbeat();
    client._startHeartbeat();   // 重复调用不应泄漏定时器
    client._stopHeartbeat();
    client._stopHeartbeat();    // 重复停止不应抛错
    assert.equal(client._heartbeat, null);
  } finally {
    client.close();
    server.close();
  }
});
