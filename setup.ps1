<#
  QuietCut - one-time developer setup (Windows).

  This does two reversible things so Premiere will load our unsigned panel:
    1. Turns on CEP "debug / unsigned extensions" mode in the registry.
    2. Links this project folder into Premiere's extensions folder, so any edit
       you make here is picked up the next time you reopen the panel (no copying).

  Run it from a normal PowerShell window:
      powershell -ExecutionPolicy Bypass -File .\setup.ps1

  To undo everything later:
      powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
#>

param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$BundleId    = "com.quietcut.panel"
$SourceDir   = $PSScriptRoot
$ExtRoot     = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$LinkPath    = Join-Path $ExtRoot $BundleId
$BinDir      = Join-Path $SourceDir "bin"
$FfmpegExe   = Join-Path $BinDir "ffmpeg.exe"
$FfmpegUrl   = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

# CEP debug flag lives under one key per CEP version. Premiere 2025 uses CEP 11/12;
# we set a range so it works across recent Premiere versions.
$CsxsVersions = @(9, 10, 11, 12)

function Get-FFmpeg {
    if (Test-Path $FfmpegExe) {
        Write-Host "  FFmpeg already present, skipping download."
        return
    }
    if (-not (Test-Path $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    }

    $tmpZip = Join-Path $env:TEMP "quietcut-ffmpeg.zip"
    $tmpDir = Join-Path $env:TEMP "quietcut-ffmpeg"

    Write-Host "  Downloading FFmpeg (~30 MB)..."
    $oldPref = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest far faster
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $FfmpegUrl -OutFile $tmpZip -UseBasicParsing
    } finally {
        $ProgressPreference = $oldPref
    }

    Write-Host "  Extracting..."
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

    # The zip nests everything under ffmpeg-<version>-essentials_build\bin\.
    $found = Get-ChildItem -Path $tmpDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $found) {
        throw "Could not find ffmpeg.exe inside the downloaded archive."
    }
    Copy-Item $found.FullName $FfmpegExe -Force

    $probe = Get-ChildItem -Path $tmpDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    if ($probe) { Copy-Item $probe.FullName (Join-Path $BinDir "ffprobe.exe") -Force }

    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  FFmpeg installed to bin\ffmpeg.exe"
}

function Set-PlayerDebugMode([string]$value) {
    foreach ($v in $CsxsVersions) {
        $key = "HKCU:\Software\Adobe\CSXS.$v"
        if (-not (Test-Path $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value $value -PropertyType String -Force | Out-Null
        Write-Host "  CSXS.$v PlayerDebugMode = $value"
    }
}

if ($Uninstall) {
    Write-Host "Uninstalling QuietCut developer setup..." -ForegroundColor Cyan

    if (Test-Path $LinkPath) {
        # Remove only the junction/link, never the real source files.
        (Get-Item $LinkPath).Delete()
        Write-Host "  Removed extension link: $LinkPath"
    } else {
        Write-Host "  No extension link found (nothing to remove)."
    }

    Set-PlayerDebugMode "0"
    Write-Host "Done. Restart Premiere Pro to apply." -ForegroundColor Green
    return
}

Write-Host "Installing QuietCut developer setup..." -ForegroundColor Cyan

# 1. Enable unsigned/debug extensions.
Write-Host "Enabling CEP debug mode..."
Set-PlayerDebugMode "1"

# 2. Link this folder into the CEP extensions folder.
Write-Host "Linking panel into Premiere's extensions folder..."
if (-not (Test-Path $ExtRoot)) {
    New-Item -ItemType Directory -Path $ExtRoot -Force | Out-Null
}
if (Test-Path $LinkPath) {
    (Get-Item $LinkPath).Delete()   # clear any stale link first
}
New-Item -ItemType Junction -Path $LinkPath -Target $SourceDir | Out-Null
Write-Host "  Linked: $LinkPath  ->  $SourceDir"

# 3. Download FFmpeg into bin/ (needed from Phase 1 onward).
Write-Host "Setting up FFmpeg..."
Get-FFmpeg

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "Next:"
Write-Host "  1. Fully quit Premiere Pro if it is running."
Write-Host "  2. Reopen Premiere and a project with a sequence."
Write-Host "  3. Window menu -> Extensions -> QuietCut."
