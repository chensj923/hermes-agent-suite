'use strict';

/**
 * Phase 6 通道 2.0：predict_request / predict_response 帧的端到端单测。
 *
 * 验证：
 * 1. welcome 带 supports_predict=true 时，client.supportsPredict 为 true
 * 2. predict() 发出 predict_request 并在收到 predict_response 后 resolve
 * 3. welcome 不带 supports_predict 时 predict() 抛 channel_no_predict（退化）
 * 4. 断线时 pendingPredict 被 reject
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const { ChannelClient, maskFrame, decodeFrames } = require('../src/agent/channel.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const { REQUIRED_CHANNEL_VERSION, REQUIRED_CHANNEL_BUILD } = require('../src/agent/channel');

/** 发送一个未 mask 的文本帧（服务端->客户端不需要 mask）。 */
function sendRaw(socket, jsonString) {
  const payload = Buffer.from(jsonString, 'utf-8');
  const len = payload.length;
  let header;
  if (len <= 125) header = Buffer.from([0x81, len]);
  else if (len <= 65535) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  socket.write(Buffer.concat([header, payload]));
}

/** 起一个最小 WS 服务端，收到 hello 后回 welcome，之后解析帧调 onMessage。 */
function startMockServer(onMessage) {
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
    let buf = Buffer.alloc(0);
    let helloDone = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf-8')); } catch (_) { continue; }
        if (!helloDone && msg.type === 'hello') {
          helloDone = true;
          sendRaw(socket, JSON.stringify({
            type: 'welcome',
            session: 'sess-predict',
            channel_version: REQUIRED_CHANNEL_VERSION,
            channel_build: REQUIRED_CHANNEL_BUILD,
            supports_resume: true,
            supports_predict: true,
          }));
          continue;
        }
        if (onMessage) onMessage(msg, socket);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 起一个不支持 predict 的旧版服务端（welcome 不带 supports_predict）。 */
function startLegacyServer() {
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
    let buf = Buffer.alloc(0);
    let helloDone = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf-8')); } catch (_) { continue; }
        if (!helloDone && msg.type === 'hello') {
          helloDone = true;
          sendRaw(socket, JSON.stringify({
            type: 'welcome',
            session: 'sess-legacy',
            channel_version: REQUIRED_CHANNEL_VERSION,
            channel_build: REQUIRED_CHANNEL_BUILD,
            supports_resume: true,
            // 没有 supports_predict --模拟 1.x 服务端升级了版本号但没加 predict 能力
          }));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function makeClient(port) {
  return new ChannelClient({
    url: `ws://127.0.0.1:${port}/api/buddy/channel`,
    token: 'test-token',
    tools: { invoke: async () => ({ ok: true, text: 'ok' }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    autoConfirm: true,
  });
}

test('welcome 带 supports_predict -> client.supportsPredict 为 true', async () => {
  const { server, port } = await startMockServer();
  const client = makeClient(port);
  try {
    await client.connect();
    assert.equal(client.supportsPredict, true, 'supportsPredict 应为 true');
  } finally {
    client.close();
    server.close();
  }
});

test('predict() 发出 predict_request 并在收到 predict_response 后 resolve', async () => {
  const { server, port } = await startMockServer((msg, socket) => {
    if (msg.type === 'predict_request') {
      sendRaw(socket, JSON.stringify({
        type: 'predict_response',
        session: msg.session || 'sess-predict',
        intent: 'word_writing',
        confidence: 0.92,
        suggestion: '要不要我帮你续写这段文字？',
        reason: '检测到在 Word 中停顿超过 5 秒',
      }));
    }
  });
  const client = makeClient(port);
  try {
    await client.connect();
    const result = await client.predict(
      { rule: 'word_writing', windowClass: 'Word' },
      'BASE64FAKE'
    );
    assert.equal(result.intent, 'word_writing');
    assert.equal(result.confidence, 0.92);
    assert.ok(result.suggestion && result.suggestion.length > 0);
    assert.ok(result.reason);
  } finally {
    client.close();
    server.close();
  }
});

test('不支持 predict 的服务端 -> predict() 抛 channel_no_predict', async () => {
  const { server, port } = await startLegacyServer();
  const client = makeClient(port);
  try {
    await client.connect();
    assert.equal(client.supportsPredict, false);
    await assert.rejects(
      () => client.predict({ rule: 'word_writing' }, null),
      (err) => {
        assert.equal(err.code, 'channel_no_predict');
        return true;
      }
    );
  } finally {
    client.close();
    server.close();
  }
});

test('断线时 pendingPredict 被 reject', async () => {
  // 起一个不回 predict_response 的服务端
  const { server, port } = await startMockServer(() => {
    // 故意不回 predict_response
  });
  const client = makeClient(port);
  try {
    await client.connect();
    const predictPromise = client.predict({ rule: 'word_writing' }, null);
    // 给一点时间让 predict_request 发出
    setTimeout(() => client.close(), 50);
    await assert.rejects(predictPromise, /断开|超时/);
  } finally {
    try { server.close(); } catch (_) {}
  }
});

test('v4.10.35 并发 predict：响应按 req_id 精确匹配，不互相截胡', async () => {
  // 模拟真实场景：请求1（分析）慢、请求2（生成）快，且请求2的响应晚于请求1到达。
  // 服务端把 req_id 原样带回，并对不同请求延迟不同时间应答。
  const timers = [];
  const { server, port } = await startMockServer((msg, socket) => {
    if (msg.type !== 'predict_request') return;
    const reqId = msg.req_id;
    const isAnalyze = msg.behavior && msg.behavior.stage !== 'generate_content';
    const delay = isAnalyze ? 120 : 40;   // 分析慢、生成快
    timers.push(setTimeout(() => {
      if (msg.behavior.stage === 'generate_content') {
        sendRaw(socket, JSON.stringify({
          type: 'predict_response', req_id: reqId, intent: 'word_writing',
          confidence: 0.9, suggestion: '', reason: '', content: '这是生成的正文内容',
        }));
      } else {
        sendRaw(socket, JSON.stringify({
          type: 'predict_response', req_id: reqId, intent: 'word_writing',
          confidence: 0.9, suggestion: '要不要帮你续写？', reason: '在 Word 中停顿',
        }));
      }
    }, delay));
  });
  const client = makeClient(port);
  try {
    await client.connect();
    // 先发分析请求（不 await），再发生成请求 → 两请求并发在飞
    const analyzeP = client.predict({ rule: 'word_writing' }, null);
    const generateP = client.predict({ rule: 'word_writing', stage: 'generate_content' }, null);
    const [analyze, generated] = await Promise.all([analyzeP, generateP]);
    // 生成请求必须拿到自己的 content，而不是分析请求的意图格式
    assert.equal(generated.content, '这是生成的正文内容', '生成响应必须按 req_id 拿到自己的 content');
    assert.equal(analyze.suggestion, '要不要帮你续写？', '分析响应也必须拿到自己的结果');
    assert.equal(generated.suggestion, '', '生成响应不应串到分析的 suggestion');
  } finally {
    for (const t of timers) clearTimeout(t);
    client.close();
    server.close();
  }
});
