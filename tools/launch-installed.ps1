# Launch the installed app detached and record its lifetime.
$log = "C:\Users\LuoFeng\pw-installed.log"
$exe = "C:\Users\LuoFeng\AppData\Local\Pi Workbench\pi-workbench.exe"

"launch $(Get-Date -Format s)" | Out-File $log
$p = Start-Process -FilePath $exe -PassThru
"pid=$($p.Id)" | Out-File $log -Append

for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $alive = -not $p.HasExited
    $rss = if ($alive) { [math]::Round((Get-Process -Id $p.Id -ErrorAction SilentlyContinue).WorkingSet64 / 1MB, 1) } else { 0 }
    "t=$($i * 5)s alive=$alive rss=${rss}MB" | Out-File $log -Append
    if (-not $alive) {
        "exited code=$($p.ExitCode)" | Out-File $log -Append
        break
    }
}
