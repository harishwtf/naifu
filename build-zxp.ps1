<#
    Naifu - package the panel as a signed .zxp

    A .zxp is just a zip of the extension folder plus a signature block. Premiere
    23+ (CEP 11) refuses unsigned extensions unless PlayerDebugMode is on, so a
    distributable build has to be signed.

    What ships inside: the panel only (html/js/jsx/manifest) - a few hundred KB.
    bin/ is deliberately EXCLUDED; the engines are ~3 GB and are fetched once by
    the panel's Setup tab into %APPDATA%\Naifu\engines, where a reinstall can't
    wipe them.

    Usage
      .\build-zxp.ps1                     # self-signed cert (made once), build dist\Naifu.zxp
      .\build-zxp.ps1 -Version 0.2.0      # stamp a version into the manifest copy
      .\build-zxp.ps1 -Cert my.p12 -CertPassword pw   # real code-signing cert

    A self-signed build installs fine for you and your testers. Selling through
    aescripts needs a real certificate from a CA - same command, different -Cert.

    Requires ZXPSignCmd from Adobe:
      https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
    Put it next to this script, or pass -SignCmd <path>.
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$Cert = "",
    [string]$CertPassword = "",
    [string]$SignCmd = "",
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Staging = Join-Path $env:TEMP "naifu-zxp-staging"
$BundleId = "com.naifu.panel"

# Everything the panel needs at runtime. bin/ and dev cruft stay out.
$Include = @("CSXS", "js", "jsx", "index.html", "README.md")

function Find-SignCmd {
    if ($SignCmd -and (Test-Path $SignCmd)) { return (Resolve-Path $SignCmd).Path }
    foreach ($n in @("ZXPSignCmd.exe", "ZXPSignCmd-64.exe", "ZXPSignCmd")) {
        $p = Join-Path $Root $n
        if (Test-Path $p) { return $p }
    }
    $onPath = Get-Command "ZXPSignCmd" -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw @"
ZXPSignCmd not found.

Download it from Adobe and drop it next to this script:
  https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
Or pass its path:  .\build-zxp.ps1 -SignCmd C:\tools\ZXPSignCmd.exe
"@
}

Write-Host "Packaging Naifu..." -ForegroundColor Cyan
$Signer = Find-SignCmd
Write-Host "  Signer: $Signer"

# --- staging: copy only what ships ---------------------------------------
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

foreach ($item in $Include) {
    $src = Join-Path $Root $item
    if (-not (Test-Path $src)) { Write-Warning "  skipping missing $item"; continue }
    Copy-Item $src -Destination $Staging -Recurse -Force
}

# .debug enables the remote debugger - never ship it in a release build.
$dbg = Join-Path $Staging ".debug"
if (Test-Path $dbg) { Remove-Item $dbg -Force }

$manifest = Join-Path $Staging "CSXS\manifest.xml"
if (-not (Test-Path $manifest)) { throw "CSXS\manifest.xml missing from the staged copy." }

if ($Version) {
    # Stamp the staged manifest only; the working copy is left alone.
    $xml = Get-Content $manifest -Raw
    $xml = $xml -replace 'ExtensionBundleVersion="[^"]*"', "ExtensionBundleVersion=`"$Version`""
    $xml = $xml -replace '(<Extension Id="[^"]*" Version=")[^"]*(")', "`${1}$Version`${2}"
    Set-Content -Path $manifest -Value $xml -Encoding utf8
    Write-Host "  Stamped version $Version"
}

$staged = (Get-ChildItem $Staging -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("  Staged {0:N0} KB (bin/ excluded on purpose)" -f ($staged / 1KB))

# --- certificate ----------------------------------------------------------
if (-not $Cert) {
    $Cert = Join-Path $Root "naifu-selfsigned.p12"
    if (-not $CertPassword) { $CertPassword = "naifu" }
    if (-not (Test-Path $Cert)) {
        Write-Host "  Creating a self-signed certificate (one time)..."
        & $Signer -selfSignedCert US KA Naifu "Naifu" $CertPassword $Cert
        if ($LASTEXITCODE -ne 0) { throw "Could not create the self-signed certificate." }
        Write-Host "  Wrote $Cert  (password: $CertPassword)"
    } else {
        Write-Host "  Reusing $Cert"
    }
} elseif (-not $CertPassword) {
    throw "-Cert was given without -CertPassword."
}

# --- sign -----------------------------------------------------------------
$outPath = Join-Path $Root $OutDir
New-Item -ItemType Directory -Path $outPath -Force | Out-Null
$zxp = Join-Path $outPath "Naifu.zxp"
if (Test-Path $zxp) { Remove-Item $zxp -Force }

Write-Host "  Signing..."
& $Signer -sign $Staging $zxp $Cert $CertPassword -tsa "http://timestamp.digicert.com"
if ($LASTEXITCODE -ne 0) { throw "Signing failed." }

& $Signer -verify $zxp -certinfo | Out-Null
Remove-Item $Staging -Recurse -Force

$size = (Get-Item $zxp).Length
Write-Host ""
Write-Host ("Built {0} ({1:N0} KB)" -f $zxp, ($size / 1KB)) -ForegroundColor Green
Write-Host @"

Install it with the aescripts ZXP Installer (Windows or macOS):
  https://aescripts.com/learn/zxp-installer/
Drag Naifu.zxp onto it, restart Premiere, then Window > Extensions > Naifu.

First launch opens the Setup tab and fetches the engines (FFmpeg, Whisper,
optionally Ollama) into the user's AppData / Application Support - once, not
per use, and not wiped by a future Naifu update.

A self-signed build shows an "unknown publisher" warning in the installer.
That's expected; use a real CA certificate for public distribution.
"@
