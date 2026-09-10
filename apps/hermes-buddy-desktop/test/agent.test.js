'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Brain, BrainError, deriveLlmEndpoint, normalizeLlmEndpoint, parseCompletionSse, normalizeToolCalls } = require('../src/agent/brain');
const { AgentLoop, detectRepeat } = require('../src/agent/loop');
const { buildSystemPrompt } = require('../src/agent/prompts');
const { MemoryStore, rememberLine } = require('../src/memory');
const { SkillStore } = require('../src/skills');
const { Workspace } = require('../src/workspace');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-agent-')); }

/** 最小可用的 fetch 替身：按预设脚本返回响应。 */
function fakeFetch(handler) {
  return async (url, options) => {
    const result = await handler(JSON.parse(options.body), url);
    if (result instanceof Error) throw result;
    const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status || 200,
      json: async () => JSON.parse(payload),
      text: async () => payload,
      body: null
    };
  };
}

test('端点推导：Gateway 22122 → 推理 8800', () => {
  assert.equal(deriveLlmEndpoint('http://192.168.0.246:22122'), 'http://192.168.0.246:8800/v1/chat/completions');
  assert.equal(deriveLlmEndpoint('192.168.0.246'), 'http://192.168.0.246:8800/v1/chat/completions');
  assert.equal(deriveLlmEndpoint('http://h:22122', 'http://h:9000/v1/chat/completions'), 'http://h:9000/v1/chat/completions');
  assert.equal(normalizeLlmEndpoint('http://h:9000'), 'http://h:9000/v1/chat/completions');
  assert.throws(() => normalizeLlmEndpoint('ftp://h'), /HTTP/);
});

test('SSE 解析：累积文本与分片 tool_calls', () => {
  const sink = { buffer: '', content: '', toolCalls: [], finishReason: null };
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_command","arguments":"{\\"com"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\\":\\"dir\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  ];
  for (const chunk of chunks) parseCompletionSse(chunk, sink);
  assert.equal(sink.content, '你好');
  assert.equal(sink.finishReason, 'tool_calls');
  const calls = normalizeToolCalls({ tool_calls: sink.toolCalls });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'run_command');
  assert.deepEqual(calls[0].arguments, { command: 'dir' });
});

test('Brain: 非流式返回 tool_calls', async () => {
  const brain = new Brain({
    endpoint: 'http://h:8800/v1/chat/completions',
    fetchImpl: fakeFetch((body) => {
      assert.equal(body.model, 'hermes-agent');
      assert.ok(body.tools.length > 0);
      return { status: 200, body: { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }] } };
    })
  });
  const result = await brain.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'list_dir' } }] });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'list_dir');
  assert.deepEqual(result.toolCalls[0].arguments, { path: '.' });
});

