<#
.SYNOPSIS
  Hermes Buddy server-side deploy - Windows push script

.DESCRIPTION
  Pushes the server-deploy tarball to the Hermes host via scp, then runs deploy.sh remotely.
  Auth: key-based or password-based (both optional, auto-selects).

.PARAMETER HostName
  Hermes host address (IP or hostname), required.

.PARAMETER User
  SSH login user (default root).

.PARAMETER KeyPath
  SSH private key path (optional). Uses key auth when provided.

.PARAMETER Password
  SSH password (optional). Uses password auth when no KeyPath.

.PARAMETER SshPort
  SSH port (default 22).

.PARAMETER Bundle
  Path to the tarball. Auto-detected by default.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = 'root',
  [string]$KeyPath = '',
  [string]$Password = '',
  [int]$SshPort = 22,
  [string]$Bundle = ''
)

$ErrorActionPreference = 'Stop'

# ---- locate tarball ----
if (-not $Bundle) {
  $Bundle = Join-Path $PSScriptRoot '..' 'server-deploy' 'hermes-buddy-server-deploy.tar.gz'
}
$Bundle = Resolve-Path $Bundle -ErrorAction SilentlyContinue
if (-not $Bundle) {
  Write-Error "Cannot find deploy tarball. Ensure server-deploy/hermes-buddy-server-deploy.tar.gz exists, or use -Bundle."
  exit 1
}
Write-Host "[deploy.ps1] bundle: $Bundle"

$remoteTar = '/tmp/hermes-buddy-server-deploy.tar.gz'
$remoteDir = '/tmp/hermes-buddy-deploy'
# Use single-quoted format string so && and || are never parsed by PowerShell
$remoteCmd = 'mkdir -p {0} && tar -xzf {1} -C {0} && cd {0} && (command -v sudo >/dev/null 2>&1 && sudo bash deploy.sh || bash deploy.sh)' -f $remoteDir, $remoteTar

function Invoke-Native {
  param([string]$FileName, [string[]]$ArgumentList)
  Write-Host "[deploy.ps1] $FileName $($ArgumentList -join ' ')"
  & $FileName @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Write-Error "$FileName exited with code $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}

# ---- determine auth method ----
$useKey = $KeyPath -and (Test-Path $KeyPath)
$usePass = $Password -and (-not $useKey)

if (-not $useKey -and -not $usePass) {
  Write-Error "Provide -KeyPath (key auth) or -Password (password auth), at least one."
  exit 1
}

if ($useKey) {
  # ---- OpenSSH key auth ----
  $ssh = Get-Command ssh -ErrorAction SilentlyContinue
  $scp = Get-Command scp -ErrorAction SilentlyContinue
  if (-not $ssh -or -not $scp) {
    Write-Error "ssh/scp not found. Enable OpenSSH in Windows Optional Features, or use -Password with PuTTY."
    exit 1
  }
  Write-Host "[deploy.ps1] auth: SSH key ($KeyPath)"
  Invoke-Native -FileName $scp.Path -ArgumentList @('-i', $KeyPath, '-P', "$SshPort", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', $Bundle, "${User}@${HostName}:${remoteTar}")
  Invoke-Native -FileName $ssh.Path -ArgumentList @('-i', $KeyPath, '-p', "$SshPort", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', "${User}@${HostName}", $remoteCmd)
} else {
  # ---- password auth: try PuTTY plink/pscp first ----
  $plink = Get-Command plink -ErrorAction SilentlyContinue
  $pscp = Get-Command pscp -ErrorAction SilentlyContinue
  if ($plink -and $pscp) {
    Write-Host "[deploy.ps1] auth: PuTTY password (plink/pscp)"
    Invoke-Native -FileName $pscp.Path -ArgumentList @('-pw', $Password, '-P', "$SshPort", '-batch', $Bundle, "${User}@${HostName}:${remoteTar}")
    Invoke-Native -FileName $plink.Path -ArgumentList @('-pw', $Password, '-P', "$SshPort", '-batch', "${User}@${HostName}", $remoteCmd)
  } else {
    # Fall back to OpenSSH (interactive password prompt, not unattended)
    $ssh = Get-Command ssh -ErrorAction SilentlyContinue
    $scp = Get-Command scp -ErrorAction SilentlyContinue
    if (-not $ssh -or -not $scp) {
      Write-Error "Password auth needs PuTTY (plink/pscp) or Windows OpenSSH. Neither found."
      exit 1
    }
    Write-Host "[deploy.ps1] auth: OpenSSH password (interactive)"
    Write-Host "[deploy.ps1] hint: install PuTTY for unattended password auth."
    Invoke-Native -FileName $scp.Path -ArgumentList @('-P', "$SshPort", '-o', 'StrictHostKeyChecking=accept-new', $Bundle, "${User}@${HostName}:${remoteTar}")
    Invoke-Native -FileName $ssh.Path -ArgumentList @('-p', "$SshPort", '-o', 'StrictHostKeyChecking=accept-new', "${User}@${HostName}", $remoteCmd)
  }
}

Write-Host "[deploy.ps1] done. Tarball pushed to $HostName and deploy.sh executed."
