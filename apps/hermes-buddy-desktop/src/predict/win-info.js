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
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowTextW(IntPtr h,System.Text.StringBuilder s,int n);',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassNameW(IntPtr h,System.Text.StringBuilder s,int n);\' -Name Win -Namespace W -PassThru | Out-Null',
  '$h=[W.Win]::GetForegroundWindow()',
  '$t=New-Object System.Text.StringBuilder 1024',
  '[W.Win]::GetWindowTextW($h,$t,1024) | Out-Null',
  '$title=$t.ToString()',
  '$c=New-Object System.Text.StringBuilder 1024',
  '[W.Win]::GetClassNameW($h,$c,1024) | Out-Null',
  '$class=$c.ToString()',
  '$proc=Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1',
  '$exe=if($proc){$proc.ProcessName}else{"unknown"}',
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
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

/**
 * v4.10.12：从窗口标题反推应用身份。
 *
 * 为什么需要它：主动点猫时，用户刚点了桌宠，OS 前台窗口就是桌宠自己
 * （exeName="Hermes Buddy"，真实窗口类 Chrome_WidgetWin_1 → 被归成 browser →
 * reading_or_thinking），resolveWindow() 拿到的是桌宠身份，导致规则推断与远端模型
 * 都把场景误判成「阅读思考」，给出「需要我帮你梳理思路吗」这类泛化话术。
 *
 * 但 capture 在隐藏本应用窗口后截到的，是用户真正在用的窗口（如
 * "Hermes-buddy4.5使用结论： - WPS 文字"）。用标题里的应用特征词反推
 * {exeName, windowClass, app}，在主动预测时覆盖桌宠前台身份，让规则推断与远端模型
 * 正确识别「正在 WPS 写文档」。
 *
 * 注意：标题里可能出现 "Hermes"（如文档名 "Hermes-buddy4.5使用结论："），但 capture
 * 选源时已用 /hermes-buddy|桌宠|buddy/i 把桌宠窗口排除在外，能进到这里的 shotSource
 * 一定是真实业务窗口，因此本函数不再做 self 过滤，避免把"文档名含 Hermes"误判成桌宠。
 *
 * @param {string} title 窗口标题（desktopCapturer 源名，通常是 "文档名 - 应用名"）
 * @returns {{exeName:string, windowClass:string, app:string, title:string}|null}
 */
function titleToApp(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return null;
  // 顺序：先精确（WPS 三件套 / Office / IDE），后宽泛（浏览器）。
  // 关键词尽量只命中应用名，避免误伤文档名里出现的字（如 "code" 仅当伴随 VSCode 时命中）。
  if (/wps\s*文字|wps文字|金山/.test(t)) return { exeName: 'wps', windowClass: 'Wps_Application', app: 'word', title };
  if (/wps\s*表格|wps表格|kingsoft.*\bet\b/.test(t)) return { exeName: 'et', windowClass: 'ETMainClass', app: 'excel', title };
  if (/wps\s*演示|wps演示|\bwpp\b/.test(t)) return { exeName: 'wpp', windowClass: 'PPTFrameClass', app: 'ppt', title };
  if (/\bword\b|winword|microsoft word/.test(t)) return { exeName: 'winword', windowClass: 'OpusApp', app: 'word', title };
  if (/\bexcel\b/.test(t)) return { exeName: 'excel', windowClass: 'XLMainClient', app: 'excel', title };
  if (/powerpoint|\bppt\b/.test(t)) return { exeName: 'powerpnt', windowClass: 'PPTFrameClass', app: 'ppt', title };
  if (/visual studio code|vscode/.test(t)) return { exeName: 'code', windowClass: 'VSCodeIDE', app: 'vscode', title };
  if (/pdf|acrobat|foxit|sumatra/.test(t)) return { exeName: 'AcroRd32', windowClass: 'AcrobatSDIWindow', app: 'pdf', title };
  if (/微信|wechat|企业微信|wework|\bqq\b/.test(t)) return { exeName: 'wechat', windowClass: 'WeChatMainWndForPC', app: 'im', title };
  if (/终端|windows terminal|mintty|powershell|cmd\.exe/.test(t)) return { exeName: 'WindowsTerminal', windowClass: 'ConsoleWindowClass', app: 'terminal', title };
  if (/chrome|edge|浏览器|firefox|360se|qq浏览器/.test(t)) return { exeName: 'chrome', windowClass: 'Chrome_WidgetWin_1', app: 'browser', title };
  if (/visual studio|devenv/.test(t)) return { exeName: 'devenv', windowClass: 'VisualStudioIDE', app: 'ide', title };
  return null;
}

module.exports = { getForegroundWindowInfo, EXE_TO_CLASS, KNOWN_CLASSES, PS_SCRIPT, titleToApp };
