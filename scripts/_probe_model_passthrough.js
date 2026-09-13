// 测试：指定真实模型名（ark-code-latest）能否绕过 agent 注入，拿到原生 function calling
const http = require('http');
const HOST = process.argv[2] || '192.168.0.231';
const KEY = process.argv[3] || '';

function post(path, body, timeout = 45000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request(
      {
        host: HOST, port: 22122, path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + KEY,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout,
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: 'TIMEOUT' }); });
    r.write(data);
    r.end();
  });
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

async function trial(label, body) {
  const r = await post('/v1/chat/completions', body);
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (_) {}
  let msg = null, usage = null;
  if (parsed && parsed.choices && parsed.choices[0]) {
    msg = parsed.choices[0].message;
    usage = parsed.usage;
  }
  console.log(`\n=== ${label} ===`);
  console.log('status: ' + r.status);
  if (!parsed) { console.log('raw: ' + r.body.slice(0, 600)); return; }
  console.log('prompt_tokens : ' + (usage ? usage.prompt_tokens : '?'));
  console.log('tool_calls    : ' + (msg && msg.tool_calls ? JSON.stringify(msg.tool_calls).slice(0, 400) : 'null'));
  console.log('content       : ' + JSON.stringify(msg ? msg.content : null).slice(0, 300));
}

(async () => {
  await trial('A: model=ark-code-latest + tools(required)', {
    model: 'ark-code-latest',
    messages: [{ role: 'user', content: 'List files in /root using the run_command tool.' }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 200,
  });

  await trial('B: model=hermes-agent + tools(required) 对照组', {
    model: 'hermes-agent',
    messages: [{ role: 'user', content: 'List files in /root using the run_command tool.' }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 200,
  });
})();
