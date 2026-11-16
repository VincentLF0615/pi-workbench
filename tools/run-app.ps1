# Start the Tauri dev app with output captured to a log file.
$ErrorActionPreference = "Continue"
$log = "C:\Users\LuoFeng\pi-workbench-app.log"
$root = Split-Path $PSScriptRoot -Parent

"--- start $(Get-Date -Format s) ---" | Out-File $log -Append
& (Join-Path $root "tools\dev.ps1") app 2>&1 | Out-File $log -Append
"--- end exit=$LASTEXITCODE $(Get-Date -Format s) ---" | Out-File $log -Append
