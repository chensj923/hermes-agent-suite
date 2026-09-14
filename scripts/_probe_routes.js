// 扫 192.168.0.231:22122 的完整路由表，找出是否存在「非 agent 的纯推理端点」
const HOST = process.argv[2] || '192.168.0.231';
const KEY = process.argv[3] || '';
const BASE = `http://${HOST}:22122`;

const PATHS = [
  // 文档 / schema
  '/openapi.json', '/api/openapi.json', '/docs', '/api/docs', '/redoc', '/swagger.json',
  '/api/swagger.json', '/.well-known/openapi',
  // OpenAI 兼容
  '/v1/models', '/v1/responses', '/v1/completions', '/v1/chat/completions', '/v1/embeddings',
  '/v1/messages', '/v1/messages/count_tokens',
  // 可能的 Hermes 自有推理接口
  '/api/inference', '/api/llm', '/api/chat', '/api/completions', '/api/complete',
  '/api/proxy', '/api/passthrough', '/api/raw', '/api/models', '/api/providers',
  '/api/v1/models', '/api/v1/chat/completions',
  // 健康检查
  '/health', '/api/health', '/status', '/api/status', '/api/sessions', '/api/config',
  '/api/version', '/api/info',
];

async function probeGet(p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(BASE + p, {
      method: 'GET',
      headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
      signal: ctrl.signal,
    });
    const text = await res.text();
    clearTimeout(t);
    return { p, status: res.status, len: text.length, head: text.slice(0, 160).replace(/\s+/g, ' ') };
  } catch (e) {
    clearTimeout(t);
    return { p, status: 'ERR', len: 0, head: e.message };
  }
}

(async () => {
  console.log(`=== GET 路径扫描 ${BASE} ===`);
  const results = [];
  for (const p of PATHS) results.push(await probeGet(p));
  for (const r of results) {
    const mark = r.status === 200 ? '  <== 200' : '';
    console.log(`${String(r.status).padEnd(5)} ${String(r.len).padEnd(8)} ${r.p}${mark}`);
  }

  // 对返回 200 且看起来是 schema 的，直接 dump
  const schema = results.find((r) => r.status === 200 && /openapi|swagger/i.test(r.p));
  if (schema) {
    console.log(`\n=== ${schema.p} 内容 ===`);
    const res = await fetch(BASE + schema.p, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      console.log('title:', j.info && j.info.title, j.info && j.info.version);
      console.log('paths:');
      Object.keys(j.paths || {}).forEach((k) => {
        console.log('  ', k, Object.keys(j.paths[k]).join(','));
      });
    } catch (e) {
      console.log(text.slice(0, 4000));
    }
  }

  // 重点：POST /v1/responses 是否透传 tools（不被 agent 接管）
  console.log('\n=== POST /v1/responses 透传测试 ===');
  for (const path of ['/v1/responses', '/api/v1/chat/completions']) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const body = {
        model: 'hermes-agent',
        input: 'Reply with the single word: OK',
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'probe_tool',
              description: 'probe',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ],
        tool_choice: 'required',
      };
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      clearTimeout(t);
      let j = null;
      try { j = JSON.parse(text); } catch (_) {}
      console.log(`${path} -> HTTP ${res.status}`);
      if (j) {
        console.log('  usage:', JSON.stringify(j.usage));
        const hasFC = JSON.stringify(j).includes('probe_tool');
        console.log('  tool_calls 出现 probe_tool:', hasFC);
        console.log('  top keys:', Object.keys(j).join(','));
        console.log('  text:', JSON.stringify(j).slice(0, 600));
      } else {
        console.log('  raw:', text.slice(0, 400));
      }
    } catch (e) {
      clearTimeout(t);
      console.log(`${path} -> ERR ${e.message}`);
    }
  }
})();
