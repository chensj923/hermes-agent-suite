'use strict';

/** 列出草稿箱/素材，只读，用于验证发布结果。输出写文件避免 shell 吞输出。 */
const fs = require('fs');
const https = require('https');

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_APPSECRET || '';

function req(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = Object.assign({ 'User-Agent': 'hermes-buddy' }, headers);
    // 微信 API 不接受 chunked 传输：POST 必须显式给 Content-Length，否则返回空 body
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const r = https.request({
      host: u.host, path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function json(url, opts) {
  const raw = await req(url, opts);
  let j;
  try { j = JSON.parse(raw); } catch (_) { throw new Error('非 JSON: ' + raw.slice(0, 300)); }
  if (j.errcode) {
    const hint = j.errcode === 40164 ? 'IP 不在白名单' : '';
    throw new Error(`微信错误 ${j.errcode}: ${j.errmsg} ${hint}`);
  }
  return j;
}

(async () => {
  const out = [];
  const tok = await json(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  const token = tok.access_token;
  out.push('token ok');
  const list = await json(`https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${token}`, {
    method: 'POST',
    body: Buffer.from(JSON.stringify({ offset: 0, count: 20, no_content: 1 })),
    headers: { 'Content-Type': 'application/json' },
  });
  out.push('total_count=' + list.total_count + ' item_count=' + list.item_count);
  for (const it of list.item || []) {
    const n = it.content && it.content.news_item ? it.content.news_item[0] : {};
    out.push(`- media_id=${it.media_id} | update=${new Date(it.update_time * 1000).toLocaleString('zh-CN')} | title=${n.title || ''}`);
  }
  fs.writeFileSync(process.argv[2] || 'list_drafts.out.txt', out.join('\n') + '\n', 'utf-8');
})().catch((e) => {
  fs.writeFileSync(process.argv[2] || 'list_drafts.out.txt', 'FAIL: ' + e.message + '\n', 'utf-8');
});
