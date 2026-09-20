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
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public MOUSEKEYBDHARDWAREINPUT u;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct MOUSEKEYBDHARDWAREINPUT {
    [FieldOffset(0)]
    public KEYBDINPUT ki;
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
if ($target -ne [IntPtr]::Zero) {
  $ok = Activate-Window $target
  if (-not $ok) { Start-Sleep -Milliseconds 200 }  # 焦点没切成就再缓一下，不阻断
}

$UNICODE = 0x0004   # KEYEVENTF_UNICODE
$KEYUP   = 0x0002   # KEYEVENTF_KEYUP
$VK_RETURN = 0x0D
$VK_TAB    = 0x09

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
  [KS2]::SendInput(2, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([KS2+INPUT])) | Out-Null
}

# Normalize newlines, then type in batches with tiny sleeps so target apps keep up
$text = $text -replace "`r`n", "`n"
$chars = $text.ToCharArray()
$batch = 0
foreach ($c in $chars) {
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
    $batch = 0
  }
}
