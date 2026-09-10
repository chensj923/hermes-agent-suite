'use strict';

// 命令分级守卫。设计原则：黑名单拦的是"不可恢复的系统级破坏"，
// 而不是正常的读写——否则 agent 连建个文件都要弹窗，用起来会很难受。
// 真正的边界由工作目录兜底：所有操作都被关在工作区里。

/** 任何权限档位都拒绝：这些操作一旦执行，用户可能救不回来。 */
const FORBIDDEN_PATTERNS = [
  /\bformat(\.(com|exe))?\b/i,
  /\bdiskpart\b/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[c-z]:/i,
  /\brm\s+-rf\s+(\/|\/\*|~|\/home|\/etc|\/usr|\/var|\/boot|\/system)/i,
  /\bRemove-Item\b[^|;\n]*\s+(-Recurse|-r)\b[^|;\n]*\s+(c:\\|C:\\|d:\\|D:\\|\/|\\)(\s|$)/i,
  /\b(reg|reg\.exe)\s+(delete|add)\b/i,
  /\bregsvr32\b/i,
  /\b(Stop-Computer|Restart-Computer|shutdown(\.exe)?|init\s+[06])\b/i,
  /\b(Set-ExecutionPolicy)\b/i,
  /\b(takeown|icacls)\b/i,
  /\b(cipher\s+\/w)\b/i,
  /\b(bcdedit|bootrec|bootsect)\b/i,
  /\b(schtasks)\b.*\/(create|delete)\b/i,
  /\b(net\s+user|net\s+localgroup)\b/i,
  /\b(sc(\.exe)?\s+(delete|stop|config))\b/i,
  /\b(taskkill)\b.*\/(f|im)\s+(winlogon|csrss|lsass|services|smss|system)/i,
  /\bcertutil\b.*-urlcache/i,
  /\bbitsadmin\b.*\/transfer/i,
  /\b(Invoke-Expression|iex)\s*\(?\s*(Invoke-WebRequest|\(Invoke-WebRequest|curl|wget)/i,
  /\bStart-Process\b[^|;\n]*\s+(powershell|cmd|pwsh|wscript|cscript|mshta|rundll32)\b/i,
  /\b(wmic)\b.*\b(delete|call)\b/i,
  /\b(vssadmin)\b.*\bdelete\b/i,
  /\b(wbadmin)\b.*\bdelete\b/i
];

/** 删除类：读写档默认要用户点头。 */
const DELETE_PATTERNS = [
  /\bRemove-Item\b/i, /\brm\s+-r?f?\b/i, /\brmdir\b/i, /\brd\s+\/s\b/i,
  /\bdel\b/i, /\berase\b/i, /\brm\b/i, /\b(git\s+clean)\b/i,
  /\b(git\s+reset\s+--hard)\b/i, /\bClear-(Content|RecycleBin)\b/i
];

/** 写入类：只读档直接拒绝。 */
const WRITE_PATTERNS = [
  /\bNew-Item\b/i, /\bSet-Content\b/i, /\bAdd-Content\b/i, /\bOut-File\b/i,
  /\bCopy-Item\b/i, /\bMove-Item\b/i, /\bRename-Item\b/i, /\bmkdir\b/i, /\bmd\b/i,
  /\bni\b/i, /\bsc\b(?=\s)/i,
  /\becho\s*>/, />\s*\S+/, />>\s*\S+/,
  /\btee\b/i, /\bsed\s+-i\b/i, /\bgit\s+(commit|push|checkout|restore|stash|merge|rebase|apply)\b/i,
  /\bnpm\s+(install|run|publish)\b/i, /\bpip\s+install\b/i, /\bcargo\s+build\b/i
];

const PERMISSION_LEVELS = Object.freeze(['read', 'read-write', 'full']);

class CommandGuard {
  constructor({ permission = 'read-write', confirmDeletes = true } = {}) {
    this.permission = PERMISSION_LEVELS.includes(permission) ? permission : 'read-write';
    this.confirmDeletes = confirmDeletes;
  }

  setPermission(level) {
    if (!PERMISSION_LEVELS.includes(level)) throw new Error(`未知权限档位: ${level}`);
    this.permission = level;
    return this.permission;
  }

  /**
   * @returns {{ action: 'allow'|'confirm'|'deny', category: 'read'|'write'|'delete'|'forbidden', reason?: string }}
   */
  inspect(command) {
    const text = String(command || '').trim();
    if (!text) return { action: 'deny', category: 'read', reason: '命令为空' };
    // 多行脚本逐行看，避免一行合法掩盖下一行越界；但换行本身不拒绝。
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(line))) {
        return { action: 'deny', category: 'forbidden', reason: '该命令属于高危系统操作，已被 Buddy 永久禁止' };
      }
    }
    for (const line of lines) {
      if (DELETE_PATTERNS.some((pattern) => pattern.test(line))) {
        if (this.permission === 'read') return { action: 'deny', category: 'delete', reason: '只读模式下禁止删除操作' };
        if (this.confirmDeletes) return { action: 'confirm', category: 'delete', reason: '删除操作需要确认' };
        return { action: 'allow', category: 'delete' };
      }
    }
    for (const line of lines) {
      if (WRITE_PATTERNS.some((pattern) => pattern.test(line))) {
        if (this.permission === 'read') return { action: 'deny', category: 'write', reason: '只读模式下禁止写入操作' };
        return { action: 'allow', category: 'write' };
      }
    }
    return { action: 'allow', category: 'read' };
  }
}

module.exports = { CommandGuard, FORBIDDEN_PATTERNS, DELETE_PATTERNS, WRITE_PATTERNS, PERMISSION_LEVELS };
