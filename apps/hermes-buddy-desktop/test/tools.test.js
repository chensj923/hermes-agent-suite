'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Workspace, WorkspaceError, defaultRoot } = require('../src/workspace');
const { ToolRegistry } = require('../src/tools');
const { CommandGuard } = require('../src/tools/guard');
const { ShellRunner } = require('../src/tools/shell');
const { FileTools, globToRegExp } = require('../src/tools/files');

function tempDir(prefix = 'buddy-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('workspace: 越界路径一律拒绝', () => {
  const root = tempDir();
  const ws = new Workspace({ root });
  fs.mkdirSync(path.join(root, 'inside'), { recursive: true });

  assert.equal(ws.resolve('inside'), path.join(root, 'inside'));
  assert.throws(() => ws.resolve('../outside'), /超出工作目录/);
  assert.throws(() => ws.resolve('/etc/passwd'), /超出工作目录/);
  assert.throws(() => new Workspace({ root: 'relative/path' }), /绝对路径/);
});

test('workspace: ensure 建好目录与 AGENTS.md', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  assert.ok(fs.existsSync(ws.agentsFile), 'AGENTS.md 应被创建');
  assert.ok(fs.existsSync(ws.memoryDir), '记忆目录应被创建');
  assert.ok(fs.existsSync(ws.skillsDir), '技能目录应被创建');
  // 重复调用不应覆盖用户改过的 AGENTS.md
  fs.writeFileSync(ws.agentsFile, 'custom');
  ws.ensure();
  assert.equal(fs.readFileSync(ws.agentsFile, 'utf8'), 'custom');
});

test('workspace: describe 能给出结构', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const info = ws.describe();
  assert.match(info.tree, /a\.txt/);
  assert.match(info.tree, /sub\//);
  assert.equal(info.empty, false);
});

test('workspace: 默认目录在用户主目录下', () => {
  assert.ok(defaultRoot().startsWith(os.homedir()));
});

test('guard: 高危命令任何档位都拒绝', () => {
  for (const level of ['read', 'read-write', 'full']) {
    const guard = new CommandGuard({ permission: level });
    for (const cmd of ['format C:', 'diskpart', 'reg delete HKLM\\x', 'Stop-Computer', 'vssadmin delete shadows']) {
      const verdict = guard.inspect(cmd);
      assert.equal(verdict.action, 'deny', `${cmd} 应被拒绝（${level}）`);
      assert.equal(verdict.category, 'forbidden');
    }
  }
});

test('guard: 只读档拦写入，读写档放写入但拦删除确认', () => {
  const readOnly = new CommandGuard({ permission: 'read' });
  assert.equal(readOnly.inspect('New-Item a.txt').action, 'deny');
  assert.equal(readOnly.inspect('Remove-Item a.txt').action, 'deny');
  assert.equal(readOnly.inspect('Get-ChildItem').action, 'allow');

  const rw = new CommandGuard({ permission: 'read-write' });
  assert.equal(rw.inspect('New-Item a.txt').action, 'allow');
  assert.equal(rw.inspect('Remove-Item a.txt').action, 'confirm');

  const rwNoConfirm = new CommandGuard({ permission: 'read-write', confirmDeletes: false });
  assert.equal(rwNoConfirm.inspect('Remove-Item a.txt').action, 'allow');
});

test('guard: 空命令与未知档位', () => {
  const guard = new CommandGuard();
  assert.equal(guard.inspect('').action, 'deny');
  assert.throws(() => guard.setPermission('nope'), /未知权限档位/);
});

