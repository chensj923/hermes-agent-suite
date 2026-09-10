'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionManager } = require('../src/session-manager');

function tempDir(prefix = 'buddy-sm-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** 内存版 ConnectionStore：保留保存/清除语义，但不碰 DPAPI。 */
function fakeStore(dir) {
  const file = path.join(dir, 'conn.json');
  return {
    filePath: file,
    isEncryptionAvailable: () => true,
    exists: () => fs.existsSync(file),
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } },
    save(connection) {
      const payload = { ...connection, savedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
      return payload;
    },
    clear() { try { fs.rmSync(file, { force: true }); return true; } catch (_) { return false; } }
  };
}

/** 按 URL 分发的 fetch 替身，模拟 Hermes 的模型路由。 */
function hermesFetch({ models = ['hermes-agent'], replies = [] } = {}) {
  const state = { requests: [], replyIndex: 0 };
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    state.requests.push({ url, body });
    const make = (payload) => ({
      ok: true, status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      body: null
    });
    if (url.includes('/v1/models')) return make({ object: 'list', data: models.map((id) => ({ id })) });
    // 依次消费预设回复，用完就返回一段普通文本。
    const reply = replies[state.replyIndex] || { content: '（默认回复）' };
    state.replyIndex += 1;
    const message = reply.toolCalls
      ? { content: reply.content || '', tool_calls: reply.toolCalls }
      : { content: reply.content || '' };
    return make({ choices: [{ message, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 } });
  };
  impl.state = state;
  return impl;
}

function makeManager({ fetchImpl, dir = tempDir(), provisioning = null } = {}) {
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const builtin = path.join(dir, 'builtin-skills');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'demo.md'), '---\nname: demo\ndescription: 演示技能\n---\n\n正文');
  const manager = new SessionManager({
    store: fakeStore(dir),
    provisioning,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    appDir,
    builtinSkillsDir: builtin,
    fetchImpl: fetchImpl || hermesFetch()
  });
  return { manager, appDir, dir, workspace: path.join(dir, 'ws') };
}

const CONNECTION = (workspace) => ({
  baseUrl: 'http://192.168.0.246:22122',
  apiKey: 'secret-key-123',
  profile: 'buddy',
  model: 'hermes-agent',
  workspace,
  permission: 'read-write'
});

test('connect: 建立运行时、建好工作区、落盘配置', async () => {
  const { manager, workspace } = makeManager();
  const result = await manager.connect(CONNECTION(workspace));

  assert.equal(result.connection.configured, true);
  assert.equal(result.connection.workspace, workspace);
  assert.equal(result.connection.llmUrl, 'http://192.168.0.246:8800/v1/chat/completions');
  assert.ok(fs.existsSync(path.join(workspace, 'AGENTS.md')), '应自动生成 AGENTS.md');
  assert.ok(fs.existsSync(path.join(workspace, '.hermes', 'skills')));
  assert.deepEqual(result.models, ['hermes-agent']);
  assert.equal(result.gatewayWarning, null);
});

test('connect: 推理端点不通则失败，且不写盘', async () => {
  const { manager, workspace, dir } = makeManager({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => manager.connect(CONNECTION(workspace)), /推理服务不可用/);
  assert.equal(fs.existsSync(path.join(dir, 'conn.json')), false, '失败时不应保存凭据');
});

test('connect: Gateway 不通只降级，本机照样能干活', async () => {
  const broken = {
    createGateway: () => ({
      health: async () => { throw new Error('gateway down'); },
      createSession: async () => { throw new Error('gateway down'); }
    }),
    provision: async () => { throw new Error('gateway down'); },
    fetchProvisioningStatus: async () => ({ configured: false })
  };
  const { manager, workspace } = makeManager({ provisioning: broken });
  const result = await manager.connect(CONNECTION(workspace));
  assert.equal(result.connection.configured, true);
  assert.ok(result.gatewayWarning, '应带上降级提示');
  assert.ok(result.workspace.exists);
});

test('status: 永不泄露 API Key', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  const dump = JSON.stringify(manager.status());
  assert.ok(!dump.includes('secret-key-123'), '状态里不能出现密钥');
  assert.equal(manager.status().ready, true);
  assert.equal(manager.status().permission, 'read-write');
});

test('send: 调用工具并把结果回灌，最终给出答复', async () => {
  const fetch = hermesFetch({
    replies: [
      { content: '我先看看目录', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
      { content: '工作区里有个 hello.txt' }
    ]
  });
  const { manager, workspace } = makeManager({ fetchImpl: fetch });
  await manager.connect(CONNECTION(workspace));
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hi');

  const events = [];
  const result = await manager.send({ requestId: 'r1', text: '看看有什么' }, (e) => events.push(e));

  assert.equal(result.text, '工作区里有个 hello.txt');
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'list_dir'));
  assert.ok(events.some((e) => e.type === 'tool_result'));
  assert.ok(events.some((e) => e.type === 'done'));
  // 第二轮必须带上工具结果，模型才知道目录里有什么
  const chats = fetch.state.requests.filter((r) => r.url.includes('/chat/completions'));
  const toolMsg = chats[1].body.messages[chats[1].body.messages.length - 1];
  assert.equal(toolMsg.role, 'tool');
  assert.match(toolMsg.content, /hello\.txt/);
});

