param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MookaCode\bin')
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $InstallDir) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
  Write-Host "Removed $InstallDir"
} else {
  Write-Host "MookaCode CLI is not installed at $InstallDir"
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $parts = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $InstallDir.TrimEnd('\')) })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Write-Host 'Removed the install directory from the user PATH.'
}