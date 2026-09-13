// 拉取 22122 的 OpenAPI 定义，确认 api_server 支持的参数
const http = require('http');
const HOST = process.argv[2] || '192.168.0.231';
const KEY = process.argv[3] || '';

function get(path) {
  return new Promise((resolve) => {
    const r = http.request(
      { host: HOST, port: 22122, path, method: 'GET', headers: KEY ? { Authorization: 'Bearer ' + KEY } : {}, timeout: 8000 },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: 'TIMEOUT' }); });
    r.end();
  });
}

(async () => {
  for (const p of ['/openapi.json', '/api/openapi.json', '/docs', '/api/docs', '/api/health', '/v1/health', '/api/sessions', '/api/config']) {
    const r = await get(p);
    console.log(`\n=== ${p} -> ${r.status} ===`);
    console.log(r.body.slice(0, 1200));
  }

  const oa = await get('/openapi.json');
  if (oa.status === 200) {
    try {
      const j = JSON.parse(oa.body);
      console.log('\n\n########## PATHS ##########');
      console.log(Object.keys(j.paths || {}).join('\n'));
      const chat = (j.paths || {})['/v1/chat/completions'];
      if (chat && chat.post && chat.post.requestBody) {
        console.log('\n\n########## /v1/chat/completions requestBody ##########');
        console.log(JSON.stringify(chat.post.requestBody, null, 2).slice(0, 6000));
      }
    } catch (e) {
      console.log('parse fail: ' + e.message);
    }
  }
})();
