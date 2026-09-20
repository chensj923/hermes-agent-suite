# v4.10.27: 捕获「用户真正在用的目标窗口」句柄（HWND），供后续直接插入内容。
#
# 为什么必须在触发/点击的那一刻就调用：
#   流水线一旦开始，浮窗 show() 会 win.focus() 把前台抢走；用户再点「生成并插入」
#   又把前台变成浮窗。等到打字时再 GetForegroundWindow()，拿到的是 Buddy 自己，
#   内容就敲进了空处。所以要在前台还是用户文档窗口时先把 HWND 存下来。
#
# 输出：单行 JSON {"hwnd":123,"pid":456,"title":"文档名 - WPS 文字"}，找不到时输出 null。

param([int]$buddyPid = 0)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TW {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@

function Get-Pid([IntPtr]$h) {
  $p = 0
  [void][TW]::GetWindowThreadProcessId($h, [ref]$p)
  return [int]$p
}
function Get-Title([IntPtr]$h) {
  $len = [TW]::GetWindowTextLength($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][TW]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
# 候选窗口：存在 + 可见 + 有标题 + 不属于 Buddy 自己
function Test-Candidate([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  if (-not [TW]::IsWindow($h)) { return $false }
  if (-not [TW]::IsWindowVisible($h)) { return $false }
  if ([TW]::GetWindowTextLength($h) -eq 0) { return $false }
  if ($buddyPid -gt 0 -and (Get-Pid $h) -eq $buddyPid) { return $false }
  return $true
}

$target = [IntPtr]::Zero
$fg = [TW]::GetForegroundWindow()
if (Test-Candidate $fg) {
  $target = $fg
} else {
  # 前台是 Buddy 自己（点按钮/点桌宠触发）或无效窗口：沿 Z 序往下找用户上一个窗口
  $cur = $fg
  for ($i = 0; $i -lt 30; $i++) {
    $cur = [TW]::GetWindow($cur, 2)   # GW_HWNDNEXT
    if ($cur -eq [IntPtr]::Zero) { break }
    if (Test-Candidate $cur) { $target = $cur; break }
  }
}

if ($target -eq [IntPtr]::Zero) { Write-Output 'null'; exit 0 }

$o = [PSCustomObject]@{
  hwnd  = [int64]$target
  pid   = (Get-Pid $target)
  title = (Get-Title $target)
}
Write-Output ($o | ConvertTo-Json -Compress)
