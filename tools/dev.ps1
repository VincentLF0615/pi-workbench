param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'pi-workbench-target-msvc' }
$task = if ($args.Count) { [string]$args[0] } else { 'build' }
$rest = if ($args.Count -gt 1) { @($args[1..($args.Count-1)]) } else { @() }
if ($rest.Count -gt 0 -and $rest[0] -eq '--') { $rest = @($rest | Select-Object -Skip 1) }

function Import-BuildEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $vsPath = & $vswhere -latest -products '*' -property installationPath
        $vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path -LiteralPath $vcvars) {
            $buildEnv = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
            foreach ($line in $buildEnv) {
                $pair = $line -split '=',2
                if ($pair.Count -eq 2) { [Environment]::SetEnvironmentVariable($pair[0],$pair[1]) }
            }
        }
    }
}
function Invoke-Cargo([string[]]$Command) {
    & cargo @Command
    if ($LASTEXITCODE -ne 0) { throw "cargo failed ($LASTEXITCODE)" }
}
function Invoke-Npm([string[]]$Command) {
    Push-Location (Join-Path $repoRoot 'apps\desktop')
    try { & npm.cmd @Command; if ($LASTEXITCODE -ne 0) { throw "npm failed ($LASTEXITCODE)" } }
    finally { Pop-Location }
}
Push-Location $repoRoot
try {
    switch ($task) {
        'build' { Import-BuildEnvironment; Invoke-Cargo -Command @('build','--workspace','--locked') }
        'test' { Import-BuildEnvironment; Invoke-Cargo -Command @('test','--workspace','--locked'); Invoke-Npm -Command @('test') }
        'lint' { Import-BuildEnvironment; Invoke-Cargo -Command @('fmt','--all','--check'); Invoke-Cargo -Command @('clippy','--workspace','--all-targets','--locked','--','-D','warnings') }
        'probe' { Import-BuildEnvironment; Invoke-Cargo -Command (@('run','-p','pi-probe','--')+$rest) }
        'smoke' { Import-BuildEnvironment; Invoke-Cargo -Command @('test','-p','pi-rpc','--test','real_pi','--','--ignored','--nocapture') }
        'web' { Invoke-Npm -Command @('run','dev') }
        'typecheck' { Invoke-Npm -Command @('run','typecheck') }
        'bundle' { Import-BuildEnvironment; Invoke-Npm -Command @('run','tauri','build') }
        'app' { Import-BuildEnvironment; Invoke-Npm -Command @('run','tauri','dev') }
        default { throw "Unknown task: $task" }
    }
} finally { Pop-Location }
