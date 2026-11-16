# Build the release bundle with output captured to a log file.
#
# CARGO_TARGET_DIR points outside the DSH workspace on purpose: the workspace
# carries the Low mandatory-integrity label, and an executable built inside it
# inherits that label, which stops pi from writing its own state under
# %USERPROFILE%\.pi. See README "Windows environment notes".

$ErrorActionPreference = "Continue"
$log = "C:\Users\LuoFeng\pi-workbench-build.log"

$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$app = "E:\default-workspace\pi-workbench\apps\desktop"
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "pi-workbench-target-msvc"

"--- build start $(Get-Date -Format s) ---" | Out-File $log -Append
"--- CARGO_TARGET_DIR=$env:CARGO_TARGET_DIR ---" | Out-File $log -Append
& cmd.exe /c "`"$vcvars`" >nul 2>&1 && cd /d `"$app`" && npx tauri build" 2>&1 | Out-File $log -Append
"--- build end exit=$LASTEXITCODE $(Get-Date -Format s) ---" | Out-File $log -Append
