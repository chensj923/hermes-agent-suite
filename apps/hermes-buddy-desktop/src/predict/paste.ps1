# v4.10.26: Simulate Ctrl+V paste via Win32 SendInput
# Called by action-executor.js after writing content to clipboard.
# 关键：和 type.ps1 一样，先把键盘焦点交还给用户真正在用的上一个窗口
# （排除 Buddy 进程自身），否则 Ctrl+V 会粘到 Buddy 自己身上。
# Fails silently -- clipboard already has content, user can Ctrl+V manually.

# v4.10.27：-targetHwnd 由控制器在触发那一刻捕获并传入（见 foreground.ps1），优先使用。
param([int]$buddyPid = 0, [int]$targetHwnd = 0)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KS {
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

# ---------- v4.10.26：把键盘焦点交还给真正的工作窗口 ----------
function Get-WindowPid([IntPtr]$h) {
  $pid2 = 0
  [void][KS]::GetWindowThreadProcessId($h, [ref]$pid2)
  return $pid2
}
$target = [IntPtr]::Zero
# 1) 优先用触发时捕获的句柄（v4.10.27）
if ($targetHwnd -ne 0) {
  $h = [IntPtr]$targetHwnd
  if ([KS]::IsWindow($h) -and [KS]::IsWindowVisible($h)) {
    $hp = Get-WindowPid $h
    if (-not ($buddyPid -gt 0 -and $hp -eq $buddyPid)) { $target = $h }
  }
}
# 2) 回退：沿 Z 序找用户上一个窗口
if ($target -eq [IntPtr]::Zero) {
  $cur = [KS]::GetForegroundWindow()
  for ($i = 0; $i -lt 30; $i++) {
    $cur = [KS]::GetWindow($cur, 2)  # GW_HWNDNEXT
    if ($cur -eq [IntPtr]::Zero) { break }
    if (-not [KS]::IsWindowVisible($cur)) { continue }
    $p = Get-WindowPid $cur
    if ($buddyPid -gt 0 -and $p -eq $buddyPid) { continue }
    if ([KS]::GetWindowTextLength($cur) -eq 0) { continue }
    $target = $cur
    break
  }
}
if ($target -ne [IntPtr]::Zero) {
  if ([KS]::IsIconic($target)) { [void][KS]::ShowWindow($target, 9) }
  $fg = [KS]::GetForegroundWindow()
  $a = 0; $b = 0
  [void][KS]::GetWindowThreadProcessId($fg, [ref]$a)
  [void][KS]::GetWindowThreadProcessId($target, [ref]$b)
  if ($a -ne $b) { [void][KS]::AttachThreadInput($a, $b, $true) }
  [void][KS]::SetForegroundWindow($target)
  [void][KS]::BringWindowToTop($target)
  if ($a -ne $b) { [void][KS]::AttachThreadInput($a, $b, $false) }
  Start-Sleep -Milliseconds 250
}

$VK_CTRL = 0x11
$VK_V = 0x56
$UP = 0x0002

$inputs = @(
  [KS+INPUT]::new(),
  [KS+INPUT]::new(),
  [KS+INPUT]::new(),
  [KS+INPUT]::new()
)
$inputs[0].type = 1  # KEYBOARD
$inputs[0].u.ki.wVk = $VK_CTRL
$inputs[0].u.ki.dwFlags = 0
$inputs[1].type = 1
$inputs[1].u.ki.wVk = $VK_V
$inputs[1].u.ki.dwFlags = 0
$inputs[2].type = 1
$inputs[2].u.ki.wVk = $VK_V
$inputs[2].u.ki.dwFlags = $UP
$inputs[3].type = 1
$inputs[3].u.ki.wVk = $VK_CTRL
$inputs[3].u.ki.dwFlags = $UP

[KS]::SendInput(4, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([KS+INPUT]))