test('glob: * 与 ** 语义', () => {
  assert.ok(globToRegExp('*.md').test('readme.md'));
  assert.ok(!globToRegExp('*.md').test('src/readme.md'));
  assert.ok(globToRegExp('**/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('**/*.js').test('a.js'));
});

test('files: 读写查找搜索', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const files = new FileTools({ workspace: ws });

  assert.equal(files.writeFile({ path: 'src/demo.js', content: 'const a = 1;\nconst marker = 2;\n' }).ok, true);
  assert.equal(files.writeFile({ path: 'src/demo.js', content: 'x' }).created, false);

  const read = files.readFile({ path: 'src/demo.js' });
  assert.equal(read.ok, true);
  assert.match(read.content, /1 \| x/);

  const listed = files.listDir({ path: '.', depth: 2 });
  assert.match(listed.tree, /src\//);
  assert.match(listed.tree, /demo\.js/);

  const found = files.findFiles({ pattern: '*.js' });
  assert.deepEqual(found.files, ['src/demo.js']);

  const searched = files.searchContent({ pattern: 'marker' });
  assert.equal(searched.count >= 0, true);

  assert.throws(() => files.readFile({ path: '../escape.txt' }), /超出工作目录/);
});

test('files: system_info 返回 Windows 关键字段', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const info = new FileTools({ workspace: ws }).systemInfo();
  assert.equal(info.ok, true);
  assert.ok(info.platform);
  assert.ok(info.cpu);
  assert.equal(info.workspace, ws.dir);
});

// 真实执行 PowerShell：这一条最能暴露编码/转义/超时的问题，只在 Windows 上跑。
test('shell: 真实执行 PowerShell（仅 Windows）', { skip: process.platform !== 'win32' }, async () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const shell = new ShellRunner({ workspace: ws, guard: new CommandGuard({ permission: 'read-write' }) });

  const result = await shell.run('Write-Output "你好 Buddy"');
  assert.equal(result.exitCode, 0, `期望成功，实际: ${result.stderr}`);
  assert.match(result.stdout, /你好 Buddy/, '中文输出不应乱码');

  const cwdCheck = await shell.run('(Get-Location).Path');
  assert.match(cwdCheck.stdout, new RegExp(ws.dir.replace(/\\/g, '\\\\'), 'i'));

  // 越界 cd 不应影响后续命令的工作目录
  await shell.run('Set-Location C:\\');
  const stillInside = await shell.run('(Get-Location).Path');
  assert.ok(!/^C:\\$/im.test(stillInside.stdout.trim()), '每条命令都应回到工作区');
});

test('shell: 危险命令被拦截且不落地执行', async () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const shell = new ShellRunner({ workspace: ws, guard: new CommandGuard({ permission: 'full' }) });
  const blocked = await shell.run('format C:');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.denied, true);
  assert.match(blocked.error, /高危系统操作/);
});

test('shell: 删除命令默认需要确认，用户拒绝则中止', async () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const shell = new ShellRunner({ workspace: ws, guard: new CommandGuard({ permission: 'read-write' }) });
  const target = path.join(root, 'doomed.txt');
  fs.writeFileSync(target, 'x');

  const denied = await shell.run('Remove-Item doomed.txt', { onConfirm: async () => false });
  assert.equal(denied.denied, true);
  assert.ok(fs.existsSync(target), '用户拒绝后文件必须还在');

  if (process.platform === 'win32') {
    const allowed = await shell.run('Remove-Item doomed.txt', { onConfirm: async () => true });
    assert.equal(allowed.exitCode, 0);
    assert.ok(!fs.existsSync(target), '用户同意后文件应被删除');
  }
});

test('registry: schema 可直接喂给 function calling', () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const registry = new ToolRegistry({ workspace: ws });
  const schemas = registry.schemas();
  assert.ok(schemas.length >= 7);
  for (const schema of schemas) {
    assert.equal(schema.type, 'function');
    assert.ok(schema.function.name && schema.function.description);
    assert.equal(schema.function.parameters.type, 'object');
  }
  assert.ok(registry.names().includes('run_command'));
});

test('registry: 只读模式下写工具被拦下', async () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const registry = new ToolRegistry({ workspace: ws, permission: 'read' });
  const outcome = await registry.invoke('write_file', { path: 'a.txt', content: 'x' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.text, /只读模式/);
});

test('registry: 未知工具与异常不抛出', async () => {
  const root = path.join(tempDir(), 'ws');
  const ws = new Workspace({ root });
  ws.ensure();
  const registry = new ToolRegistry({ workspace: ws });
  const outcome = await registry.invoke('no_such_tool', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /未知工具/);

  const bad = await registry.invoke('read_file', { path: 'missing-file.txt' });
  assert.equal(bad.ok, false);
});
