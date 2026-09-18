'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { BehaviorDB, EVENT_KEYS } = require('../src/predict/behavior-db');

function makeDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-priv-'));
  const db = new BehaviorDB({ dataDir: path.join(tmp, 'db') });
  return { tmp, db };
}

test('剪贴板事件只存类型与长度，不存内容', () => {
  const { db } = makeDb();
  db.recordEvent({
    type: 'clipboard',
    clipboardType: 'text',
    clipboardLength: 1200,
    content: '这是一段绝不该落盘的敏感文本',
    text: '也别存'
  });
  const events = db.getRecentEvents(10 * 1000);
  assert.strictEqual(events.length, 1);
  const e = events[0];
  assert.strictEqual(e.clipboardType, 'text');
  assert.strictEqual(e.clipboardLength, 1200);
  assert.strictEqual(e.content, undefined);
  assert.strictEqual(e.text, undefined);
});

test('窗口事件剥离 title（隐私）', () => {
  const { db } = makeDb();
  db.recordEvent({ type: 'window_change', windowClass: 'OpusApp', title: '我的绝密合同.docx' });
  const e = db.getRecentEvents(10 * 1000)[0];
  assert.strictEqual(e.windowClass, 'OpusApp');
  assert.strictEqual(e.title, undefined);
});

test('事件文件不包含任何白名单外字段', () => {
  const { tmp, db } = makeDb();
  db.recordEvent({ type: 'keypress', windowClass: 'OpusApp', content: 'secret', title: 't', password: 'x' });
  const raw = fs.readFileSync(path.join(tmp, 'db', 'events.log.jsonl'), 'utf8');
  const parsed = JSON.parse(raw.trim().split('\n')[0]);
  for (const k of Object.keys(parsed)) {
    assert.ok(EVENT_KEYS.has(k) || k === 't', '意外字段: ' + k);
  }
  assert.strictEqual(parsed.content, undefined);
  assert.strictEqual(parsed.password, undefined);
});

test('结晶只存模式不存内容', () => {
  const { db } = makeDb();
  db.recordTrigger('word_writing');
  db.recordDecision('word_writing', true);
  const c = db.getCrystallization();
  assert.strictEqual(c.word_writing.triggers, 1);
  assert.strictEqual(c.word_writing.accepts, 1);
  assert.ok('acceptRate' in c.word_writing);
  assert.strictEqual(c.word_writing.title, undefined);
});

test('7 天 TTL 清理', () => {
  const { db } = makeDb();
  const old = { t: db._now() - 8 * 24 * 60 * 60 * 1000, type: 'keypress', windowClass: 'X' };
  fs.mkdirSync(db.dataDir, { recursive: true });
  fs.appendFileSync(path.join(db.dataDir, 'events.log.jsonl'), JSON.stringify(old) + '\n');
  db.recordEvent({ type: 'keypress', windowClass: 'OpusApp' });
  const removed = db.pruneOld();
  assert.strictEqual(removed, 1);
  const remaining = db.getRecentEvents(10 * 1000);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].windowClass, 'OpusApp');
});
