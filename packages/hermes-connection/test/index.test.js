const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayClient, GatewayError, normalizeGatewayUrl, describeGatewayError } = require('../src');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, headers: new Map(), text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) };
}

function sseResponse(chunks) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: (async function* () { for (const chunk of chunks) yield chunk; })()
  };
}

function client(fetchImpl, extra = {}) {
  return new GatewayClient({ baseUrl: 'https://hermes.example', apiKey: 'key', fetchImpl, ...extra });
}

test('normalizes a bare Hermes host', () => assert.equal(normalizeGatewayUrl('192.168.0.246:22123'), 'http://192.168.0.246:22123'));

test('rejects query strings and non-http schemes in the gateway url', () => {
  assert.throws(() => normalizeGatewayUrl('http://host:1/?token=x'), GatewayError);
  assert.throws(() => normalizeGatewayUrl('ftp://host'), GatewayError);
  assert.throws(() => normalizeGatewayUrl('   '), GatewayError);
});

test('creates Hermes sessions with the required model and bearer key', async () => {
  let received;
  const gateway = client(async (url, options) => {
    received = { url, options };
    return { ok: true, text: async () => '{"id":"session-1"}' };
  });
  const result = await gateway.createSession('buddy');
  assert.equal(result.id, 'session-1');
  assert.equal(received.url, 'https://hermes.example/api/sessions');
  assert.equal(received.options.headers.Authorization, 'Bearer key');
  assert.deepEqual(JSON.parse(received.options.body), { model: 'hermes-agent', profile: 'buddy' });
});

test('health falls back from /health to /api/health', async () => {
  const seen = [];
  const gateway = client(async (url) => {
    seen.push(url);
    if (url.endsWith('/health') && !url.endsWith('/api/health')) return jsonResponse({ detail: 'not found' }, { ok: false, status: 404 });
    return jsonResponse({ status: 'ok' });
  });
  const result = await gateway.health();
  assert.equal(result.endpoint, '/api/health');
  assert.deepEqual(seen, ['https://hermes.example/health', 'https://hermes.example/api/health']);
  // 命中的路径会被记住，后续探测不再重复试错。
  await gateway.health();
  assert.equal(seen.length, 3);
});

test('health surfaces an unauthorized key instead of probing other paths', async () => {
  let calls = 0;
  const gateway = client(async () => { calls += 1; return jsonResponse({ detail: 'invalid key' }, { ok: false, status: 401 }); });
  await assert.rejects(() => gateway.health(), (error) => {
    assert.equal(error.code, 'unauthorized');
    assert.match(describeGatewayError(error), /API Key/);
    return true;
  });
  assert.equal(calls, 1);
});

test('streamChat aggregates text deltas and reports tool progress separately', async () => {
  const gateway = client(async () => sseResponse([
    'data: {"type":"hermes.message.delta","data":{"delta":"你好"}}\n\n',
    'data: {"type":"hermes.tool.progress","data":{"tool":"terminal","status":"running","label":"ls"}}\n\n',
    'data: {"type":"hermes.message.delta","data":{"delta":"，世界"}}\n\ndata: [DONE]\n\n'
  ]));
  const kinds = [];
  const result = await gateway.streamChat('session-1', { message: 'hi', onEvent: (event) => kinds.push(event.kind) });
  assert.equal(result.text, '你好，世界');
  assert.equal(result.streamed, true);
  assert.deepEqual(kinds, ['text', 'tool', 'text', 'done']);
});

test('streamChat handles a non-streaming gateway response', async () => {
  const gateway = client(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{"reply":"一次性回复"}'
  }));
  const result = await gateway.streamChat('session-1', { message: 'hi' });
  assert.equal(result.text, '一次性回复');
  assert.equal(result.streamed, false);
});

test('chat rejects empty messages and illegal session ids', async () => {
  const gateway = client(async () => jsonResponse({}));
  await assert.rejects(() => gateway.chat('session-1', { message: '   ' }), /消息内容不能为空/);
  await assert.rejects(() => gateway.chat('../etc/passwd', { message: 'hi' }), /会话 ID 非法/);
});

test('requests time out with a typed error', async () => {
  const gateway = client((url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }), { timeoutMs: 20 });
  await assert.rejects(() => gateway.health(), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('listModels degrades to hermes-agent when the gateway has no model route', async () => {
  const gateway = client(async () => jsonResponse({ detail: 'nope' }, { ok: false, status: 404 }));
  assert.deepEqual(await gateway.listModels(), ['hermes-agent']);
});

test('listSessions unwraps both array and object payloads', async () => {
  assert.deepEqual(await client(async () => jsonResponse([{ id: 'a' }])).listSessions(), [{ id: 'a' }]);
  assert.deepEqual(await client(async () => jsonResponse({ sessions: [{ id: 'b' }] })).listSessions(), [{ id: 'b' }]);
  assert.deepEqual(await client(async () => jsonResponse({})).listSessions(), []);
});

test('a missing api key is rejected before any request is made', () => {
  assert.throws(() => new GatewayClient({ baseUrl: 'http://h', apiKey: '', fetchImpl: async () => jsonResponse({}) }), /API Key/);
});
