'use strict';

const { ShellRunner } = require('./shell');
const { FileTools } = require('./files');
const { CommandGuard } = require('./guard');

/**
 * 工具注册表：一份定义同时产出 OpenAI function-calling schema 与本地执行入口。
 * 模型只看到 schema 和结果文本，永远碰不到 Node 对象，也碰不到工作区之外的路径。
 */

const TOOL_DEFINITIONS = [
  {
    name: 'run_command',
    category: 'shell',
    description: '在用户 Windows 电脑的工作目录中执行 PowerShell 命令。命令在独立进程中运行，默认工作目录已设为工作区根目录。可以运行 git、npm、python、node 等本机已安装的程序。不要用 ssh 连接其他机器。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令或脚本，可多行' },
        cwd: { type: 'string', description: '可选，相对工作区的子目录；留空则在工作区根目录执行' },
        timeout_seconds: { type: 'number', description: '可选，超时秒数，默认 120，最大 600' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    category: 'read',
    description: '读取工作区内文本文件的内容，带行号。适合看代码、配置和日志。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'number', description: '可选，从第几行开始（0 基）' },
        limit: { type: 'number', description: '可选，最多读多少行' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    category: 'write',
    description: '写入或覆盖工作区内的文件。父目录会自动创建。修改已有文件前请先 read_file 确认内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '文件完整内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_dir',
    category: 'read',
    description: '列出工作区内的目录结构，用于了解项目布局。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目录，留空为根目录' },
        depth: { type: 'number', description: '可选，递归层数，默认 1，最大 4' }
      },
      required: []
    }
  },
  {
    name: 'find_files',
    category: 'read',
    description: '按名称模式查找文件，支持 * 和 ** 通配，例如 "*.md"、"src/**/*.js"。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式' },
        path: { type: 'string', description: '可选，限定在某个子目录下查找' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'search_content',
    category: 'read',
    description: '在工作区文件内容中搜索（支持正则），返回匹配的文件名、行号和内容。用于定位代码或配置。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本或正则表达式' },
        path: { type: 'string', description: '可选，限定搜索目录' },
        filePattern: { type: 'string', description: '可选，只搜索符合该名称模式的文件，如 "*.js"' },
        maxResults: { type: 'number', description: '可选，最多返回多少条，默认 50' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'system_info',
    category: 'read',
    description: '查看这台 Windows 电脑的基本信息：CPU、内存、系统版本、工作区路径等。用于判断是否具备运行某命令的条件。',
    parameters: { type: 'object', properties: {}, required: [] }
  }
];

class ToolRegistry {
  constructor({ workspace, guard, shell, files, logger, permission = 'read-write' }) {
    if (!workspace) throw new Error('缺少 workspace');
    this.workspace = workspace;
    this.guard = guard || new CommandGuard({ permission });
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.shell = shell || new ShellRunner({ workspace, guard: this.guard, logger: this.logger });
    this.files = files || new FileTools({ workspace, logger: this.logger });
    this.permission = permission;
  }

  setPermission(level) {
    this.permission = level;
    return this.guard.setPermission(level);
  }

  /** OpenAI function-calling 需要的 tools 数组。 */
  schemas() {
    return TOOL_DEFINITIONS.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
  }

  names() { return TOOL_DEFINITIONS.map((tool) => tool.name); }

  /** 只读档位下，写类工具直接拒绝，不必等命令守卫兜底。 */
  assertAllowed(name) {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) return { ok: false, error: `未知工具: ${name}` };
    if (this.permission === 'read' && (definition.category === 'write' || definition.category === 'shell')) {
      return { ok: false, error: '当前为只读模式，禁止写入或执行命令' };
    }
    return { ok: true, definition };
  }

  /**
   * 执行工具并产出给模型看的文本。
   * @returns {Promise<{ ok: boolean, name: string, text: string, data?: object, blocked?: boolean }>}
   */
  async invoke(name, args, options = {}) {
    const gate = this.assertAllowed(name);
    if (!gate.ok) return { ok: false, name, text: gate.error, blocked: true };

    const input = args && typeof args === 'object' ? args : {};
    const started = Date.now();
    try {
      const result = await this.execute(name, input, options);
      const durationMs = Date.now() - started;
      this.logger.info('tool-done', { name, durationMs, ok: result.ok !== false, blocked: Boolean(result.blocked) });
      // blocked 必须透传：上层要靠它区分"工具跑失败了"和"被规则挡住了"。
      return {
        ok: result.ok !== false,
        name,
        text: renderResult(name, result),
        data: result,
        durationMs,
        blocked: Boolean(result.blocked)
      };
    } catch (error) {
      const message = (error && error.message) || String(error);
      this.logger.warn('tool-failed', { name, error: message });
      // 路径越界之类的错误要明确告诉模型，否则它会反复重试同一条越界命令。
      return { ok: false, name, text: `执行失败: ${message}`, error: message };
    }
  }

  async execute(name, input, options) {
    switch (name) {
      case 'run_command': {
        const seconds = Number(input.timeout_seconds);
        const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
        const result = await this.shell.run(String(input.command || ''), {
          cwd: input.cwd,
          timeoutMs,
          signal: options.signal,
          onConfirm: options.onConfirm
        });
        // 被守卫拦截或用户取消：让模型知道这条路走不通，换别的办法。
        if (result.denied) return { ok: false, blocked: true, error: result.error };
        return { ...result, command: input.command };
      }
      case 'read_file': return this.files.readFile(input);
      case 'write_file': return this.files.writeFile(input);
      case 'list_dir': return this.files.listDir(input);
      case 'find_files': return this.files.findFiles(input);
      case 'search_content': return this.files.searchContent(input);
      case 'system_info': return this.files.systemInfo();
      default: throw new Error(`未知工具: ${name}`);
    }
  }
}

/** 工具结果 → 给模型的紧凑文本。命令输出保持原样，结构化结果走 JSON。 */
function renderResult(name, result) {
  // 被拦截 / 出错时优先说清原因，模型才知道该换路而不是重试。
  if (!result || result.blocked || result.ok === false) {
    const reason = (result && (result.error || result.reason)) || '未知错误';
    return `失败: ${reason}`;
  }
  if (name === 'run_command') {
    const parts = [];
    parts.push(`退出码: ${result.exitCode}${result.timedOut ? '（超时被中断）' : ''}  耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.stdout && result.stdout.trim()) parts.push(`--- 标准输出 ---\n${result.stdout.trim()}`);
    if (result.stderr && result.stderr.trim()) parts.push(`--- 错误输出 ---\n${result.stderr.trim()}`);
    if (!result.stdout && !result.stderr) parts.push('（命令没有产生任何输出）');
    return parts.join('\n');
  }
  try { return JSON.stringify(result, null, 2); } catch (_) { return String(result); }
}

module.exports = { ToolRegistry, TOOL_DEFINITIONS, renderResult };
