param(
    [string]$Out = "C:\Users\LuoFeng\vs-buildtools",
    [string]$Log = "E:\default-workspace\pi-workbench\fixtures\vs-install.log"
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $Out "vs_BuildTools.exe"
$url = "https://download.visualstudio.microsoft.com/download/pr/95995f57-8355-4ff5-8d90-a7e1669fb3b3/310c13b8238876afb4e823a91112230ee2d2c5a45c431d4062af7aadedff9c4c/vs_BuildTools.exe"

New-Item -ItemType Directory -Force $Out | Out-Null
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

if (-not (Test-Path $exe)) {
    & curl.exe -L --fail --silent --show-error -o $exe $url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $LASTEXITCODE" }
}
"installer: $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)" | Out-File $Log -Append
"start: $([DateTime]::Now.ToString('s'))" | Out-File $Log -Append

# Detached and elevated: nothing in this session's process tree can reap it.
$process = Start-Process -FilePath $exe -ArgumentList @(
    "--quiet",
    "--wait",
    "--norestart",
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--add", "Microsoft.VisualStudio.Component.Windows11SDK.26100",
    "--includeRecommended"
) -Verb RunAs -PassThru

"installer pid: $($process.Id)" | Out-File $Log -Append
$process.WaitForExit()
"exit: $($process.ExitCode) at $([DateTime]::Now.ToString('s'))" | Out-File $Log -Append
