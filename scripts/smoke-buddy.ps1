# 启动 → 加载渲染层 → 退出的最小冒烟，退出码 0 表示主进程/preload/渲染层都能起来。
# 在没有 GPU 的 CI 或远程会话里必须关掉硬件加速，否则 GPU 进程会让 Electron 直接 FATAL。
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run smoke --workspace=@hermes/buddy-desktop
if ($LASTEXITCODE -ne 0) { throw "buddy smoke test failed with exit code $LASTEXITCODE" }
Write-Host 'buddy smoke test passed'
