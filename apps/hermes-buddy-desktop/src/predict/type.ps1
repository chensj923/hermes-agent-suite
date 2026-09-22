# v4.10.26: Direct keyboard input via Win32 SendInput (KEYEVENTF_UNICODE)
# Reads UTF-8 text from stdin, types it into the TARGET window.
# 关键：点「生成并插入」时前台是 Buddy 自己，所以先沿 Z 序找回用户真正
# 在用的上一个窗口（排除 Buddy 进程自身的窗口），把键盘焦点交还给它再打字。
# No clipboard involved -- content goes straight into the target app.
# Fails silently -- caller logs the failure.

# v4.10.27：-targetHwnd 由控制器在「触发的那一刻」捕获并传入（见 foreground.ps1）。
# 有它就直接用——比打字时再沿 Z 序猜可靠得多（那时前台常已被浮窗/主窗口抢走）。
# 没给（老调用方/捕获失败）才回退到 Z 序遍历。
param([int]$buddyPid = 0, [int]$targetHwnd = 0)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KS2 {
  [DllImport("user32.dll")]
  public static extern uint SendInput(uint n, INPUT[] i, int s);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  // v4.10.32：PowerShell 5.1 里 Marshal.SizeOf([KS2+INPUT]) 会把类型字面量绑定到
  // SizeOf(object) 重载，抛“RuntimeType 不能作为非托管结构封送”→ 脚本 exit 1，
// type/paste 注入从 v4.10.26 起一直静默失败。改为 C# 侧编译期 typeof 取尺寸。
  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public MOUSEKEYBDHARDWAREINPUT u;
  }
  // v4.10.32：补全官方 union（MOUSEINPUT 是最大成员 32 字节），
  // 否则托管 INPUT 只有 32 字节，与原生 sizeof(INPUT)=40(x64) 不符，SendInput 直接拒绝。
  [StructLayout(LayoutKind.Explicit)]
  public struct MOUSEKEYBDHARDWAREINPUT {
    [FieldOffset(0)]
    public KEYBDINPUT ki;
    [FieldOffset(0)]
    public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
}
"@

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()

if ([string]::IsNullOrEmpty($text)) { exit 0 }

# ---------- v4.10.26：把键盘焦点交还给真正的工作窗口 ----------
function Get-WindowPid([IntPtr]$h) {
  $pid2 = 0
  [void][KS2]::GetWindowThreadProcessId($h, [ref]$pid2)
  return $pid2
}
function Activate-Window([IntPtr]$t) {
  if ($t -eq [IntPtr]::Zero) { return $false }
  if ([KS2]::IsIconic($t)) { [void][KS2]::ShowWindow($t, 9) }  # SW_RESTORE
  $fg = [KS2]::GetForegroundWindow()
  $a = 0; $b = 0
  [void][KS2]::GetWindowThreadProcessId($fg, [ref]$a)
  [void][KS2]::GetWindowThreadProcessId($t, [ref]$b)
  if ($a -ne $b) { [void][KS2]::AttachThreadInput($a, $b, $true) }
  [void][KS2]::SetForegroundWindow($t)
  [void][KS2]::BringWindowToTop($t)
  if ($a -ne $b) { [void][KS2]::AttachThreadInput($a, $b, $false) }
  Start-Sleep -Milliseconds 220
  return ([KS2]::GetForegroundWindow() -eq $t)
}

