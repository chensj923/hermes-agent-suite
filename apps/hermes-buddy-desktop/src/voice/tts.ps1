# Windows SAPI 文本转语音：渲染为 WAV 文件（离线，无需联网）。
# 用法：powershell -ExecutionPolicy Bypass -File tts.ps1 -Text "..." -OutWav "C:\...\a.wav" [-Voice "名"] [-Rate 0] [-Volume 100] [-Pitch "+20%"]
param(
  [Parameter(Mandatory=$true)] [string]$Text,
  [Parameter(Mandatory=$true)] [string]$OutWav,
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100,
  [string]$Pitch = ''
)
try {
  Add-Type -AssemblyName System.Speech -ErrorAction Stop
} catch {
  Write-Error "System.Speech 不可用"
  exit 2
}
try {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice) {
    try { $s.SelectVoice($Voice) } catch { /* 选不到就用默认语音 */ }
  }
  $s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $s.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
  # 父目录先建好，避免 SetOutputToWaveFile 因目录不存在失败
  $dir = Split-Path $OutWav -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $s.SetOutputToWaveFile($OutWav)

  # v4.12.22：需要变调（萝莉/甜美等音色预设）时走 SSML <prosody pitch>。
  # 老式桌面语音对 SSML 的支持程度不一，失败就退回普通 Speak，绝不因为变调而没声音。
  $spoken = $false
  if ($Pitch) {
    try {
      $esc = [System.Security.SecurityElement]::Escape([string]$Text)
      $lang = 'zh-CN'
      try { $lang = $s.Voice.Culture.Name } catch { }
      $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'><prosody pitch='$Pitch'>$esc</prosody></speak>"
      $s.SpeakSsml($ssml)
      $spoken = $true
    } catch {
      $spoken = $false
    }
  }
  if (-not $spoken) { $s.Speak([string]$Text) }
  $s.Dispose()
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 3
}
