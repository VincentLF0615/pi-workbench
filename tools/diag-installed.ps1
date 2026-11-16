# Diagnose the installed app: does the webview start, and does pi launch?
$log = "C:\Users\LuoFeng\pw-diag.log"
$exe = "C:\Users\LuoFeng\AppData\Local\Pi Workbench\pi-workbench.exe"
$project = "E:\default-workspace\pi-workbench"

Remove-Item $log -ErrorAction SilentlyContinue
"diag $(Get-Date -Format s)" | Out-File $log

$p = Start-Process -FilePath $exe -ArgumentList $project -PassThru
"app pid=$($p.Id)" | Out-File $log -Append

for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Seconds 5
    $alive = -not $p.HasExited

    $webviews = @()
    $pi = @()
    $kids = @()
    try {
        $procs = Get-CimInstance Win32Process -ErrorAction Stop
        $webviews = @($procs | Where-Object { $_.Name -like "*msedgewebview*" })
        $kids = @($procs | Where-Object { $_.ParentProcessId -eq $p.Id })
        $pi = @($procs | Where-Object { $_.CommandLine -like "*pi-launcher*" })
    } catch {
        # A transient CIM failure must not abort the loop.
    }

    "t=$($i * 5)s alive=$alive webviews=$($webviews.Count) kids=$($kids.Count) pi=$($pi.Count)" |
        Out-File $log -Append

    if ($kids.Count -gt 0) {
        foreach ($k in $kids) { "  kid: $($k.Name) pid=$($k.ProcessId)" | Out-File $log -Append }
    }
    if ($pi.Count -gt 0) {
        foreach ($n in $pi) { "  pi: pid=$($n.ProcessId) parent=$($n.ParentProcessId)" | Out-File $log -Append }
        break
    }
    if (-not $alive) {
        "app exited code=$($p.ExitCode)" | Out-File $log -Append
        break
    }
}
