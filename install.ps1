#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the MookaCode CLI on Windows from a GitHub release.

.EXAMPLE
  irm https://raw.githubusercontent.com/fraer-techet/mookacode/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Version v0.1.0 -NoPath
#>
param(
  [string]$Version = $env:MOOKACODE_VERSION,
  [string]$Repo = $(if ($env:MOOKACODE_REPO) { $env:MOOKACODE_REPO } else { 'fraer-techet/mookacode' }),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MookaCode'),
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$Message) {
  Write-Host "error: $Message" -ForegroundColor Red
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'Node.js is required (20.11 or newer). Install it from https://nodejs.org and retry.'
}
$nodeVersion = (& $node.Source -p "process.versions.node")
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 20 -or ([int]$parts[0] -eq 20 -and [int]$parts[1] -lt 11)) {
  Fail "Node.js 20.11+ is required, found v$nodeVersion."
}

if (-not $Version) {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'mookacode-installer' }
    $Version = $release.tag_name
  } catch {
    Fail "Could not resolve the latest release of $Repo. Pass -Version vX.Y.Z explicitly."
  }
}
if (-not $Version.StartsWith('v')) { $Version = "v$Version" }

$baseUrl = "https://github.com/$Repo/releases/download/$Version"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mookacode-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Host "Downloading MookaCode $Version from $Repo..."
  $bundle = Join-Path $tmp 'mookacode.cjs'
  try {
    Invoke-WebRequest -Uri "$baseUrl/mookacode.cjs" -OutFile $bundle -UseBasicParsing
  } catch {
    Fail "Could not download $baseUrl/mookacode.cjs"
  }

  $sums = Join-Path $tmp 'SHA256SUMS.txt'
  try {
    Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS.txt" -OutFile $sums -UseBasicParsing
    $line = (Get-Content -LiteralPath $sums | Where-Object { $_ -match 'mookacode\.cjs$' } | Select-Object -First 1)
    if ($line) {
      $expected = ($line -split '\s+')[0]
      $actual = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected.ToLower()) {
        Fail "Checksum mismatch for mookacode.cjs (expected $expected, got $actual)."
      }
      Write-Host 'Checksum verified.'
    }
  } catch {
    Write-Host 'warning: SHA256SUMS.txt not found in the release, skipping checksum verification.'
  }

  $binDir = Join-Path $InstallDir 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  Copy-Item -LiteralPath $bundle -Destination (Join-Path $InstallDir 'mookacode.cjs') -Force
  Set-Content -LiteralPath (Join-Path $InstallDir 'VERSION') -Value $Version -Encoding ASCII

  $cmd = @'
@echo off
setlocal
node "%~dp0..\mookacode.cjs" %*
exit /b %ERRORLEVEL%
'@
  Set-Content -LiteralPath (Join-Path $binDir 'mookacode.cmd') -Value $cmd -Encoding ASCII

  $ps1 = @'
#!/usr/bin/env pwsh
& node "$PSScriptRoot/../mookacode.cjs" @args
exit $LASTEXITCODE
'@
  Set-Content -LiteralPath (Join-Path $binDir 'mookacode.ps1') -Value $ps1 -Encoding UTF8

  if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
      [Environment]::SetEnvironmentVariable('Path', (($entries + $binDir) -join ';'), 'User')
      Write-Host "Added $binDir to the user PATH. Open a new terminal to use 'mookacode'."
    }
  }

  Write-Host ''
  Write-Host "MookaCode $Version installed:"
  Write-Host "  bundle   $(Join-Path $InstallDir 'mookacode.cjs')"
  Write-Host "  launcher $(Join-Path $binDir 'mookacode.cmd')"
  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  mookacode auth set anthropic'
  Write-Host '  mookacode "explain this project"'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
