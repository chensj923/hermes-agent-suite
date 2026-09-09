const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayClient, normalizeGatewayUrl } = require('../src');

test('normalizes a bare Hermes host', () => assert.equal(normalizeGatewayUrl('192.168.0.246:22123'), 'http://192.168.0.246:22123'));
test('creates Hermes sessions with the required model and bearer key', async () => {
  let received;
  const client = new GatewayClient({ baseUrl: 'https://hermes.example', apiKey: 'key', fetchImpl: async (url, options) => {
    received = { url, options }; return { ok: true, text: async () => '{"id":"session-1"}' };
  }});
  const result = await client.createSession('buddy');
  assert.equal(result.id, 'session-1');
  assert.equal(received.url, 'https://hermes.example/api/sessions');
  assert.equal(received.options.headers.Authorization, 'Bearer key');
  assert.deepEqual(JSON.parse(received.options.body), { model: 'hermes-agent', profile: 'buddy' });
});
