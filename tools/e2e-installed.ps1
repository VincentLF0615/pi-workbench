# Launch the installed app with a project argument and report whether pi starts.
$log = "C:\Users\LuoFeng\pw-e2e.log"
$exe = "C:\Users\LuoFeng\AppData\Local\Pi Workbench\pi-workbench.exe"
$project = "E:\default-workspace\pi-workbench"

Remove-Item $log -ErrorAction SilentlyContinue
"launch $(Get-Date -Format s) with project=$project" | Out-File $log

$p = Start-Process -FilePath $exe -ArgumentList $project -PassThru
"pid=$($p.Id)" | Out-File $log -Append

for ($i = 0; $i -lt 14; $i++) {
    Start-Sleep -Seconds 5
    $alive = -not $p.HasExited
    $pi = @()
    try {
        $pi = Get-CimInstance Win32Process -ErrorAction Stop |
            Where-Object { $_.ParentProcessId -eq $p.Id -and $_.CommandLine -like "*pi-launcher*" }
    } catch {
        $pi = @()
    }
    "t=$($i * 5)s alive=$alive piChildren=$($pi.Count)" | Out-File $log -Append
    if ($pi.Count -gt 0) {
        foreach ($child in $pi) {
            "  pi pid=$($child.ProcessId)" | Out-File $log -Append
        }
        break
    }
    if (-not $alive) {
        "exited code=$($p.ExitCode)" | Out-File $log -Append
        break
    }
}
