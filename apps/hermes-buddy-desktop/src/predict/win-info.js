'use strict';

/**
 * Windows 前台窗口信息解析（主进程专用，Windows only）。
 *
 * iohook 只能给键鼠节奏，拿不到当前窗口的「类名/标题/进程」。本模块用 PowerShell
 * P/Invoke user32（GetForegroundWindow / GetWindowText / GetClassName）取前台窗口信息，
 * 把进程名归一成引擎能识别的 windowClass。
 *
 * 为什么要合成 class：VSCode 的真实窗口类是 Chrome_WidgetWin_1（和 Chrome 撞车），
 * 仅靠 class 无法区分「在写代码」还是「在浏览」。这里把 exe=code 映射成合成类
 * 'VSCodeIDE'，让 IDE 规则（api_lookup）命中、避免被误判为浏览器复制。
 *
 * 设计为可注入 execFileSync，便于在 node 下用假数据单测（无需真实 Windows）。
 */

const { execFileSync } = require('child_process');

/** exe 名 → 合成 windowClass（解决 VSCode/Chrome 同窗类碰撞）。 */
const EXE_TO_CLASS = {
  code: 'VSCodeIDE',
  devenv: 'VisualStudioIDE',
  idea64: 'CASCADIA_HOST',
  webstorm64: 'CASCADIA_HOST',
};

/** 真实 Win32 类名 → 逻辑名（与 config.appClassMap 对齐，便于校验）。 */
const KNOWN_CLASSES = new Set([
  'OpusApp', 'XLMainClient', 'Chrome_WidgetWin_1', 'MozillaWindowClass',
  'CASCADIA_HOST', 'VisualStudioIDE', 'VSCodeIDE',
]);

const PS_SCRIPT = [
  'Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);',
  '[DllImport("user32.dll")]public static extern int GetClassName(IntPtr h,System.Text.StringBuilder s,int n);\' -Name Win -Namespace W -PassThru | Out-Null',
  '$h=[W.Win]::GetForegroundWindow()',
  '$t=New-Object System.Text.StringBuilder 1024',
  '[W.Win]::GetWindowText($h,$t,1024) | Out-Null',
  '$title=$t.ToString()',
  '$c=New-Object System.Text.StringBuilder 1024',
  '[W.Win]::GetClassName($h,$c,1024) | Out-Null',
  '$class=$c.ToString()',
  '$proc=Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1',
  '$exe=if($proc){$proc.ProcessName}else{"unknown"}',
  '("{0}|{1}|{2}" -f $class,$title,$exe)',
].join('\n');

/**
 * 取前台窗口信息。
 * @param {{execFileSync?:function}} [opts]
 * @returns {{windowClass:string,title:string,exeName:string}|null}
 */
function getForegroundWindowInfo({ execFileSync: exec = execFileSync } = {}) {
  let raw;
  try {
    raw = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: 4000, encoding: 'utf8' });
  } catch (_) {
    return null;
  }
  const line = String(raw || '').trim();
  if (!line) return null;
  const [cls, title, exe] = line.split('|');
  const exeName = (exe || '').trim();
  const realClass = (cls && cls.trim()) || 'unknown';
  // 合成类优先：当 exe 有映射（如 VSCode 的 code.exe 真实类是 Chrome_WidgetWin_1，
  // 与 Chrome 撞车）时，用合成类区分；其余仍用真实 Win32 类名。
  const windowClass = EXE_TO_CLASS[exeName.toLowerCase()]
    ? EXE_TO_CLASS[exeName.toLowerCase()]
    : (realClass === 'unknown' ? (exeName || 'unknown') : realClass);
  return {
    windowClass: windowClass.slice(0, 128),
    title: (title || '').trim().slice(0, 256),
    exeName,
  };
}

module.exports = { getForegroundWindowInfo, EXE_TO_CLASS, KNOWN_CLASSES, PS_SCRIPT };
