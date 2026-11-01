# Makes a new set of installers: bumps the version (see bump-version.js), then builds the Windows
# and macOS packages. Use this whenever a new installer is wanted; build.ps1 and build-mac.js
# alone rebuild at the current version without bumping it.
#   powershell -ExecutionPolicy Bypass -File installer\build-all.ps1            ordinary new installer
#   powershell -ExecutionPolicy Bypass -File installer\build-all.ps1 -Release   one being posted to GitHub (first number +1, second back to 0)
param([switch]$Release)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (Get-Process 'LLM Icarus' -ErrorAction SilentlyContinue) { throw 'Close LLM Icarus first: the build cannot replace the files of a running app.' }
if ($Release) { node "$here\bump-version.js" --release } else { node "$here\bump-version.js" }
if ($LASTEXITCODE -ne 0) { throw 'Version bump failed' }
& "$here\build.ps1"
node "$here\build-mac.js"
if ($LASTEXITCODE -ne 0) { throw 'Mac build failed' }
Get-ChildItem "$root\dist" | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) } | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime
