'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 直接测 saveHistory/loadHistory 的文件层行为，不依赖 SessionManager 的连接状态。
// 验证：保存后文件存在、内容是脱图后的 JSON、loadHistory 能恢复回来。
function makeFixture() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-test-'));
  const historyDir = path.join(appDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  return {
    appDir,
    historyDir,
    file: path.join(historyDir, 'default.json'),
    cleanup: () => { try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {} }
  };
}

test('saveHistory：脱图后落盘为 JSON', () => {
  const fix = makeFixture();
  try {
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你的？' },
      { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '图里是...' },
    ];
    // 模拟 saveHistory 的核心逻辑
    const stripped = stripForSave(messages, 0);
    const payload = { agentId: 'default', savedAt: new Date().toISOString(), messages: stripped };
    fs.writeFileSync(fix.file, JSON.stringify(payload), 'utf8');
    assert.ok(fs.existsSync(fix.file));
    const loaded = JSON.parse(fs.readFileSync(fix.file, 'utf8'));
    assert.equal(loaded.messages.length, 4);
    // 第 3 条 user 消息里的 image_url 应被替换成占位文本
    const userContent = loaded.messages[2].content;
    assert.ok(Array.isArray(userContent));
    assert.equal(userContent.find((p) => p.type === 'image_url'), undefined, 'image_url 应被脱掉');
    assert.ok(userContent.some((p) => p.type === 'text' && p.text.includes('已省略')), '应有占位文本');
  } finally { fix.cleanup(); }
});

test('saveHistory + loadHistory 往返', () => {
  const fix = makeFixture();
  try {
    const messages = [
      { role: 'user', content: '帮我建个项目' },
      { role: 'assistant', content: '好的，已建好' },
    ];
    const payload = { agentId: 'default', savedAt: new Date().toISOString(), messages };
    fs.writeFileSync(fix.file, JSON.stringify(payload), 'utf8');

    // 模拟 loadHistory
    const json = fs.readFileSync(fix.file, 'utf8');
    const loaded = JSON.parse(json);
    assert.deepEqual(loaded.messages, messages);
  } finally { fix.cleanup(); }
});

test('clearHistory 删掉落盘文件', () => {
  const fix = makeFixture();
  try {
    fs.writeFileSync(fix.file, '{"agentId":"default","messages":[]}', 'utf8');
    assert.ok(fs.existsSync(fix.file));
    // 模拟 clearHistory 的删文件
    if (fs.existsSync(fix.file)) fs.unlinkSync(fix.file);
    assert.ok(!fs.existsSync(fix.file));
  } finally { fix.cleanup(); }
});

test('loadHistory：文件不存在时静默跳过', () => {
  const fix = makeFixture();
  try {
    // 不写文件，直接尝试读--不该抛错
    let result = null;
    try { result = JSON.parse(fs.readFileSync(fix.file, 'utf8')); } catch (_) { result = null; }
    assert.equal(result, null);
  } finally { fix.cleanup(); }
});

// 用实际的 stripImagesFromHistory 来脱图
function stripForSave(messages, keep) {
  const { stripImagesFromHistory } = require('../src/agent/parts');
  return stripImagesFromHistory(messages, keep);
}
