# v4.12.8：常驻前台窗口监视器。
#
# 为什么需要它（替代 behavior-hooks 里「每 800ms 冷启动一个 powershell」的做法）：
#   旧逻辑每秒都 fork 一个全新 powershell.exe（冷启动 0.5~1s + P/Invoke），是
#   「打开推理模式起整机就微卡」的根因。本脚本只启动一次，进程内部用 300ms 间隔
#   轮询 GetForegroundWindow，仅当 HWND 变化时才输出一行 JSON：
#     {"hwnd":123,"pid":456,"title":"...","class":"...","exe":"..."}
#   Node 端读 stdout 的行，更新内存最新值即可，运行期间零进程创建、零冷启动开销。
#
# 退出：stdin 关闭 / 收到 EOF / 进程被杀时自动结束（由 Node 端生命周期管理）。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@

# 进程名查询：用 PID 取一次 Process（不遍历全表，开销极小）。失败返回 "unknown"。
function Get-Exe([IntPtr]$h) {
  $p = 0
  [void][FW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -le 0) { return @{ pid = 0; exe = "unknown" } }
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById([int]$p)
    return @{ pid = [int]$p; exe = $proc.ProcessName }
  } catch {
    return @{ pid = [int]$p; exe = "unknown" }
  }
}

$lastHwnd = [IntPtr]::Zero
# 启动即报一次当前前台，之后仅在 HWND 变化时输出。
while ($true) {
  $h = [FW]::GetForegroundWindow()
  if ($h -ne $lastHwnd) {
    $lastHwnd = $h
    $sb = New-Object System.Text.StringBuilder 512
    [void][FW]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    $cb = New-Object System.Text.StringBuilder 256
    [void][FW]::GetClassName($h, $cb, $cb.Capacity)
    $class = $cb.ToString()
    $info = Get-Exe $h
    $o = [PSCustomObject]@{
      hwnd  = [int64]$h
      pid   = $info.pid
      title = $title
      class = $class
      exe   = $info.exe
    }
    Write-Output ($o | ConvertTo-Json -Compress)
  }
  Start-Sleep -Milliseconds 300
}
