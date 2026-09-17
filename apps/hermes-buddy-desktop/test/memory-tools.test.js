'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ToolRegistry } = require('../src/tools');
const { MemoryStore } = require('../src/memory');
const { Workspace } = require('../src/workspace');

// 造一个最小工作区+记忆存储，用来测 remember 工具
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-app-'));
  const workspace = new Workspace({ root, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  workspace.ensure();
  const memory = new MemoryStore({ workspace, appDir, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  memory.ensure();
  const tools = new ToolRegistry({
    workspace, memory,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    permission: 'read-write'
  });
  return { root, appDir, workspace, memory, tools, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {} } };
}

test('remember 工具在 TOOL_DEFINITIONS 里', () => {
  const { TOOL_DEFINITIONS } = require('../src/tools');
  const found = TOOL_DEFINITIONS.find((t) => t.name === 'remember');
  assert.ok(found, '应该有 remember 工具');
  assert.equal(found.category, 'memory');
  assert.ok(found.parameters.properties.text, '要有 text 参数');
});

test('remember 写项目长期记忆，下次能读出来', async () => {
  const fix = makeFixture();
  try {
    const result = await tools_remember(fix.tools, { text: '图片分析工具在 C:\\Temp\\imganalyze.py' });
    assert.ok(result.ok);
    assert.equal(result.scope, 'project');
    assert.equal(result.kind, 'long');
    const mem = fix.memory.projectMemory();
    assert.ok(mem.includes('图片分析工具在 C:\\Temp\\imganalyze.py'));
  } finally { fix.cleanup(); }
});

test('remember 写全局记忆（scope=global）', async () => {
  const fix = makeFixture();
  try {
    const result = await tools_remember(fix.tools, { text: '用户习惯：中文沟通，技术名词中英混合', scope: 'global' });
    assert.ok(result.ok);
    assert.equal(result.scope, 'global');
    assert.ok(fix.memory.globalMemory().includes('中文沟通'));
  } finally { fix.cleanup(); }
});

test('remember 写当天工作日志（kind=daily）', async () => {
  const fix = makeFixture();
  try {
    const result = await tools_remember(fix.tools, { text: '今天装了 imganalyze 到 Temp 目录', kind: 'daily' });
    assert.ok(result.ok);
    assert.equal(result.kind, 'daily');
    // 工作日志写到 <workspace>/.hermes/memory/YYYY-MM-DD.md
    const today = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const fname = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`;
    const dailyFile = path.join(fix.workspace.memoryDir, fname);
    assert.ok(fs.existsSync(dailyFile), '当天日志文件应存在');
    assert.ok(fs.readFileSync(dailyFile, 'utf8').includes('今天装了 imganalyze'));
  } finally { fix.cleanup(); }
});

test('remember 空内容被拒', async () => {
  const fix = makeFixture();
  try {
    const result = await tools_remember(fix.tools, { text: '   ' });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally { fix.cleanup(); }
});

test('renderResult(remember) 输出"已记住"', async () => {
  const fix = makeFixture();
  try {
    const result = await tools_invoke(fix.tools, 'remember', { text: '测试事实' });
    assert.ok(result.text.includes('已记住'));
    assert.ok(result.text.includes('测试事实'));
  } finally { fix.cleanup(); }
});

test('setMemory 能热切换 remember 工具的写入目标', async () => {
  const fix1 = makeFixture();
  const fix2 = makeFixture();
  try {
    const tools = fix1.tools;
    await tools_remember(tools, { text: '第一条进 fix1' });
    assert.ok(fix1.memory.projectMemory().includes('第一条进 fix1'));
    assert.equal(fix2.memory.projectMemory().includes('第一条进 fix1'), false);

    // 模拟切换工作区：setMemory 应该让 remember 写到新工作区
    tools.setMemory(fix2.memory);
    await tools_remember(tools, { text: '第二条进 fix2' });
    assert.ok(fix2.memory.projectMemory().includes('第二条进 fix2'));
    assert.equal(fix1.memory.projectMemory().includes('第二条进 fix2'), false);
  } finally { fix1.cleanup(); fix2.cleanup(); }
});

// ---- 辅助：直接调 execute 并包成 invoke 风格，避免 CommandGuard 依赖 ----
async function tools_remember(tools, input) {
  return await tools.execute('remember', input || {}, {});
}
async function tools_invoke(tools, name, input) {
  const { renderResult } = require('../src/tools');
  const result = await tools.execute(name, input || {}, {});
  return { ok: result.ok !== false, text: renderResult(name, result) };
}
