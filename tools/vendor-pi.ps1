# Vendor the pi coding agent into the installer's resources.
#
# Downloads an exact @earendil-works/pi-coding-agent release (MIT) from npm,
# verifies its registry integrity before unpacking, and copies the self-contained
# runtime under apps/desktop/src-tauri/vendor-pi/. A custom -PiVersion also needs
# its matching registry -PiIntegrity.
#
# Usage: pwsh -File tools\vendor-pi.ps1
param(
    [string]$PiVersion = "1.6.0",
    [string]$PiIntegrity = "sha512-zX1BVEsshx7A2MRuQ6jfr3RJGWw4Wn+vLq5ZfmlvS1RskhRmByaSZVXH/zcwRrWHO7qPgs98pNCbPOEti/t0fQ=="
)
$ErrorActionPreference = 'Stop'

if (-not $PiIntegrity.StartsWith('sha512-')) {
    throw 'PiIntegrity must use the sha512-<base64> form'
}
$expectedHash = [BitConverter]::ToString(
    [Convert]::FromBase64String($PiIntegrity.Substring(7))
).Replace('-', '')

$repoRoot = Split-Path $PSScriptRoot -Parent
$vendorDir = Join-Path $repoRoot 'apps\desktop\src-tauri\vendor-pi'
$stage = Join-Path $env:TEMP "pi-vendor-$PiVersion"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory -Force | Out-Null
Write-Host "==> Fetching @earendil-works/pi-coding-agent@$PiVersion from npm"
npm pack "@earendil-works/pi-coding-agent@$PiVersion" --ignore-scripts --loglevel=error --pack-destination $stage | Out-Null
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "npm pack failed ($LASTEXITCODE)" }
$tgz = Get-ChildItem $stage -Filter "*.tgz" | Select-Object -First 1
if (-not $tgz) { throw "npm pack produced no tarball" }

$actualHash = (Get-FileHash $tgz.FullName -Algorithm SHA512).Hash
if ($actualHash -ne $expectedHash) {
    throw "Pi tarball integrity mismatch: expected $PiIntegrity, got sha512 hash $actualHash"
}
Write-Host '==> Tarball SHA-512 matches the pinned npm integrity'

Write-Host "==> Unpacking $($tgz.Name)"
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $tgz.FullName -C $stage
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
$package = Join-Path $stage 'package'
if (-not (Test-Path $package)) { throw "unexpected tarball layout: no package/ dir" }
$manifest = Get-Content (Join-Path $package 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $PiVersion) {
    throw "Expected Pi $PiVersion but package.json contains $($manifest.version)"
}
foreach ($relative in @('dist\bundle\cli.js', 'dist\cli.js', 'dist\rpc-entry.js')) {
    if (-not (Test-Path (Join-Path $package $relative))) {
        throw "Pi $PiVersion is missing required runtime file: $relative"
    }
}

Write-Host "==> Verifying the self-contained bundle runs"
# The bundle at dist/bundle has all runtime code inlined; running it from a
# different directory proves it does not rely on the omitted node_modules.
$smoke = Join-Path $stage 'smoke'
$smokePackage = Join-Path $smoke 'package'
New-Item (Join-Path $smokePackage 'dist') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $package 'package.json') (Join-Path $smokePackage 'package.json')
Copy-Item (Join-Path $package 'dist\bundle') (Join-Path $smokePackage 'dist\bundle') -Recurse
Push-Location $smoke
try {
    $version = (& node (Join-Path $smokePackage 'dist\bundle\cli.js') --version 2>&1 | Out-String).Trim()
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "bundled pi failed to run: $version" }
    if ($version -ne $PiVersion -and $version -ne "pi $PiVersion") {
        throw "bundled pi --version returned '$version', expected '$PiVersion'"
    }
    Write-Host "    bundled pi --version => $version"
} finally { Pop-Location }

Write-Host '==> Refreshing the version-matched MIT license'
$repoLicense = Join-Path $stage 'upstream-LICENSE'
Invoke-WebRequest "https://raw.githubusercontent.com/earendil-works/pi/v$PiVersion/LICENSE" `
    -OutFile $repoLicense -UseBasicParsing
$licDest = Join-Path $repoRoot 'docs\third-party\pi-agent-LICENSE.txt'
New-Item (Split-Path $licDest -Parent) -ItemType Directory -Force | Out-Null
Copy-Item $repoLicense $licDest -Force

Write-Host '==> Copying the verified self-contained bundle into vendor-pi'
# Keeping only the inlined bundle avoids Windows MAX_PATH issues and shrinks
# the installer. The required entry points were checked above.
New-Item $vendorDir -ItemType Directory -Force | Out-Null
Copy-Item $licDest (Join-Path $vendorDir 'LICENSE') -Force
$target = Join-Path $vendorDir 'package'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item (Join-Path $target 'dist') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $package 'package.json') (Join-Path $target 'package.json')
Copy-Item (Join-Path $package 'dist\bundle') (Join-Path $target 'dist\bundle') -Recurse
Copy-Item (Join-Path $package 'dist\cli.js') (Join-Path $target 'dist\cli.js')
Copy-Item (Join-Path $package 'dist\rpc-entry.js') (Join-Path $target 'dist\rpc-entry.js')

$size = [math]::Round(((Get-ChildItem $vendorDir -Recurse -File |
    Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "==> Done: vendor-pi is $size MB (pi $PiVersion verified bundle + MIT LICENSE)"