test('Brain: 网络与 HTTP 错误都能读懂', async () => {
  const down = new Brain({ endpoint: 'http://h:8800/v1/chat/completions', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => down.complete({ messages: [{ role: 'user', content: 'x' }] }), /无法连接 Hermes 推理服务/);

  const bad = new Brain({
    endpoint: 'http://h:8800/v1/chat/completions',
    fetchImpl: fakeFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
  });
  await assert.rejects(() => bad.complete({ messages: [{ role: 'user', content: 'x' }] }), /boom/);
});

test('Brain: 缺 messages 直接报错', async () => {
  const brain = new Brain({ endpoint: 'http://h:8800/v1/chat/completions', fetchImpl: fakeFetch(() => ({ status: 200, body: {} })) });
  await assert.rejects(() => brain.complete({ messages: [] }), /消息不能为空/);
});

/** 记录事件的工具替身，方便断言循环行为。 */
function fakeTools(handler) {
  return {
    schemas: () => [{ type: 'function', function: { name: 'probe' } }],
    invoke: async (name, args) => handler(name, args)
  };
}

test('AgentLoop: 工具结果回灌进下一轮', async () => {
  const calls = [];
  const brain = {
    complete: async ({ messages }) => {
      calls.push(messages.length);
      if (calls.length === 1) {
        return { content: '我先看看目录', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }], finishReason: 'tool_calls' };
      }
      const toolMessage = messages[messages.length - 1];
      assert.equal(toolMessage.role, 'tool');
      assert.equal(toolMessage.tool_call_id, 'c1');
      assert.match(toolMessage.content, /src/);
      return { content: '目录里有 src', toolCalls: [], finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({ brain, tools: fakeTools(async () => ({ ok: true, text: 'src/\n  a.js' })), workspace: null });
  const events = [];
  const result = await loop.run({ systemPrompt: 'sys', userMessage: '看看', onEvent: (e) => events.push(e) });
  assert.equal(result.text, '目录里有 src');
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.ok(events.some((e) => e.type === 'tool_start'));
  assert.ok(events.some((e) => e.type === 'tool_result'));
  assert.ok(events.some((e) => e.type === 'done'));
  // 第二轮的消息里应带上了 assistant 的 tool_calls 记录
  assert.equal(calls.length, 2);
});

test('AgentLoop: 被拦截的工具会转成可理解的反馈', async () => {
  let round = 0;
  const brain = {
    complete: async ({ messages }) => {
      round += 1;
      if (round === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'format C:' } }], finishReason: 'tool_calls' };
      const last = messages[messages.length - 1];
      assert.match(last.content, /被安全规则拦截/);
      return { content: '好吧，换个方式', toolCalls: [], finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({ brain, tools: fakeTools(async () => ({ ok: false, blocked: true, text: '高危系统操作' })), workspace: null });
  const result = await loop.run({ systemPrompt: 'sys', userMessage: '格式化' });
  assert.equal(result.text, '好吧，换个方式');
});

test('AgentLoop: 重复调用会被打断', async () => {
  const brain = {
    complete: async () => ({ content: '', toolCalls: [{ id: 'c1', name: 'probe', arguments: { same: 1 } }], finishReason: 'tool_calls' })
  };
  const loop = new AgentLoop({ brain, tools: fakeTools(async () => ({ ok: true, text: 'no change' })), workspace: null, maxTurns: 10 });
  const result = await loop.run({ systemPrompt: 'sys', userMessage: '打转' });
  assert.equal(result.stopped, 'repeated');
  assert.equal(result.turns, 3);
});

test('detectRepeat: 只有连续一致才算', () => {
  const trace = [
    { name: 'a', args: { x: 1 } }, { name: 'b', args: {} }, { name: 'a', args: { x: 1 } }, { name: 'a', args: { x: 1 } }
  ];
  assert.equal(detectRepeat(trace), null);
  assert.equal(detectRepeat([...trace, { name: 'a', args: { x: 1 } }]), 'a');
});

test('AgentLoop: 超过最大步数会停下', async () => {
  const brain = {
    complete: async () => ({ content: '', toolCalls: [{ id: 'c1', name: 'probe', arguments: { n: Math.random() } }], finishReason: 'tool_calls' })
  };
  const loop = new AgentLoop({ brain, tools: fakeTools(async () => ({ ok: true, text: 'x' })), workspace: null, maxTurns: 5 });
  const result = await loop.run({ systemPrompt: 'sys', userMessage: '跑' });
  assert.equal(result.turns, 5);
  assert.equal(result.stopped, 'max_turns');
});

test('系统提示词：身份、环境、权限、约定都在', () => {
  const prompt = buildSystemPrompt({
    workspace: { dir: 'C:\\ws' },
    permission: 'read-write',
    memory: '【本项目记忆】\n- 用 pnpm',
    skills: '【可用技能】\n- windows-shell',
    agentsDoc: '# 项目\n禁止改锁文件',
    workspaceTree: 'src/\n  a.js',
    modelName: 'hermes-agent'
  });
  assert.match(prompt, /Hermes Buddy/);
  assert.match(prompt, /C:\\ws/);
  assert.match(prompt, /读写模式/);
  assert.match(prompt, /禁止改锁文件/);
  assert.match(prompt, /用 pnpm/);
  assert.match(prompt, /windows-shell/);
  assert.match(prompt, /hermes-agent/);
  // 身份必须在最前面，否则模型容易忽略硬规则
  assert.ok(prompt.indexOf('Hermes Buddy') < prompt.indexOf('【运行环境】'));
});

test('记忆：全局与项目分层，日志按天追加', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const store = new MemoryStore({ workspace: ws, appDir: path.join(tempDir(), 'app') });
  store.ensure();

  assert.equal(rememberLine(store, '用户偏好中文回复').ok, true);
  store.saveGlobalMemory('- 用户偏好中文回复');
  store.appendDaily('完成了登录页');

  assert.match(store.projectMemory(), /中文回复/);
  assert.match(store.globalMemory(), /中文回复/);
  assert.match(store.recentDaily('project'), /登录页/);

  const rendered = store.render();
  assert.match(rendered, /用户长期记忆/);
  assert.match(rendered, /本项目记忆/);
  assert.match(rendered, /最近工作日志/);
});

test('技能：内置与项目共存，同名项目优先', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const builtin = path.join(tempDir(), 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'a.md'), '---\nname: a\ndescription: 内置 A\n---\n\n内置正文');
  fs.writeFileSync(path.join(builtin, 'b.md'), '---\nname: b\ndescription: 内置 B\n---\n\nB 正文');

  const store = new SkillStore({ builtinDir: builtin, workspace: ws });
  assert.deepEqual(store.list().map((s) => s.name), ['a', 'b']);
  assert.equal(store.read('a').description, '内置 A');
  assert.equal(store.read('a').content, '内置正文');

  store.save('a', '项目覆盖版', '项目 A');
  assert.equal(store.list().length, 2);
  assert.equal(store.read('a').scope, 'project');
  assert.equal(store.read('a').content, '项目覆盖版');

  assert.match(store.render(), /内置 B/);
  assert.match(store.renderFull(), /项目覆盖版/);
  assert.throws(() => store.remove('b'), /内置技能不能删除/);
  assert.equal(store.remove('a'), true);
  assert.throws(() => store.save('bad name!', 'x'), /技能名/);
});
