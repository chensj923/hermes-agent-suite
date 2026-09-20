# v4.10.24: Direct keyboard input via Win32 SendInput (KEYEVENTF_UNICODE)
# Reads UTF-8 text from stdin, types it into the foreground window.
# No clipboard involved -- content goes straight into the target app.
# Fails silently -- caller logs the failure.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KS2 {
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

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()

if ([string]::IsNullOrEmpty($text)) { exit 0 }

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
