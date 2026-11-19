# Vendor the pi coding agent into the installer's resources.
#
# Downloads @earendil-works/pi-coding-agent (MIT) from the npm registry,
# unpacks it together with its runtime node_modules, and places everything
# under apps/desktop/src-tauri/vendor-pi/ so the NSIS/MSI bundles can carry
# a self-contained pi. The package's MIT license text is preserved at
# vendor-pi/LICENSE (pi-agent-LICENSE.txt) as redistribution requires.
#
# Usage: powershell -File tools\vendor-pi.ps1 [-PiVersion 1.5.2]
param(
    [string]$PiVersion = "1.5.2"
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$vendorDir = Join-Path $repoRoot 'apps\desktop\src-tauri\vendor-pi'
$stage = Join-Path $env:TEMP "pi-vendor-$PiVersion"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory -Force | Out-Null
Write-Host "==> Fetching @earendil-works/pi-coding-agent@$PiVersion from npm"
npm pack "@earendil-works/pi-coding-agent@$PiVersion" --pack-destination $stage | Out-Null
$tgz = Get-ChildItem $stage -Filter "*.tgz" | Select-Object -First 1
if (-not $tgz) { throw "npm pack produced no tarball" }

Write-Host "==> Unpacking $($tgz.Name)"
tar -xzf $tgz.FullName -C $stage
$package = Join-Path $stage 'package'
if (-not (Test-Path $package)) { throw "unexpected tarball layout: no package/ dir" }

Write-Host "==> Verifying the self-contained bundle runs"
# The bundle at dist/bundle has all runtime code inlined; a quick
# --version smoke test outside the package dir proves it.
$smoke = Join-Path $stage 'smoke'
New-Item $smoke -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $package 'dist\bundle') (Join-Path $smoke 'bundle') -Recurse
Push-Location $smoke
try {
    $version = & node (Join-Path $smoke 'bundle\cli.js') --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "bundled pi failed to run" }
    Write-Host "    bundled pi --version => $version"
} finally { Pop-Location }

Write-Host "==> Collecting licenses"
New-Item $vendorDir -ItemType Directory -Force | Out-Null
# The pi package ships without a LICENSE file inside the tarball; fetch the
# canonical text from the upstream repository so redistribution stays MIT-clean.
$licDest = Join-Path $repoRoot 'docs\third-party\pi-agent-LICENSE.txt'
if (-not (Test-Path $licDest)) {
    $repoLicense = Join-Path $stage 'upstream-LICENSE'
    Invoke-WebRequest 'https://raw.githubusercontent.com/earendil-works/pi/main/LICENSE' `
        -OutFile $repoLicense -UseBasicParsing
    Copy-Item $repoLicense $licDest -Force
}
Copy-Item $licDest (Join-Path $vendorDir 'LICENSE') -Force

Write-Host "==> Copying the self-contained bundle into vendor-pi"
# The published package ships a fully self-contained esbuild bundle at
# dist/bundle (no node_modules needed at runtime). Keeping only that
# avoids NSIS/MSI failures on deeply nested dependency paths (the
# Windows MAX_PATH limit) and shrinks the installer by ~77 MB.
$target = Join-Path $vendorDir 'package'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item (Join-Path $target 'dist') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $package 'package.json') (Join-Path $target 'package.json')
Copy-Item (Join-Path $package 'dist\bundle') (Join-Path $target 'dist\bundle') -Recurse
Copy-Item (Join-Path $package 'dist\cli.js') (Join-Path $target 'dist\cli.js')
Copy-Item (Join-Path $package 'dist\rpc-entry.js') (Join-Path $target 'dist\rpc-entry.js')

$size = [math]::Round(((Get-ChildItem $vendorDir -Recurse -File |
    Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "==> Done: vendor-pi is $size MB (pi $PiVersion self-contained bundle + MIT LICENSE)"
