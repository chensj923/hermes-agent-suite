'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { diagnose, classify, guidanceFor, GUIDANCE } = require('../src/diagnostics');

test('classify: maps HTTP status to a reason', () => {
  assert.equal(classify(200), 'ok');
  assert.equal(classify(204), 'ok');
  assert.equal(classify(401), 'unauthorized');
  assert.equal(classify(403), 'unauthorized');
  assert.equal(classify(404), 'not_found');
  assert.equal(classify(500), 'unreachable');
  assert.equal(classify(0), 'unreachable');
});

test('classify: keeps explicit reason from probe', () => {
  assert.equal(classify(0, 'refused'), 'refused');
  assert.equal(classify(0, 'timeout'), 'timeout');
  assert.equal(classify(0, 'unreachable'), 'unreachable');
});

test('guidanceFor: returns human message for every reason', () => {
  for (const key of Object.keys(GUIDANCE)) {
    const g = guidanceFor(key);
    assert.ok(g.label, `guidance for ${key} has label`);
    assert.ok(g.userMessage, `guidance for ${key} has userMessage`);
  }
});

test('diagnose: critical endpoint refused blocks the result', async () => {
  const fakeFetch = async () => ({ status: 0, reason: 'refused' });
  const result = await diagnose({ llmUrl: 'http://10.0.0.1:8800', fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.equal(result.blocking.key, 'llmUrl');
  assert.equal(result.blocking.reason, 'refused');
  assert.equal(result.blocking.actionHint, 'bootstrap_server');
});

test('diagnose: 401 on llm produces unauthorized with verify_key hint', async () => {
  const fakeFetch = async () => ({ status: 401 });
  const result = await diagnose({ llmUrl: 'http://h:8800', fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.equal(result.blocking.reason, 'unauthorized');
  assert.equal(result.blocking.actionHint, 'verify_key');
});

test('diagnose: optional endpoints do not block', async () => {
  const fakeFetch = async () => ({ status: 0, reason: 'refused' });
  const result = await diagnose({ llmUrl: 'http://h:8800', fetchImpl: async () => ({ status: 200 }) });
  assert.equal(result.ok, true);
  assert.equal(result.blocking, null);
  const gw = result.results.find((r) => r.key === 'gatewayBaseUrl');
  assert.equal(gw.reason, 'no_endpoint');
});

test('diagnose: missing endpoint is reported, not thrown', async () => {
  const result = await diagnose({ llmUrl: 'http://h:8800', fetchImpl: async () => ({ status: 200 }) });
  assert.equal(result.results.length, 3);
  const empty = result.results.filter((r) => !r.value);
  assert.equal(empty.length, 2);
  for (const r of empty) assert.equal(r.reason, 'no_endpoint');
});

test('diagnose: 200 on llm means ok even when gateway is down', async () => {
  const fetchImpl = async (url) => {
    if (url.includes(':8800')) return { status: 200 };
    return { status: 0, reason: 'refused' };
  };
  const result = await diagnose({
    llmUrl: 'http://h:8800',
    gatewayBaseUrl: 'http://h:22122',
    fetchImpl
  });
  assert.equal(result.ok, true);
  const gw = result.results.find((r) => r.key === 'gatewayBaseUrl');
  assert.equal(gw.reason, 'refused');
  assert.equal(gw.critical, false);
});