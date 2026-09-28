# Windows SAPI 文本转语音：渲染为 WAV 文件（离线，无需联网）。
# 用法：powershell -ExecutionPolicy Bypass -File tts.ps1 -Text "..." -OutWav "C:\...\a.wav" [-Voice "名"] [-Rate 0] [-Volume 100]
param(
  [Parameter(Mandatory=$true)] [string]$Text,
  [Parameter(Mandatory=$true)] [string]$OutWav,
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100
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
  $s.Speak([string]$Text)
  $s.Dispose()
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 3
}
