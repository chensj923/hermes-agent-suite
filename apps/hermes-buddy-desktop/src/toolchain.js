'use strict';

const { execFileSync } = require('child_process');

// 全部是"没有也能干活"的可选件。PowerShell 本身 Windows 自带，不在此列。
const TOOLCHAIN = Object.freeze([
  { id: 'git', name: 'Git', command: 'git', wingetId: 'Git.Git', versionArgs: ['--version'], why: '版本控制、克隆仓库、查看提交历史' },
  { id: 'node', name: 'Node.js', command: 'node', wingetId: 'OpenJS.NodeJS.LTS', versionArgs: ['--version'], why: '运行前端项目与脚本' },
  { id: 'python', name: 'Python', command: 'python', wingetId: 'Python.Python.3.12', versionArgs: ['--version'], why: '数据处理与自动化脚本' },
  { id: 'pwsh', name: 'PowerShell 7', command: 'pwsh', wingetId: 'Microsoft.PowerShell', versionArgs: ['--version'], why: '新版 PowerShell，兼容性更好（可选）' },
  { id: 'winget', name: 'winget', command: 'winget', wingetId: null, versionArgs: ['--version'], why: 'Windows 包管理器，用于一键安装上面的工具' }
]);

function runQuiet(command, args, timeout = 8000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (_) {
    return null;
  }
}

function findPath(tool) {
  if (process.platform === 'win32') {
    const out = runQuiet('where', [tool.command]);
    return out === null ? null : firstLine(out);
  }
  return runQuiet('command', ['-v', tool.command]);
}

function isAvailable(tool) {
  return findPath(tool) !== null;
}

/** 探测工具链。返回给 UI 直接渲染，缺失的给出安装命令。 */
function detectTooling() {
  return TOOLCHAIN.map((tool) => {
    const path = findPath(tool);
    const available = path !== null;
    const version = available && tool.versionArgs ? firstLine(runQuiet(tool.command, tool.versionArgs)) : null;
    const installCommand = available || !tool.wingetId ? null : buildInstallCommand(tool);
    return {
      id: tool.id,
      name: tool.name,
      // 以下字段供 renderer/app.js 直接渲染
      label: tool.name,
      path: path || null,
      note: version || tool.why,
      available,
      version,
      command: tool.command,
      why: tool.why,
      installCommand,
      installable: Boolean(installCommand)
    };
  });
}

function buildInstallCommand(tool) {
  return `winget install --id ${tool.wingetId} -e --accept-source-agreements --accept-package-agreements`;
}

function firstLine(text) {
  return text ? String(text).split(/\r?\n/)[0].trim() : null;
}

/** 供 UI 的一键安装按钮调用；返回 winget 的原始输出，失败时抛出可读错误。 */
function install(toolId) {
  const tool = TOOLCHAIN.find((item) => item.id === toolId);
  if (!tool) throw new Error(`未知工具: ${toolId}`);
  if (!tool.wingetId) throw new Error(`${tool.name} 不能通过 winget 安装`);
  if (!isAvailable({ command: 'winget' })) throw new Error('这台电脑没有 winget，请手动安装或升级 Windows 应用安装程序');
  try {
    const output = execFileSync('winget', ['install', '--id', tool.wingetId, '-e', '--accept-source-agreements', '--accept-package-agreements'], {
      encoding: 'utf8',
      timeout: 600000,
      windowsHide: true
    });
    return { ok: true, output: String(output || '').trim() };
  } catch (error) {
    const detail = String((error && error.stderr) || (error && error.message) || error || '');
    throw new Error(`安装 ${tool.name} 失败: ${detail.slice(0, 300)}`);
  }
}

/** 把工具链现状写成一段给模型看的说明，避免它去调用不存在的命令。 */
function renderToolchainForPrompt() {
  const detected = detectTooling();
  const missing = detected.filter((tool) => !tool.available && tool.id !== 'winget');
  const present = detected.filter((tool) => tool.available);
  const lines = [`已安装: ${present.map((tool) => tool.command).join(', ') || '（无）'}`];
  if (missing.length) lines.push(`未安装: ${missing.map((tool) => tool.command).join(', ')}（需要用这些命令时先告知用户，不要假装执行成功）`);
  return lines.join('\n');
}

module.exports = { detectTooling, install, buildInstallCommand, renderToolchainForPrompt, TOOLCHAIN, isAvailable };
