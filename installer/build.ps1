# Builds dist\LLM-Icarus-Setup-<version>.exe with Inno Setup (https://jrsoftware.org/isinfo.php).
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Add-Type -AssemblyName System.Drawing

# 1. Inno Setup compiler
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 is not installed. Install it with:  winget install JRSoftware.InnoSetup" }

# 2. Bundle the Node runtime so users don't need Node installed
New-Item -ItemType Directory -Force "$here\runtime" | Out-Null
$node = (Get-Command node).Source
Copy-Item $node "$here\runtime\node.exe" -Force
$ver = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
Write-Host "Node $(& $node -v) bundled; app version $ver"

# 3. Icon and wizard images made from the logo
$logo = [System.Drawing.Image]::FromFile("$root\web\logo.png")
function Save-Ico($path) {
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($logo, 0, 0, 256, 256); $g.Dispose()
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $png = $ms.ToArray()
    $w = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($path))
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$png.Length); $w.Write([uint32]22); $w.Write($png); $w.Close()
}
function Save-Bmp($path, $w, $h, $withGradient) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.TextRenderingHint = 'AntiAliasGridFit'
    if ($withGradient) {
        $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(28, 88, 166)), ([System.Drawing.Color]::FromArgb(39, 132, 220)), 90
        $g.FillRectangle($brush, $rect); $brush.Dispose()
        $size = $w - 24
        $g.DrawImage($logo, 12, 20, $size, $size)
        $font = New-Object System.Drawing.Font 'Segoe UI Semibold', 15
        $g.DrawString('LLM Icarus', $font, [System.Drawing.Brushes]::White, 14, 20 + $size + 10)
    } else {
        $g.Clear([System.Drawing.Color]::White); $g.DrawImage($logo, 0, 0, $w, $h)
    }
    $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
}
Save-Ico "$here\icarus.ico"
Save-Bmp "$here\wizard-small.bmp" 55 55 $false
Save-Bmp "$here\wizard-side.bmp" 164 314 $true
$logo.Dispose()

# 3b. Native app window ("LLM Icarus.exe"): a small C# program hosting Microsoft's WebView2.
#     The WebView2 SDK libraries (Microsoft, BSD-style license) are downloaded once from NuGet.
$wv = "$here\webview2"
$sdk = '1.0.4314.35'
if (-not (Test-Path "$wv\Microsoft.Web.WebView2.Core.dll")) {
    Write-Host "Downloading the WebView2 SDK $sdk from NuGet..."
    New-Item -ItemType Directory -Force $wv | Out-Null
    $pkg = "$wv\wv2.nupkg"
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdk/microsoft.web.webview2.$sdk.nupkg" -OutFile $pkg -UseBasicParsing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($pkg)
    foreach ($e in $zip.Entries) {
        if ($e.FullName -in 'lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll', 'LICENSE.txt', 'NOTICE.txt') {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$wv\$($e.Name)", $true)
        }
    }
    $zip.Dispose(); Remove-Item $pkg
}
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "The .NET Framework C# compiler was not found at $csc" }
$out = "$here\out"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$wv\*.dll" $out -Force
& $csc /nologo /target:winexe /platform:x64 "/out:$out\LLM Icarus.exe" "/win32icon:$here\icarus.ico" "/win32manifest:$here\app.manifest" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/r:$wv\Microsoft.Web.WebView2.Core.dll" "/r:$wv\Microsoft.Web.WebView2.WinForms.dll" "$here\IcarusApp.cs"
if ($LASTEXITCODE -ne 0) { throw "Compiling LLM Icarus.exe failed (exit $LASTEXITCODE)" }
Write-Host "Built $out\LLM Icarus.exe"

# 4. Compile
& $iscc "/DAppVersion=$ver" "$here\icarus.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed (exit $LASTEXITCODE)" }
$out = Get-ChildItem "$root\dist\LLM-Icarus-Setup-$ver.exe"
"Built {0}  ({1:N0} MB)" -f $out.FullName, ($out.Length / 1MB)
