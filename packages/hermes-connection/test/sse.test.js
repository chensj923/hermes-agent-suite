const test = require('node:test');
const assert = require('node:assert/strict');
const { SseParser, parseEventBlock, extractTextDelta, classifyEvent, consumeEventStream } = require('../src/sse');

test('parses events that arrive split across chunks', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"type":"a"'), []);
  const events = parser.push('}\n\ndata: [DONE]\n\n');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].json, { type: 'a' });
  assert.equal(events[1].done, true);
});

test('flush emits a trailing block without a blank line', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"type":"tail"}'), []);
  const [event] = parser.flush();
  assert.deepEqual(event.json, { type: 'tail' });
  assert.deepEqual(parser.flush(), []);
});

test('ignores comments and keeps multi-line data joined', () => {
  assert.equal(parseEventBlock(': heartbeat'), null);
  const event = parseEventBlock('event: chunk\ndata: line-1\ndata: line-2');
  assert.equal(event.event, 'chunk');
  assert.equal(event.raw, 'line-1\nline-2');
  assert.equal(event.json, null);
});

test('extractTextDelta accepts hermes and openai shaped payloads', () => {
  assert.equal(extractTextDelta({ json: { type: 'hermes.message.delta', data: { delta: 'A' } } }), 'A');
  assert.equal(extractTextDelta({ json: { type: 'message', data: { text: 'B' } } }), 'B');
  assert.equal(extractTextDelta({ json: { choices: [{ delta: { content: 'C' } }] } }), 'C');
  assert.equal(extractTextDelta({ json: { content: 'D' }, event: 'message' }), 'D');
});

test('control events never leak into the assistant transcript', () => {
  const tool = { json: { type: 'hermes.tool.progress', data: { tool: 'terminal', status: 'running', label: 'ls' } } };
  const intercept = { json: { type: 'hermes.permission.intercept', data: { reason: '只读模式禁止执行写操作' } } };
  assert.equal(extractTextDelta(tool), '');
  assert.equal(classifyEvent(tool), 'tool');
  assert.equal(classifyEvent(intercept), 'permission');
  assert.equal(classifyEvent({ done: true }), 'done');
});

test('consumeEventStream reads WHATWG streams', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"x"}\n'));
      controller.enqueue(encoder.encode('\ndata: [DONE]\n\n'));
      controller.close();
    }
  });
  const seen = [];
  await consumeEventStream(body, (event) => seen.push(event.done ? 'done' : event.json.type));
  assert.deepEqual(seen, ['x', 'done']);
});

test('consumeEventStream rejects an unusable body', async () => {
  await assert.rejects(() => consumeEventStream(null, () => {}), /没有可读取的流/);
  await assert.rejects(() => consumeEventStream({}, () => {}), /不支持的响应流类型/);
});
