# v4.10.10: Simulate Ctrl+V paste via Win32 SendInput
# Called by action-executor.js after writing content to clipboard.
# Fails silently -- clipboard already has content, user can Ctrl+V manually.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KS {
  [DllImport("user32.dll")]
  public static extern uint SendInput(uint n, INPUT[] i, int s);
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
