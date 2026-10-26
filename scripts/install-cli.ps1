param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MookaCode\bin'),
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'packages\cli\dist\mookacode.cjs'
if (-not (Test-Path -LiteralPath $dist)) {
  Write-Host 'Building MookaCode CLI...'
  & node (Join-Path $root 'scripts\build-cli.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'CLI build failed.' }
}
$node = (Get-Command node -ErrorAction Stop).Source
$runtimeDir = Join-Path $InstallDir 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -LiteralPath $dist -Destination (Join-Path $InstallDir 'mookacode.cjs') -Force
Copy-Item -LiteralPath $node -Destination (Join-Path $runtimeDir 'node.exe') -Force
$cmd = @'
@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0mookacode.cjs" %*
exit /b %ERRORLEVEL%
'@
Set-Content -LiteralPath (Join-Path $InstallDir 'mookacode.cmd') -Value $cmd -Encoding ASCII
$ps1 = @'
#!/usr/bin/env pwsh
& "$PSScriptRoot/runtime/node.exe" "$PSScriptRoot/mookacode.cjs" @args
exit $LASTEXITCODE
'@
Set-Content -LiteralPath (Join-Path $InstallDir 'mookacode.ps1') -Value $ps1 -Encoding UTF8

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $InstallDir) -join ';'), 'User')
    Write-Host "Added $InstallDir to the user PATH. Open a new terminal to use 'mookacode'."
  }
  $env:Path = "$env:Path;$InstallDir"
}

& (Join-Path $InstallDir 'mookacode.cmd') --version
Write-Host "Installed MookaCode CLI to $InstallDir"
Write-Host "Try: mookacode auth set anthropic"