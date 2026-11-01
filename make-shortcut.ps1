# Creates an "LLM Icarus" shortcut on your Desktop for running from this source folder.
# It starts the native app (installer\out\LLM Icarus.exe: no console window, own taskbar icon).
# Build that first with:  powershell -ExecutionPolicy Bypass -File installer\build.ps1
# (People who use the installer get the same shortcut automatically; this is for development.)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'installer\out\LLM Icarus.exe'
if (-not (Test-Path $exe)) { throw "LLM Icarus.exe has not been built yet. Run installer\build.ps1 first." }

$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LLM Icarus.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = $exe
$s.Arguments = "--root `"$root`""   # the app folder (server\, data\ ...) lives here, not next to the .exe
$s.WorkingDirectory = $root
$s.Description = 'LLM Icarus: chat, code, transcribe and image generation with local models'
$s.IconLocation = "$exe,0"          # the icon is built into the .exe
$s.Save()
"Created $link"
