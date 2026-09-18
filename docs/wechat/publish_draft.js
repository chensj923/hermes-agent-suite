'use strict';

/**
 * 微信公众号草稿发布：取 token → 上传封面 → 新建草稿 → 拉回校验。
 * 凭据一律从环境变量读（WX_APPID / WX_APPSECRET），绝不硬编码。
 *
 * 用法：node publish_draft.js <正文HTML> <封面PNG> <标题> <摘要> <作者>
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_APPSECRET || '';
if (!APPID || !SECRET) {
  console.error('缺少环境变量 WX_APPID / WX_APPSECRET');
  process.exit(1);
}

const [contentFile, coverFile, title, digest, author] = process.argv.slice(2);
if (!contentFile || !coverFile || !title) {
  console.error('用法: node publish_draft.js <正文.html> <封面.png> <标题> [摘要] [作者]');
  process.exit(1);
}

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
  try { j = JSON.parse(raw); } catch (_) { throw new Error('非 JSON 响应: ' + raw.slice(0, 200)); }
  if (j.errcode) {
    const hint = j.errcode === 40164
      ? '调用 IP 不在白名单 → 公众号后台「开发 → 基本配置 → IP白名单」加本机公网 IP'
      : '';
    throw new Error(`微信错误 ${j.errcode}: ${j.errmsg}${hint ? ' | ' + hint : ''}`);
  }
  return j;
}

function multipart(fileBuf, filename, field = 'media') {
  const boundary = '----HermesBoundary' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, fileBuf, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

(async () => {
  // 1) access_token
  const tok = await json(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`
  );
  const token = tok.access_token;
  console.log('token ok, expires_in=' + tok.expires_in);

  // 2) 上传封面（永久素材，draft 强制要 thumb_media_id）
  const coverBuf = fs.readFileSync(coverFile);
  const mp = multipart(coverBuf, path.basename(coverFile));
  const mat = await json(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
    { method: 'POST', body: mp.body, headers: { 'Content-Type': mp.contentType } }
  );
  const thumb = mat.media_id;
  console.log('cover uploaded, media_id=' + thumb);

  // 3) 新建草稿
  const content = fs.readFileSync(contentFile, 'utf-8');
  const article = {
    title,
    author: author || '',
    digest: digest || '',
    content,
    content_source_url: '',
    thumb_media_id: thumb,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
  const draft = await json(
    `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
    {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ articles: [article] })),
      headers: { 'Content-Type': 'application/json' },
    }
  );
  console.log('draft created, media_id=' + draft.media_id);

  // 4) 拉回校验
  const got = await json(
    `https://api.weixin.qq.com/cgi-bin/draft/get?access_token=${token}`,
    { method: 'POST', body: Buffer.from(JSON.stringify({ media_id: draft.media_id })), headers: { 'Content-Type': 'application/json' } }
  );
  const item = got.news_item[0];
  console.log('--- 校验 ---');
  console.log('title  :', item.title);
  console.log('content len:', item.content.length, '(源文件', content.length, ')');
  console.log('thumb  :', item.thumb_media_id === thumb ? '一致' : '不一致!');
  console.log('media_id:', draft.media_id);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
