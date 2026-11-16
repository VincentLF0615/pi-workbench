# Build helpers for this repository.
#
#   pwsh -File tools/dev.ps1 build
#   pwsh -File tools/dev.ps1 test
#   pwsh -File tools/dev.ps1 lint
#   pwsh -File tools/dev.ps1 probe -- --cwd . --prompt "hi" --no-session
#   pwsh -File tools/dev.ps1 smoke
#   pwsh -File tools/dev.ps1 web           # vite dev server only
#   pwsh -File tools/dev.ps1 app          # full Tauri desktop app
#
# Three environment notes:
#
# 1. Build output must live outside the DSH workspace. `E:\default-workspace`
#    carries the Low mandatory-integrity label, and Windows runs executables
#    built there at Low integrity, where pi cannot write its own state under
#    %USERPROFILE%\.pi. Pointing CARGO_TARGET_DIR at a normal directory keeps
#    the binaries at Medium integrity.
# 2. MSVC builds need link.exe on PATH. `Invoke-BuildEnvironment` calls
#    vcvars64.bat, which is the same thing a Developer Command Prompt does.
# 3. `npm` and `npx` are .cmd shims, so they must be invoked through cmd.exe
#    when the parent is not a console host. `Invoke-Npm` does that.

param()

$ErrorActionPreference = "Stop"
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "pi-workbench-target-msvc"
$root = Split-Path $PSScriptRoot -Parent

$all = @($args)
if ($all.Count -eq 0) { $all = @("build") }
$task = [string]$all[0]
$rest = @()
if ($all.Count -gt 1) { $rest = @($all[1..($all.Count - 1)]) }
# Allow `probe -- --cwd ...` the way cargo expects it.
if ($rest.Count -gt 0 -and $rest[0] -eq "--") { $rest = @($rest | Select-Object -Skip 1) }

function Invoke-BuildEnvironment {
    $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        Write-Output "dev.ps1: vswhere not found; assuming link.exe is already on PATH"
        return
    }
    $installPath = & $vswhere -products * -property installationPath
    if (-not $installPath) {
        Write-Output "dev.ps1: no Visual Studio instance found; assuming link.exe is on PATH"
        return
    }
    $vcvars = Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path $vcvars)) {
        Write-Output "dev.ps1: vcvars64.bat not found under $installPath"
        return
    }
    # Import the environment cmd sets up into this PowerShell session.
    $dump = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
    foreach ($line in $dump) {
        $pair = $line -split "=", 2
        if ($pair.Count -eq 2) {
            [Environment]::SetEnvironmentVariable($pair[0], $pair[1])
        }
    }
}

# npm/npx are .cmd shims: run them through cmd so they work from any host.
function Invoke-Npm([string[]]$Command) {
    $frontend = Join-Path $root "apps\desktop"
    $joined = ($Command | ForEach-Object { "`"$_`"" }) -join " "
    & cmd.exe /c "cd /d `"$frontend`" && npm $joined"
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Command -join ' ') failed with $LASTEXITCODE"
    }
}

Push-Location $root
try {
    switch ($task) {
        "build" {
            Invoke-BuildEnvironment
            cargo build --workspace
        }
        "test" { cargo test --workspace }
        "lint" {
            cargo fmt --all --check
            cargo clippy --workspace --all-targets
        }
        "probe" { cargo run -p pi-probe -- @rest }
        "smoke" { cargo test -p pi-rpc --test real_pi -- --ignored --nocapture }
        "web" { Invoke-Npm @("run", "dev") }
        "typecheck" { Invoke-Npm @("run", "build") }
        "bundle" { & (Join-Path $root "tools\bundle.ps1") }
        "app" {
            Invoke-BuildEnvironment
            Invoke-Npm @("run", "tauri", "dev")
        }
        default { cargo @all }
    }
}
finally {
    Pop-Location
}
