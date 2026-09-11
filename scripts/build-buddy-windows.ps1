$ErrorActionPreference = 'Stop'

# === Build-time environment hardening ===
# 1) 继承来的 ELECTRON_RUN_AS_NODE 会让 electron-builder 的 electron 探测走偏，先清掉。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 2) Claude/CodeBuddy 会话变量，保留默认值即可，不必动 safe-delete（见下方说明）。
Remove-Item Env:CLAUDE_SESSION_ID -ErrorAction SilentlyContinue

$env:NODE_OPTIONS = '--use-system-ca'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# 3) electron-builder 内部用 which.sync('npm') 解析路径，在默认 Windows PATHEXT 下会优先命中
# `npm.ps1`（PowerShell shim）。spawn PowerShell 跑 .ps1 时它会触发 "$LASTEXITCODE 未设置" 错误并
# 把 stdout 全吞光，触发 `NpmNodeModulesCollector: No JSON content found in output`。
# 把 PATHEXT 收成 .COM;.EXE;.BAT;.CMD 后 which 会选到 npm.cmd，问题消失。
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'

# 4) electron-builder 默认把输出写到 apps/hermes-buddy-desktop/dist/，但该目录在 SynologyDrive 同步锁
# 下经常删除失败；而且 WorkBuddy 的 safe-delete shim 会拦截 Remove-Item 并 fail-closed（trash 失败就拒删）。
# 所以这里把输出改到 %TEMP%，构建成功后「直接覆盖同名文件」回拷，全程不触发任何删除。
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$buddyDir = Join-Path $repoRoot 'apps/hermes-buddy-desktop'
$outDir = Join-Path $env:TEMP ("hermes-buddy-build-{0}-{1:yyyyMMdd-HHmmss}" -f (Get-Content (Join-Path $buddyDir 'package.json') | ConvertFrom-Json).version, (Get-Date))
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$distOut = Join-Path $outDir 'dist'

Push-Location $buddyDir
try {
  npm run build:win --workspace=@hermes/buddy-desktop -- --config.directories.output=$distOut
  if ($LASTEXITCODE -ne 0) { throw "build:win failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

# 5) 回拷到 apps/hermes-buddy-desktop/dist/（只覆盖 installer / blockmap / latest.yml，不做任何删除）
$localDist = Join-Path $buddyDir 'dist'
if (-not (Test-Path $localDist)) { New-Item -ItemType Directory -Path $localDist | Out-Null }
$installer = Get-ChildItem -LiteralPath $distOut -Filter 'hermes-suite-windows-x86_64.exe' -File | Select-Object -First 1
if (-not $installer) { throw "installer not found in build output: $distOut" }
Copy-Item -LiteralPath $installer.FullName -Destination $localDist -Force
$blockmap = $installer.FullName + '.blockmap'
if (Test-Path $blockmap) { Copy-Item -LiteralPath $blockmap -Destination $localDist -Force }
$latestYml = Join-Path $distOut 'latest.yml'
if (Test-Path $latestYml) { Copy-Item -LiteralPath $latestYml -Destination $localDist -Force }
$finalExe = Join-Path $localDist $installer.Name
if (-not (Test-Path $finalExe)) { throw "installer not found at expected location: $finalExe" }
Write-Host ("installer: {0}  size={1:N0} bytes" -f $finalExe, (Get-Item $finalExe).Length)
