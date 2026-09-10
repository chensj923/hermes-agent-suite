$ErrorActionPreference = 'Stop'
# 继承来的 ELECTRON_RUN_AS_NODE 会让 electron-builder 的 electron 探测走偏，先清掉。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:NODE_OPTIONS = '--use-system-ca'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:win --workspace=@hermes/buddy-desktop
if ($LASTEXITCODE -ne 0) { throw "build:win failed with exit code $LASTEXITCODE" }
Write-Host 'installer: apps/hermes-buddy-desktop/dist/hermes-suite-windows-x86_64.exe'
