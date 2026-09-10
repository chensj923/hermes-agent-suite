'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT = 20000;
// PowerShell 7 优先（若用户装了），否则用系统自带的 Windows PowerShell 5.1。
const SHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe'];

/**
 * 在 Windows 上执行 PowerShell。
 *
 * 为什么写临时脚本而不是 `-Command "…"`：Windows 的命令行转义规则在引号、
 * 管道、中文路径上是出了名的坑，`-Command` 传参经常把命令改写得面目全非。
 * 落盘成 .ps1 再 `-File` 执行，命令原样交给 PowerShell，也方便事后审计。
 */
class ShellRunner {
  constructor({ workspace, guard, logger, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT, shellPath = null }) {
    if (!workspace) throw new Error('缺少 workspace');
    if (!guard) throw new Error('缺少 guard');
    this.workspace = workspace;
    this.guard = guard;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.timeoutMs = timeoutMs;
    this.maxOutputChars = maxOutputChars;
    this.shellPath = shellPath || ShellRunner.detectShell();
    this.scriptDir = path.join(os.tmpdir(), 'hermes-buddy-shell');
  }

  /** 只挑本机真实存在的解释器；Windows 一定自带 powershell.exe。 */
  static detectShell() {
    if (process.platform !== 'win32') return process.env.SHELL || '/bin/sh';
    for (const candidate of SHELL_CANDIDATES) {
      try {
        // where 是 Windows 自带命令，用来确认解释器在 PATH 上。
        const { execFileSync } = require('child_process');
        execFileSync('where', [candidate], { stdio: 'ignore', windowsHide: true });
        return candidate;
      } catch (_) { /* 继续找下一个 */ }
    }
    return 'powershell.exe';
  }

  get isPowerShell() { return /powershell|pwsh/i.test(path.basename(this.shellPath)); }

  /** 把命令包装成脚本：统一编码、固定工作目录、把原生命令退出码透出去。 */
  buildScript(command, cwd) {
    if (!this.isPowerShell) return command;
    const escapedCwd = String(cwd).replace(/'/g, "''");
    return [
      '$ErrorActionPreference = "Continue"',
      '$ProgressPreference = "SilentlyContinue"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      `Set-Location -LiteralPath '${escapedCwd}'`,
      '$env:HERMES_WORKSPACE = (Get-Location).Path',
      '',
      command,
      '',
      'if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'exit 0',
      ''
    ].join('\r\n');
  }

  writeScript(command, cwd) {
    fs.mkdirSync(this.scriptDir, { recursive: true });
    const file = path.join(this.scriptDir, `buddy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    // PowerShell 5.1 没有 BOM 就按系统 ANSI 读脚本，中文会直接变乱码。
    fs.writeFileSync(file, `\uFEFF${this.buildScript(command, cwd)}`, 'utf8');
    return file;
  }

  argsFor(scriptFile) {
    if (!this.isPowerShell) return [scriptFile];
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
  }

  truncate(text) {
    if (text.length <= this.maxOutputChars) return { text, truncated: false };
    const head = Math.floor(this.maxOutputChars * 0.6);
    const tail = this.maxOutputChars - head;
    return {
      text: `${text.slice(0, head)}\n\n…[输出已截断，省略 ${text.length - this.maxOutputChars} 字符]…\n\n${text.slice(-tail)}`,
      truncated: true
    };
  }

  killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      }
    } catch (_) { /* 进程已经没了 */ }
  }

  /**
   * @param {string} command
   * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal, onConfirm?: Function }} options
   */
  async run(command, options = {}) {
    const text = String(command || '').trim();
    if (!text) return { ok: false, denied: true, error: '命令为空', exitCode: null, stdout: '', stderr: '', durationMs: 0 };

    const verdict = this.guard.inspect(text);
    if (verdict.action === 'deny') {
      return { ok: false, denied: true, blocked: verdict.category, error: verdict.reason, exitCode: null, stdout: '', stderr: '', durationMs: 0 };
    }
    if (verdict.action === 'confirm') {
      const approved = typeof options.onConfirm === 'function'
        ? await options.onConfirm({ command: text, category: verdict.category, reason: verdict.reason })
        : false;
      if (!approved) {
        return { ok: false, denied: true, blocked: verdict.category, error: approved === false ? '用户取消了这条命令' : (verdict.reason || '命令未获批准'), exitCode: null, stdout: '', stderr: '', durationMs: 0 };
      }
    }

    // 工作目录永远锚在工作区内，命令里再怎么 cd 也出不去。
    let cwd = this.workspace.dir;
    if (options.cwd) cwd = this.workspace.resolve(options.cwd);

    const scriptFile = this.writeScript(text, cwd);
    const started = Date.now();
    const limit = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs;

    try {
      return await this.execute(scriptFile, cwd, limit, options.signal);
    } finally {
      try { fs.unlinkSync(scriptFile); } catch (_) { /* 清不掉就算了 */ }
    }
  }

  execute(scriptFile, cwd, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(this.shellPath, this.argsFor(scriptFile), {
        cwd,
        windowsHide: true,
        env: { ...process.env, HERMES_WORKSPACE: cwd },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child);
      }, timeoutMs);

      const onAbort = () => this.killTree(child);
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); this.killTree(child); }
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };

      // 超大数据量时直接裁剪，避免内存被一条失控命令吃光。
      child.stdout.on('data', (chunk) => { if (stdout.length < this.maxOutputChars * 4) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { if (stderr.length < this.maxOutputChars * 4) stderr += chunk.toString('utf8'); });
      child.on('error', (error) => finish(reject, error));
      child.on('close', (exitCode) => {
        const out = this.truncate(stdout);
        const err = this.truncate(stderr);
        finish(resolve, {
          ok: exitCode === 0,
          exitCode,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          durationMs: Date.now() - startedAt,
          timedOut
        });
      });
    });
  }
}

module.exports = { ShellRunner, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT, SHELL_CANDIDATES };
