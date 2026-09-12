'use strict';

// 命令分级守卫。设计原则：黑名单拦的是"不可恢复的系统级破坏"，
// 而不是正常的读写——否则 agent 连建个文件都要弹窗，用起来会很难受。
// 真正的边界由工作目录兜底：所有操作都被关在工作区里。
//
// 两条防误伤的硬规则：
//   1. 先剥掉引号里的内容再匹配。"git commit -m 'del 无用文件'" 里的 del 不是删除命令。
//   2. del / rm / ni / md 这类短动词必须落在"命令位置"（行首或 ; | & 之后），
//      否则路径 C:\rm\、参数 --md、变量名里同名的片段都会被误判。

const rule = (name, re) => ({ name, re });

/** 剥掉单/双引号与反引号里的内容，避免把字符串当成命令。 */
function maskStrings(text) {
  return String(text)
    .replace(/'[^'\r\n]*'/g, "''")
    .replace(/"[^"\r\n]*"/g, '""')
    .replace(/`[^`\r\n]*`/g, '``');
}

/** 短动词专用：只允许出现在命令起始位置，且后面必须跟空白。 */
function cmdVerb(word) {
  return new RegExp(String.raw`(?:^|[;|&\n])\s*${word}\s`, 'i');
}

/** 极危操作：连引号里都不允许出现，直接扫原文。 */
const RAW_FORBIDDEN = [
  // 注意别误伤 PowerShell 的 Format-Table / Format-List / Format-Wide：
  // 它们只是排版，不是格式化磁盘。所以要求 format 后面跟盘符，或者是 .com/.exe。
  rule('磁盘格式化', /(?:^|[;|&\n])\s*format(?:\.(?:com|exe))?\s+[a-z]:/i),
  rule('磁盘格式化程序', /\bformat\.(?:com|exe)\b/i),
  rule('磁盘管理破坏性命令', /\b(Format-Volume|Clear-Disk|Initialize-Disk|Set-Partition|Remove-Partition)\b/i),
  rule('磁盘分区工具', /\bdiskpart\b/i),
  rule('根目录强制删除', /\brm\s+-rf\s+(\/|\/\*|~|\/home|\/etc|\/usr|\/var|\/boot|\/system)/i),
  rule('盘符强制删除', /\bdel\s+\/f\s+\/s\s+\/q\s+[c-z]:/i),
  rule('盘符递归删除', /\bRemove-Item\b[^|;\n]*\s+(-Recurse|-r)\b[^|;\n]*\s+(c:\\|C:\\|d:\\|D:\\|\/|\\)(\s|$)/i),
  rule('启动项修改', /\b(bcdedit|bootrec|bootsect)\b/i),
  rule('卷影/备份删除', /\b(vssadmin|wbadmin)\b.*\bdelete\b/i),
  rule('证书缓存下载', /\bcertutil\b.*-urlcache/i),
  rule('BITS 下载', /\bbitsadmin\b.*\/transfer/i),
  rule('远程脚本执行', /\b(Invoke-Expression|iex)\s*\(?\s*(Invoke-WebRequest|\(Invoke-WebRequest|curl|wget)/i)
];

/** 任何权限档位都拒绝：这些操作一旦执行，用户可能救不回来。 */
const FORBIDDEN = [
  rule('注册表写入', /\b(reg|reg\.exe)\s+(delete|add)\b/i),
  rule('注册 COM 组件', /\bregsvr32\b/i),
  rule('关机/重启', /\b(Stop-Computer|Restart-Computer|shutdown(\.exe)?|init\s+[06])\b/i),
  rule('擦除空闲空间', /\b(cipher\s+\/w)\b/i),
  rule('计划任务增删', /\b(schtasks)\b.*\/(create|delete)\b/i),
  rule('系统账号变更', /\b(net\s+user|net\s+localgroup)\b/i),
  rule('系统服务变更', /\bsc(\.exe)?\s+(delete|stop|config)\b/i),
  rule('杀关键进程', /\b(taskkill)\b.*\/(f|im)\s+(winlogon|csrss|lsass|services|smss|system)/i),
  rule('WMI 破坏性调用', /\b(wmic)\b.*\b(delete|call)\b/i),
  rule('启动解释器宿主', /\bStart-Process\b[^|;\n]*\s+(powershell|pwsh|cmd(\.exe)?|wscript|cscript|mshta|rundll32)\b/i),
  rule('start 启动解释器宿主', new RegExp(String.raw`(?:^|[;|&\n])\s*start\s+[^\n]*\s(powershell|pwsh|cmd(\.exe)?|wscript|cscript|mshta|rundll32)(\s|$)`, 'i'))
];

/** 删除类：读写档默认要用户点头。 */
const DELETE = [
  rule('PowerShell 删除', /\bRemove-Item\b/i),
  rule('删除目录', /\brmdir\b/i),
  rule('rd /s', /\brd\s+\/s\b/i),
  rule('rm 命令', cmdVerb('rm')),
  rule('del 命令', cmdVerb('del')),
  rule('erase 命令', cmdVerb('erase')),
  rule('git clean', /\b(git\s+clean)\b/i),
  rule('git reset --hard', /\b(git\s+reset\s+--hard)\b/i),
  rule('清空内容/回收站', /\bClear-(Content|RecycleBin)\b/i)
];

/** 写入类：只读档直接拒绝。 */
const WRITE = [
  rule('New-Item', /\bNew-Item\b/i),
  rule('Set-Content', /\bSet-Content\b/i),
  rule('Add-Content', /\bAdd-Content\b/i),
  rule('Out-File', /\bOut-File\b/i),
  rule('Copy-Item', /\bCopy-Item\b/i),
  rule('Move-Item', /\bMove-Item\b/i),
  rule('Rename-Item', /\bRename-Item\b/i),
  rule('mkdir', /\bmkdir\b/i),
  rule('md 命令', cmdVerb('md')),
  // 重定向：前面不能是 - = < ! |，否则 -gt、=>、->、|> 这些比较/箭头符号会被误判
  rule('输出重定向 >', /(?<![\->=<!|])(?:>>|>)\s*\S+/),
  rule('tee', /\btee\b/i),
  rule('sed -i', /\bsed\s+-i\b/i),
  rule('git 写操作', /\bgit\s+(commit|push|checkout|restore|stash|merge|rebase|apply)\b/i),
  rule('npm 写操作', /\bnpm\s+(install|run|publish)\b/i),
  rule('pip install', /\bpip\s+install\b/i),
  rule('cargo build', /\bcargo\s+build\b/i)
];

// 兼容旧导出名
const FORBIDDEN_PATTERNS = RAW_FORBIDDEN.concat(FORBIDDEN).map((r) => r.re);
const DELETE_PATTERNS = DELETE.map((r) => r.re);
const WRITE_PATTERNS = WRITE.map((r) => r.re);
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
   * @returns {{ action: 'allow'|'confirm'|'deny', category: 'read'|'write'|'delete'|'forbidden', reason?: string, rule?: string }}
   */
  inspect(command) {
    const text = String(command || '').trim();
    if (!text) return { action: 'deny', category: 'read', reason: '命令为空' };
    // 多行脚本逐行看，避免一行合法掩盖下一行越界；但换行本身不拒绝。
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const masked = lines.map(maskStrings);

    const forbid = (hit) => ({
      action: 'deny',
      category: 'forbidden',
      reason: `该命令属于高危系统操作，已被 Buddy 永久禁止（命中规则：${hit.name}）`,
      rule: hit.name
    });

    // 1) 极危：扫原文
    for (const line of lines) {
      const hit = RAW_FORBIDDEN.find((r) => r.re.test(line));
      if (hit) return forbid(hit);
    }
    // 2) 高危：扫剥离引号后的文本
    for (const line of masked) {
      const hit = FORBIDDEN.find((r) => r.re && r.re.test(line));
      if (hit) return forbid(hit);
    }
    // 3) 删除类
    for (const line of masked) {
      const hit = DELETE.find((r) => r.re.test(line));
      if (!hit) continue;
      if (this.permission === 'read') {
        return { action: 'deny', category: 'delete', reason: `只读模式下禁止删除操作（命中规则：${hit.name}）`, rule: hit.name };
      }
      if (this.confirmDeletes) {
        return { action: 'confirm', category: 'delete', reason: `删除操作需要确认（命中规则：${hit.name}）`, rule: hit.name };
      }
      return { action: 'allow', category: 'delete', rule: hit.name };
    }
    // 4) 写入类
    for (const line of masked) {
      const hit = WRITE.find((r) => r.re.test(line));
      if (!hit) continue;
      if (this.permission === 'read') {
        return { action: 'deny', category: 'write', reason: `只读模式下禁止写入操作（命中规则：${hit.name}）`, rule: hit.name };
      }
      return { action: 'allow', category: 'write', rule: hit.name };
    }
    return { action: 'allow', category: 'read' };
  }
}

module.exports = {
  CommandGuard,
  FORBIDDEN_PATTERNS,
  DELETE_PATTERNS,
  WRITE_PATTERNS,
  PERMISSION_LEVELS,
  // 便于排查：直接给出某条命令命中了哪条规则
  explain(command) {
    return new CommandGuard().inspect(command);
  }
};
