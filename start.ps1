# Starts LLM Icarus and opens it in its own app-style window (no tabs or address bar).
# Closing the window stops the server and unloads the model, unless this script found the
# server already running (e.g. started from a terminal), in which case it leaves it alone.
param([int]$Port = 3210, [switch]$NoWindow)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port"

function Test-Server {
    try { (Invoke-WebRequest "$url/api/settings" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

# A server that was just closed takes a few seconds to unload its model and exit, and answers 503 meanwhile.
# Wait for it to finish, otherwise we would attach to a server that is about to disappear.
function Test-Closing {
    try { Invoke-WebRequest "$url/api/settings" -UseBasicParsing -TimeoutSec 2 | Out-Null; $false }
    catch { [bool]($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 503) }
}
for ($i = 0; $i -lt 40 -and (Test-Closing); $i++) { Start-Sleep -Milliseconds 500 }

$startedServer = $false
if (-not (Test-Server)) {
    # the installer ships its own Node in runtime\; a source checkout uses the Node on PATH
    $node = Join-Path $root 'runtime\node.exe'
    if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
    if (-not $node) { throw 'Node.js was not found. Install Node 20+ from nodejs.org, or use the LLM Icarus installer.' }
    $env:PORT = $Port
    Start-Process $node -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    $startedServer = $true
    for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Server)) { throw "The server did not start on port $Port." }
}

if ($NoWindow) { return }

# Chrome first: a fresh private profile there is signed out, so nothing from your accounts gets
# synced into it. Edge is the fallback (always present on Windows 11) with sync switched off.
# The private profile folder gives the app its own browser process, so we can tell when its
# window is closed.
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
    Start-Process $url   # no Chromium browser found: fall back to the default browser, server keeps running
    return
}

$profile = Join-Path $root 'data\app-profile'
$args = @("--app=$url", "--user-data-dir=`"$profile`"", '--window-size=1320,880', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate')
$proc = Start-Process $browser -ArgumentList $args -PassThru
$proc | Wait-Process

if ($startedServer) {
    try { Invoke-RestMethod -Method Post "$url/api/shutdown" -TimeoutSec 5 | Out-Null } catch { }
}
