'use strict';

/**
 * 模拟真实用户场景的端到端测试（不 bind 端口，沙箱安全）。
 *
 * 场景 1：用户说"帮我记住 X" -> 模型回 tool_call remember -> 客户端执行 ->
 *         验证记忆文件写入了 -> render() 能带出来
 * 场景 2：历史落盘 -> "重开 Buddy" -> loadHistory 恢复
 * 场景 3：remember 工具 renderResult 输出"已记住"
 *
 * 走的是真实的 ToolRegistry.execute + MemoryStore + renderResult + stripImagesFromHistory 路径，
 * 不 bind 端口、不 spawn 进程，沙箱里安全跑。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.resolve(__dirname, '..', 'src');
const { Workspace } = require(path.join(SRC, 'workspace'));
const { ToolRegistry, renderResult } = require(path.join(SRC, 'tools'));
const { MemoryStore } = require(path.join(SRC, 'memory'));
const { stripImagesFromHistory } = require(path.join(SRC, 'agent', 'parts'));

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ws-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-app-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const workspace = new Workspace({ root: workspaceDir, logger });
  workspace.ensure();
  const memory = new MemoryStore({ workspace, appDir, logger });
  memory.ensure();
  const tools = new ToolRegistry({ workspace, memory, logger, permission: 'read-write' });
  return {
    root, appDir, workspace, memory, tools, logger,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {} }
  };
}

test('场景 1：用户让 Buddy 记住 -> 记忆写入 -> render 能带出来', async () => {
  const fix = makeFixture();
  try {
    // 模拟：模型调了 remember 工具
    const result = await fix.tools.execute('remember', {
      text: '图片分析工具 imganalyze 在 C:\\Users\\chens\\SynologyDrive\\Temp\\imganalyze.py',
      scope: 'project',
      kind: 'long'
    });
    assert.ok(result.ok, 'remember 应成功');
    assert.equal(result.scope, 'project');

    // 验证：记忆文件写入了
    const mem = fix.memory.projectMemory();
    assert.ok(mem.includes('imganalyze'), '项目记忆应包含 imganalyze');
    assert.ok(mem.includes('Temp'), '记忆应包含路径');

    // 验证：render() 能把它带进 system prompt
    const rendered = fix.memory.render();
    assert.ok(rendered.includes('imganalyze'), 'render() 输出应包含 imganalyze');
    assert.ok(rendered.includes('项目记忆'), '应有项目记忆标题');

    // 验证：renderResult 给模型的回复里有"已记住"
    const text = renderResult('remember', result);
    assert.ok(text.includes('已记住'), '应输出"已记住"');
    assert.ok(text.includes('imganalyze'), '回复应包含记忆内容');
  } finally { fix.cleanup(); }
});

test('场景 2：历史落盘 -> "重开 Buddy" -> 恢复', () => {
  const tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hist-'));
  try {
    const historyFile = path.join(tmpApp, 'history', 'default.json');

    // 模拟第一轮对话后的历史
    const messages = [
      { role: 'user', content: '帮我记住 imganalyze 在 Temp 目录' },
      { role: 'assistant', content: '已记住。' },
      { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '图里是...' },
    ];

    // 落盘（模拟 saveHistory）：先脱图
    const stripped = stripImagesFromHistory(messages, 0);
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify({
      agentId: 'default',
      savedAt: new Date().toISOString(),
      messages: stripped
    }), 'utf8');
    assert.ok(fs.existsSync(historyFile), '历史文件应已创建');

    // 模拟"重开 Buddy"：loadHistory 读回
    const loaded = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.equal(loaded.messages.length, 4, '应恢复 4 条消息');

    // 验证图片被脱掉了（落盘前 keep=0）
    const userContent3 = loaded.messages[2].content;
    assert.ok(Array.isArray(userContent3));
    assert.equal(userContent3.find((p) => p.type === 'image_url'), undefined, 'image_url 应被脱掉');
    assert.ok(userContent3.some((p) => p.type === 'text' && p.text.includes('已省略')), '应有占位文本');

    // 验证恢复的文字消息完整
    assert.equal(loaded.messages[0].content, '帮我记住 imganalyze 在 Temp 目录');
    assert.equal(loaded.messages[1].content, '已记住。');
  } finally { try { fs.rmSync(tmpApp, { recursive: true, force: true }); } catch (_) {} }
});

test('场景 3：全局记忆写入（跨工作区）', async () => {
  const fix = makeFixture();
  try {
    const result = await fix.tools.execute('remember', {
      text: '用户习惯：中文沟通，技术名词中英混合保留',
      scope: 'global',
      kind: 'long'
    });
    assert.ok(result.ok);
    assert.equal(result.scope, 'global');

    // 全局记忆应在 appDir/memory/MEMORY.md
    const globalMem = fix.memory.globalMemory();
    assert.ok(globalMem.includes('中文沟通'), '全局记忆应包含内容');
    assert.ok(globalMem.includes('技术名词'), '全局记忆应完整');

    // render() 也能带出来
    const rendered = fix.memory.render();
    assert.ok(rendered.includes('用户长期记忆'), '应有全局记忆标题');
    assert.ok(rendered.includes('中文沟通'), 'render 应包含全局记忆内容');
  } finally { fix.cleanup(); }
});

test('场景 4：当天工作日志写入（kind=daily）', async () => {
  const fix = makeFixture();
  try {
    const result = await fix.tools.execute('remember', {
      text: '今天装了 imganalyze 到 Temp 目录',
      kind: 'daily'
    });
    assert.ok(result.ok);
    assert.equal(result.kind, 'daily');

    // 工作日志写到 <workspace>/.hermes/memory/YYYY-MM-DD.md
    const today = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const fname = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`;
    const dailyFile = path.join(fix.workspace.memoryDir, fname);
    assert.ok(fs.existsSync(dailyFile), '当天日志文件应存在');
    assert.ok(fs.readFileSync(dailyFile, 'utf8').includes('imganalyze'), '日志应包含 imganalyze');

    // render() 的最近工作日志部分能带出来
    const rendered = fix.memory.render();
    assert.ok(rendered.includes('最近工作日志') || rendered.includes('imganalyze'),
      'render 应包含最近工作日志');
  } finally { fix.cleanup(); }
});

test('场景 5：记忆在两个工作区之间隔离', async () => {
  const fix1 = makeFixture();
  const fix2 = makeFixture();
  try {
    // 工作区 1 记了一条
    await fix1.tools.execute('remember', { text: '项目 A 用 React' });
    // 工作区 2 记了另一条
    await fix2.tools.execute('remember', { text: '项目 B 用 Vue' });

    // 验证隔离
    const mem1 = fix1.memory.projectMemory();
    const mem2 = fix2.memory.projectMemory();
    assert.ok(mem1.includes('React') && !mem1.includes('Vue'), '工作区 1 只有 React');
    assert.ok(mem2.includes('Vue') && !mem2.includes('React'), '工作区 2 只有 Vue');
  } finally { fix1.cleanup(); fix2.cleanup(); }
});

test('场景 6：空记忆时 render 返回空串（不给模型塞占位符）', () => {
  const fix = makeFixture();
  try {
    assert.equal(fix.memory.render(), '', '空记忆应返回空串');
  } finally { fix.cleanup(); }
});
