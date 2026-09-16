'use strict';
// 一次性探测脚本：列出 whisper.cpp 最新几个 release 的 assets（仅用于选型）
const https = require('https');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, timeout: 20000, rejectUnauthorized: false,
      headers: { 'User-Agent': 'hermes-buddy-probe', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ code: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ code: res.statusCode, raw: body.slice(0, 300) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.end();
  });
}

(async () => {
  for (const repo of ['ggml-org/whisper.cpp', 'ggerganov/whisper.cpp']) {
    try {
      const r = await getJSON(`https://api.github.com/repos/${repo}/releases?per_page=3`);
      if (r.code !== 200) { console.log(`${repo}: HTTP ${r.code}`); continue; }
      for (const rel of r.json) {
        console.log(`\n=== ${repo}  tag=${rel.tag_name}  name=${rel.name || ''}`);
        for (const a of (rel.assets || [])) {
          if (!/win|x64|zip/i.test(a.name)) continue;
          console.log(`   ${a.name}  ${(a.size / 1048576).toFixed(1)}MB  dl=${a.browser_download_url}`);
        }
      }
    } catch (e) {
      console.log(`${repo}: ${e.message}`);
    }
  }
})();