$target = [IntPtr]::Zero
# 1) 优先用触发时捕获的句柄（v4.10.27）
if ($targetHwnd -ne 0) {
  $h = [IntPtr]$targetHwnd
  if ([KS2]::IsWindow($h) -and [KS2]::IsWindowVisible($h)) {
    $hp = Get-WindowPid $h
    if (-not ($buddyPid -gt 0 -and $hp -eq $buddyPid)) { $target = $h }
  }
}
# 2) 回退：沿 Z 序往下找第一个「可见、有标题、且不属于 Buddy 自己」的窗口
if ($target -eq [IntPtr]::Zero) {
  $cur = [KS2]::GetForegroundWindow()
  for ($i = 0; $i -lt 30; $i++) {
    $cur = [KS2]::GetWindow($cur, 2)  # GW_HWNDNEXT
    if ($cur -eq [IntPtr]::Zero) { break }
    if (-not [KS2]::IsWindowVisible($cur)) { continue }
    $p = Get-WindowPid $cur
    if ($buddyPid -gt 0 -and $p -eq $buddyPid) { continue }   # 跳过 Buddy 自身的窗口
    if ([KS2]::GetWindowTextLength($cur) -eq 0) { continue }  # 跳过无标题的隐藏/工具窗口
    $target = $cur
    break
  }
}
# v4.10.36：激活后必须确认前台确实是目标窗口，且做少量重试。
# 旧逻辑焦点没切成功只 sleep 一下就继续打字，317 个键事件全部发给了
# 当时真正在前台的窗口（Buddy 自己，被丢弃），脚本却 exit 0 谎报成功，
# 控制器因此不回退粘贴——用户既看不到字、剪贴板也没有内容。
$focusOk = $false
if ($target -ne [IntPtr]::Zero) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $ok = Activate-Window $target
    if ($ok -and ([KS2]::GetForegroundWindow() -eq $target)) { $focusOk = $true; break }
    Start-Sleep -Milliseconds 150
  }
}
# 拿不到目标焦点：绝不盲打。exit 2 让调用方回退到剪贴板粘贴；
# 粘贴也失败则内容留在剪贴板，通知用户手动 Ctrl+V（内容不会丢）。
if (-not $focusOk) {
  [Console]::Error.WriteLine('target window could not be brought to foreground; abort typing to avoid sending keys elsewhere')
  exit 2
}

$UNICODE = 0x0004   # KEYEVENTF_UNICODE
$KEYUP   = 0x0002   # KEYEVENTF_KEYUP
$VK_RETURN = 0x0D
$VK_TAB    = 0x09
$script:sendFailures = 0   # v4.10.36：统计被系统拒绝的 SendInput 次数

function Send-Char([ushort]$code, [bool]$isSpecialKey) {
  $down = [KS2+INPUT]::new()
  $down.type = 1
  if ($isSpecialKey) {
    $down.u.ki.wVk = $code
    $down.u.ki.dwFlags = 0
  } else {
    $down.u.ki.wScan = $code
    $down.u.ki.dwFlags = $UNICODE
  }
  $up = [KS2+INPUT]::new()
  $up.type = 1
  if ($isSpecialKey) {
    $up.u.ki.wVk = $code
    $up.u.ki.dwFlags = $KEYUP
  } else {
    $up.u.ki.wScan = $code
    $up.u.ki.dwFlags = $UNICODE -bor $KEYUP
  }
  $arr = @($down, $up)
  # v4.10.32：SizeOf 改走 C# InputSize()（见类注释）；SendInput 返回 0 说明注入被拒（UIPI/安全软件）
  # v4.10.36：累计失败次数，结束后用非零码告知调用方，不再谎报成功。
  $sent = [KS2]::SendInput(2, $arr, [KS2]::InputSize())
  if ($sent -eq 0) {
    $script:sendFailures++
    [Console]::Error.WriteLine('SendInput returned 0 (blocked by UIPI or security software)')
  }
  $sent | Out-Null
}

# Normalize newlines, then type in batches with tiny sleeps so target apps keep up
$text = $text -replace "`r`n", "`n"
$chars = $text.ToCharArray()
$batch = 0
foreach ($c in $chars) {
  # v4.10.36：打字途中若焦点被抢走（前台不再是目标），立即停止，
  # 避免剩余字符继续打错窗口；以 exit 2 触发上层回退。
  if (($batch % 30) -eq 0 -and ([KS2]::GetForegroundWindow() -ne $target)) {
    [Console]::Error.WriteLine('foreground changed mid-typing; abort to avoid sending keys to the wrong window')
    exit 2
  }
  $code = [ushort][int]$c
  if ($c -eq "`n") {
    Send-Char $VK_RETURN $true
  } elseif ($c -eq "`t") {
    Send-Char $VK_TAB $true
  } elseif ($code -lt 32) {
    # skip other control chars
  } else {
    Send-Char $code $false
    # surrogate pair low surrogate follows high surrogate automatically as unicode events
  }
  $batch++
  if ($batch -ge 30) {
    Start-Sleep -Milliseconds 12
  }
}

# v4.10.36：有任何一次 SendInput 被系统拒绝都按失败处理（exit 3），
# 让调用方回退粘贴 / 保留剪贴板，而不是误以为整段已输入。
if ($script:sendFailures -gt 0) { exit 3 }
exit 0
