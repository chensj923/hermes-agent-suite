# 枚举 Windows SAPI 已安装语音（TTS 语音选择用）。输出 JSON 数组到 stdout。
# 用法：powershell -ExecutionPolicy Bypass -File list-voices.ps1
param()
try {
  Add-Type -AssemblyName System.Speech -ErrorAction Stop
} catch {
  Write-Output '[]'
  exit 0
}
try {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $out = @()
  foreach ($v in $s.GetInstalledVoices()) {
    $info = $v.VoiceInfo
    $out += [PSCustomObject]@{
      Name    = $info.Name
      Id      = $info.Id
      Culture = $info.Culture.Name
      Gender  = $info.Gender
    }
  }
  $s.Dispose()
  $out | ConvertTo-Json -Compress
} catch {
  Write-Output '[]'
}
