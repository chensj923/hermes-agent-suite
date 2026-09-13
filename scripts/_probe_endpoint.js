// 一次性侦察脚本：摸清 192.168.0.221 上到底有哪些可用端点
const http = require('http');

const HOST = process.argv[2] || '192.168.0.231';
const KEY = process.argv[3] || '';

function req(method, path, body, timeout = 15000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: HOST,
        port: 22122,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(KEY ? { Authorization: 'Bearer ' + KEY } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout,
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out.slice(0, 3000) }));
      }
    );
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('=== /health ===');
  console.log(JSON.stringify(await req('GET', '/health')));

  console.log('\n=== GET /v1/models ===');
  const models = await req('GET', '/v1/models');
  console.log(models.status, models.body.slice(0, 2000));

  console.log('\n=== GET /api/models ===');
  const m2 = await req('GET', '/api/models');
  console.log(m2.status, m2.body.slice(0, 2000));

  console.log('\n=== POST /v1/chat/completions  model=hermes-agent (with tools) ===');
  const toolBody = {
    model: 'hermes-agent',
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    tools: [
      {
        type: 'function',
        function: { name: 'probe_echo', description: 'echo', parameters: { type: 'object', properties: {} } },
      },
    ],
    tool_choice: 'required',
    max_tokens: 50,
  };
  console.log(JSON.stringify(await req('POST', '/v1/chat/completions', toolBody), null, 2).slice(0, 3000));
})();
