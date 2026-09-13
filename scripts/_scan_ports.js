// 端口扫描：找出服务端上可能存在的纯推理端点
const net = require('net');
const http = require('http');

const HOST = process.argv[2] || '192.168.0.231';
const PORTS = [
  22121, 22122, 22123, 22124, 22125,
  3000, 4000, 5000, 7000, 8000, 8001, 8080, 8081, 8100, 8200, 8645, 8700, 8800, 8888, 9000,
  11434, 1234, 6006, 7860, 5001, 6000, 6666,
];

function tcpOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: HOST, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

function probeHttp(port, path, timeout = 4000) {
  return new Promise((resolve) => {
    const r = http.request({ host: HOST, port, path, method: 'GET', timeout }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve(res.statusCode + ' ' + out.replace(/\s+/g, ' ').slice(0, 260)));
    });
    r.on('error', (e) => resolve('ERR ' + e.message));
    r.on('timeout', () => { r.destroy(); resolve('TIMEOUT'); });
    r.end();
  });
}

(async () => {
  const open = [];
  for (const p of PORTS) {
    if (await tcpOpen(p)) open.push(p);
  }
  console.log('开放端口: ' + (open.join(', ') || '(无)'));
  for (const p of open) {
    const h = await probeHttp(p, '/health');
    const m = await probeHttp(p, '/v1/models');
    console.log(`\n--- ${p} ---`);
    console.log('  /health   : ' + h);
    console.log('  /v1/models: ' + m);
  }
})();
