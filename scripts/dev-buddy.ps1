# 本地开发启动 Hermes Buddy 桌面端。
# 注意：如果当前终端是从别的 Electron 应用（例如某些 IDE 的集成终端）派生出来的，
# 会继承 ELECTRON_RUN_AS_NODE=1，导致 electron 以 Node 模式启动、app 为 undefined。
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run start --workspace=@hermes/buddy-desktop
