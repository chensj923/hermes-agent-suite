<#
.SYNOPSIS
  Hermes Buddy 服务端部署 · Windows 侧推送脚本

.DESCRIPTION
  把 Buddy 安装包携带的「服务端部署压缩包」(hermes-buddy-server-deploy.tar.gz)
  通过系统自带 OpenSSH 的 scp 推到 Hermes 主机，再用 ssh 解压并运行其中的
  deploy.sh 完成部署（部署两个外挂组件：8811 推理代理 + 8822 WS 通道）。

  默认用 SSH 密钥认证（-KeyPath）。若只能用口令登录，请装 PuTTY 并加 -UsePlink
  开关（用 plink/pscp + -Password）。

.PARAMETER Host
  Hermes 主机地址（IP 或域名），必填。

.PARAMETER User
  Hermes 上的登录用户名（默认 root）。

.PARAMETER KeyPath
  SSH 私钥路径（默认 ~/.ssh/id_rsa）。密钥认证时必填。

.PARAMETER Password
  口令登录密码（仅 -UsePlink 时有效）。

.PARAMETER SshPort
  SSH 端口（默认 22）。

.PARAMETER Bundle
  压缩包路径。默认自动定位：本脚本同级的 ../server-deploy/hermes-buddy-server-deploy.tar.gz
  （即 Buddy 安装后 resources 目录里的位置）。

.PARAMETER UsePlink
  改用 PuTTY 的 plink/pscp（用于口令登录）。

.EXAMPLE
  # 密钥登录（最常见）
  .\deploy.ps1 -Host 192.168.0.231 -User root -KeyPath ~\.ssh\id_rsa

.EXAMPLE
  # 口令登录（需 PuTTY）
  .\deploy.ps1 -Host 192.168.0.231 -User root -Password "xxxxx" -UsePlink
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Host,

  [string]$User = 'root',
  [string]$KeyPath = "$env:USERPROFILE\.ssh\id_rsa",
  [string]$Password = '',
  [int]$SshPort = 22,
  [string]$Bundle = '',
  [switch]$UsePlink
)

$ErrorActionPreference = 'Stop'

# ---- 定位压缩包 ----
if (-not $Bundle) {
  $Bundle = Join-Path $PSScriptRoot '..' 'server-deploy' 'hermes-buddy-server-deploy.tar.gz'
}
$Bundle = Resolve-Path $Bundle -ErrorAction SilentlyContinue
if (-not $Bundle) {
  Write-Error "找不到部署压缩包。请确认 Buddy 安装包携带了 server-deploy/hermes-buddy-server-deploy.tar.gz，或用 -Bundle 指定。"
  exit 1
}
Write-Host "[deploy.ps1] 压缩包: $Bundle"

$remoteTar = '/tmp/hermes-buddy-server-deploy.tar.gz'
$remoteDir = '/tmp/hermes-buddy-deploy'
$remoteCmd = "mkdir -p $remoteDir && tar -xzf $remoteTar -C $remoteDir && cd $remoteDir && (command -v sudo >/dev/null 2>&1 && sudo bash deploy.sh || bash deploy.sh)"

function Invoke-Native {
  param([string]$FileName, [string[]]$ArgumentList)
  Write-Host "[deploy.ps1] $FileName $($ArgumentList -join ' ')"
  & $FileName @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Write-Error "$FileName 返回非零退出码 $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}

if ($UsePlink) {
  # ---- plink / pscp 路径（口令登录） ----
  $plink = Get-Command plink -ErrorAction SilentlyContinue
  $pscp = Get-Command pscp -ErrorAction SilentlyContinue
  if (-not $plink -or -not $pscp) {
    Write-Error "未找到 plink/pscp。请安装 PuTTY 并加入 PATH，或用 -KeyPath 走 OpenSSH。"
    exit 1
  }
  if (-not $Password) {
    Write-Error "-UsePlink 需要 -Password（口令登录）。"
    exit 1
  }
  Invoke-Native -FileName $pscp.Path -ArgumentList @('-pw', $Password, '-P', "$SshPort", $Bundle, "${User}@${Host}:${remoteTar}")
  Invoke-Native -FileName $plink.Path -ArgumentList @('-pw', $Password, '-P', "$SshPort", "${User}@${Host}", $remoteCmd)
} else {
  # ---- OpenSSH（密钥登录） ----
  $ssh = Get-Command ssh -ErrorAction SilentlyContinue
  $scp = Get-Command scp -ErrorAction SilentlyContinue
  if (-not $ssh -or -not $scp) {
    Write-Error "未找到 ssh/scp。Windows 10+ 自带 OpenSSH；请先在「可选功能」里启用，或改用 -UsePlink。"
    exit 1
  }
  if (-not (Test-Path $KeyPath)) {
    Write-Error "找不到 SSH 私钥：$KeyPath（用 -KeyPath 指定）"
    exit 1
  }
  Invoke-Native -FileName $scp.Path -ArgumentList @('-i', $KeyPath, '-P', "$SshPort", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', $Bundle, "${User}@${Host}:${remoteTar}")
  Invoke-Native -FileName $ssh.Path -ArgumentList @('-i', $KeyPath, '-p', "$SshPort", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', "${User}@${Host}", $remoteCmd)
}

Write-Host "[deploy.ps1] 完成。压缩包已推送到 $Host 并运行 deploy.sh。"