test('send: 未配置时给出可读错误', async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.send({ requestId: 'r1', text: 'hi' }, () => {}), /尚未配置|还没有配置/);
});

test('send: 危险命令被拦截且不落地', async () => {
  const fetch = hermesFetch({
    replies: [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"format C:"}' } }] },
      { content: '这条命令不能执行' }
    ]
  });
  const { manager, workspace } = makeManager({ fetchImpl: fetch });
  await manager.connect(CONNECTION(workspace));
  const result = await manager.send({ requestId: 'r1', text: '格式化磁盘' }, () => {});
  assert.match(result.text, /不能执行/);
  const chats = fetch.state.requests.filter((r) => r.url.includes('/chat/completions'));
  assert.match(chats[1].body.messages.slice(-1)[0].content, /被安全规则拦截/);
});

test('abort: 能取消进行中的请求', async () => {
  // 让请求真的卡在模型调用里，才测得出取消是否生效。
  let release;
  const hanging = new Promise((resolve) => { release = resolve; });
  const { manager, workspace } = makeManager({
    fetchImpl: async (url) => {
      if (url.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'hermes-agent' }] }), text: async () => '{}', body: null };
      await hanging;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'done' } }] }), text: async () => '{}', body: null };
    }
  });
  await manager.connect(CONNECTION(workspace));

  const pending = manager.send({ requestId: 'r1', text: 'hi' }, () => {}).catch(() => {});
  await waitFor(() => manager.status().busy, '请求进入执行中');
  assert.equal(manager.abort('r1'), true);
  release();
  await pending;
  assert.equal(manager.status().busy, false);
});

/** 轮询直到条件成立，避免测试里到处塞 sleep。 */
async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('工作区切换会重建运行时并记住新目录', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  const next = path.join(tempDir(), 'another-ws');
  const info = manager.setWorkspace(next);
  assert.equal(info.root, next);
  assert.ok(fs.existsSync(path.join(next, 'AGENTS.md')));
  assert.equal(manager.status().workspace, next);
});

test('权限档位切换同时作用于工具与持久化配置', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  assert.equal(manager.setPermission('read').permission, 'read');
  assert.equal(manager.status().permission, 'read');
  const outcome = await manager.tools.invoke('write_file', { path: 'x.txt', content: 'x' });
  assert.equal(outcome.blocked, true);
  manager.setPermission('read-write');
});

test('角色设定：可读写，缺省用内置人设', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  assert.match(manager.getPersona(), /Hermes Buddy/);
  manager.savePersona('你是测试管家');
  assert.match(manager.getPersona(), /测试管家/);
  assert.match(manager.buildPrompt(), /测试管家/);
});

test('记忆：按项目与全局分层保存', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  assert.equal(manager.rememberLine('用户偏好中文', 'project').ok, true);
  assert.equal(manager.rememberLine('用户是开发者', 'global').ok, true);
  assert.match(manager.getMemory('project'), /中文/);
  assert.match(manager.getMemory('global'), /开发者/);
  manager.saveMemory('- 全量覆盖', 'project');
  assert.equal(manager.getMemory('project').trim(), '- 全量覆盖');
});

test('技能：内置技能可见，项目技能可增删', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  const names = manager.listSkills().map((s) => s.name);
  assert.ok(names.includes('demo'), `应包含内置技能，实际 ${names.join(',')}`);

  manager.saveSkill('myflow', '步骤一\n步骤二', '我的流程');
  assert.ok(manager.listSkills().some((s) => s.name === 'myflow' && s.scope === 'project'));
  assert.match(manager.readSkill('myflow').content, /步骤一/);
  assert.ok(manager.buildPrompt().includes('myflow'));

  manager.removeSkill('myflow');
  assert.ok(!manager.listSkills().some((s) => s.name === 'myflow'));
});

test('buildPrompt 包含工作区、工具链与技能信息', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  const prompt = manager.buildPrompt();
  assert.match(prompt, new RegExp(workspace.replace(/\\/g, '\\\\'), 'i'));
  assert.match(prompt, /【本机工具链】/);
  assert.match(prompt, /【可用技能】/);
  assert.match(prompt, /【运行环境】/);
});

test('disconnect: 清掉凭据与内存状态', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  manager.disconnect();
  assert.equal(manager.status().configured, false);
  assert.equal(manager.brain, null);
  assert.equal(manager.messages.length, 0);
});

test('models: 推理服务异常时退回当前模型', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  manager.brain = { listModels: async () => { throw new Error('down'); } };
  assert.deepEqual(await manager.models(), ['hermes-agent']);
});

test('工作区越界：工具读不到工作区外的文件', async () => {
  const { manager, workspace } = makeManager();
  await manager.connect(CONNECTION(workspace));
  const outside = path.join(tempDir(), 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  const outcome = await manager.tools.invoke('read_file', { path: outside });
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /超出工作目录/);
});
