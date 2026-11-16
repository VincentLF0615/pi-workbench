$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'dev.ps1') bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
