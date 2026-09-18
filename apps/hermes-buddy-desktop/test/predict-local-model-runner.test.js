'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { LocalModelRunner } = require('../src/predict/local-model-runner');
const { getStatus } = require('../src/predict/llama-engine');

/** 起一个 mock llama-server（只实现 /health 与 /v1/chat/completions）。 */
function startMockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ───────────────────────── _parseResult ─────────────────────────
test('_parseResult 正常 JSON', () => {
  const r = new LocalModelRunner({});
  const out = r._parseResult('{"intent":"word_writing","confidence":0.8,"suggestion":"换种说法","reason":"长文停顿"}', null);
  assert.strictEqual(out.intent, 'word_writing');
  assert.strictEqual(out.confidence, 0.8);
  assert.strictEqual(out.suggestion, '换种说法');
});

test('_parseResult 容忍 ```json 围栏', () => {
  const r = new LocalModelRunner({});
  const raw = '```json\n{"intent":"none","confidence":0.3,"suggestion":""}\n```';
  const out = r._parseResult(raw, {});
  assert.strictEqual(out.intent, 'none');
  assert.strictEqual(out.confidence, 0.3);
});

test('_parseResult 非法内容返回 null', () => {
  const r = new LocalModelRunner({});
  assert.strictEqual(r._parseResult('完全不是 json', {}), null);
  assert.strictEqual(r._parseResult(undefined, {}), null);
});

test('_parseResult 置信度裁剪到 [0,1]', () => {
  const r = new LocalModelRunner({});
  const out = r._parseResult('{"intent":"api_lookup","confidence":2.5}', {});
  assert.strictEqual(out.confidence, 1);
  const out2 = r._parseResult('{"intent":"x","confidence":-1}', {});
  assert.strictEqual(out2.confidence, 0);
});

test('_parseResult 兼容 score / category 字段', () => {
  const r = new LocalModelRunner({});
  const out = r._parseResult('{"category":"data_entry","score":0.7}', {});
  assert.strictEqual(out.intent, 'data_entry');
  assert.strictEqual(out.confidence, 0.7);
});

// ───────────────────────── analyze（HTTP 交互） ─────────────────────────
test('analyze 走 HTTP 并解析结果 + 透传 behaviorContext', async () => {
  const srv = await startMockServer((req, res, body) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    const parsed = JSON.parse(body);
    // 必须含 system + user，user 内含 image_url（因为传了 imageBase64）
    assert.strictEqual(parsed.messages.length, 2);
    assert.ok(parsed.messages[1].content.some((c) => c.type === 'image_url'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"intent":"word_writing","confidence":0.9,"suggestion":"续写","reason":"长文停顿"}' } }],
    }));
  });
  const port = srv.address().port;
  const r = new LocalModelRunner({ host: '127.0.0.1', port });
  r.started = true; // 跳过真实 start（无 llama-server 二进制）
  const ctx = { windowClass: 'OpusApp', typedChars: 40 };
  const out = await r.analyze({ imageBase64: 'iVBORw0KGgo=', behaviorContext: ctx });
  assert.strictEqual(out.intent, 'word_writing');
  assert.strictEqual(out.confidence, 0.9);
  assert.deepStrictEqual(out.behaviorContext, ctx);
  srv.close();
});

test('analyze 无图也能发纯文本请求', async () => {
  const srv = await startMockServer((req, res, body) => {
    const parsed = JSON.parse(body);
    const hasImage = parsed.messages[1].content.some((c) => c.type === 'image_url');
    assert.strictEqual(hasImage, false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"none","confidence":0.2}' } }] }));
  });
  const port = srv.address().port;
  const r = new LocalModelRunner({ host: '127.0.0.1', port });
  r.started = true;
  const out = await r.analyze({ behaviorContext: { windowClass: 'XLMainClient' } });
  assert.strictEqual(out.intent, 'none');
  srv.close();
});

// ───────────────────────── _health / _waitReady / stop ─────────────────────────
test('_health 探测 mock server 返回 true', async () => {
  const srv = await startMockServer((req, res) => {
    if (req.url === '/health') res.writeHead(200), res.end('ok');
    else { res.writeHead(404); res.end(); }
  });
  const r = new LocalModelRunner({ host: '127.0.0.1', port: srv.address().port });
  assert.strictEqual(await r._health(), true);
  srv.close();
});

test('_waitReady 超时后 stop 并抛错', async () => {
  const srv = await startMockServer((req, res) => { res.writeHead(404); res.end(); });
  // 用一个无关长活进程充当 this.proc（_waitReady 只靠端口探活，与 proc 无关）
  const fakeProc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const r = new LocalModelRunner({ host: '127.0.0.1', port: srv.address().port });
  r.proc = fakeProc;
  await assert.rejects(() => r._waitReady(1500));
  await r.stop();
  srv.close();
});

test('stop 能终止子进程', async () => {
  const fakeProc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const r = new LocalModelRunner({});
  r.proc = fakeProc;
  await r.stop();
  await new Promise((res) => setTimeout(res, 150));
  assert.ok(fakeProc.killed || fakeProc.exitCode !== null);
});

// ───────────────────────── llama-engine 查找逻辑（纯 fs） ─────────────────────────
test('llama-engine getStatus 缺引擎时全 false', () => {
  const st = getStatus('/nonexistent-dir-xyz');
  assert.strictEqual(st.llamaServer.ok, false);
  assert.strictEqual(st.mmproj.ok, false);
  assert.strictEqual(st.model.ok, false);
});

test('llama-engine getStatus 找到引擎', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-'));
  fs.mkdirSync(path.join(tmp, 'vlm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'vlm', 'llama-server.exe'), 'x');
  fs.writeFileSync(path.join(tmp, 'vlm', 'mmproj.exe'), 'x');
  fs.writeFileSync(path.join(tmp, 'vlm', 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf'), 'x');
  const st = getStatus(tmp, 'qwen2.5-vl-3b');
  assert.strictEqual(st.llamaServer.ok, true);
  assert.strictEqual(st.mmproj.ok, true);
  assert.strictEqual(st.model.ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
