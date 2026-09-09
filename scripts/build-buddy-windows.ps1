$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = '--use-system-ca'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:win --workspace=@hermes/buddy-desktop
