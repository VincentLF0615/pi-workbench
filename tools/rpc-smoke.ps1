# Protocol smoke test for pi RPC mode, using .NET stdio redirection.
# Validates: pi starts, JSONL framing, prompt streaming, agent_settled.
# Usage: pwsh -File tools\rpc-smoke.ps1 [-Prompt "text"]
param(
    [string]$Prompt = "Reply with exactly: OK",
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$node = "C:\Program Files\nodejs\node.exe"
$launcher = Join-Path $env:USERPROFILE ".pi\agent\bin\pi-launcher.js"
$fixtures = Join-Path $PSScriptRoot "..\fixtures"
New-Item -ItemType Directory -Force $fixtures | Out-Null
$rawPath = Join-Path $fixtures "rpc-smoke.jsonl"
if (Test-Path $rawPath) { Remove-Item $rawPath }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$launcher`" --mode rpc --no-session"
$psi.WorkingDirectory = "E:\default-workspace"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$process = [System.Diagnostics.Process]::Start($psi)
$raw = New-Object System.Collections.Generic.List[string]

function Send([string]$json) {
    $process.StandardInput.WriteLine($json)
    $process.StandardInput.Flush()
}

Send '{"id":"state-1","type":"get_state"}'

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$readTask = $process.StandardOutput.ReadLineAsync()
$promptSent = $false
$settled = $false
$text = ""

while ((Get-Date) -lt $deadline) {
    if (-not $readTask.Wait(250)) {
        if ($process.HasExited) { break }
        continue
    }
    $line = $readTask.Result
    if ($null -eq $line) { break }
    $raw.Add($line)
    $readTask = $process.StandardOutput.ReadLineAsync()

    $record = $null
    try { $record = $line | ConvertFrom-Json } catch {
        Write-Host "[bad-json] $line" -ForegroundColor Red
        continue
    }

    switch ($record.type) {
        "response" {
            $data = if ($null -ne $record.data) { ($record.data | ConvertTo-Json -Compress -Depth 6) } else { $record.error }
            Write-Host "RESPONSE $($record.command) success=$($record.success) $($data.Substring(0, [Math]::Min(240, $data.Length)))"
            if ($record.command -eq "get_state" -and $record.success) {
                $model = "$($record.data.model.provider)/$($record.data.model.id)"
                Write-Host "  model=$model session=$($record.data.sessionId)"
                Send ("{0}" -f (@{ id = "prompt-1"; type = "prompt"; message = $Prompt } | ConvertTo-Json -Compress))
                $promptSent = $true
            }
        }
        "message_update" {
            $event = $record.assistantMessageEvent
            if ($event.type -eq "text_delta") {
                $text += $event.delta
                Write-Host -NoNewline $event.delta
            }
        }
        "message_end" {
            if ($record.message.role -eq "assistant") {
                Write-Host ""
                Write-Host "MESSAGE_END stopReason=$($record.message.stopReason) tokens=$($record.message.usage.totalTokens)"
            }
        }
        "agent_settled" {
            Write-Host "SETTLED aborted=$($record.aborted)"
            $settled = $true
        }
        "extension_ui_request" {
            Write-Host "UI_REQUEST $($record.method) $($record.title)$($record.message)"
        }
        default {
            if ($record.type -notin @("agent_start", "turn_start", "turn_end", "agent_end")) {
                Write-Host "EVENT $($record.type)"
            }
        }
    }
    if ($settled) { break }
}

if ($settled) {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(10000)) { $process.Kill() }
}

$raw | Set-Content -Path $rawPath -Encoding utf8
Write-Host ""
Write-Host "records=$($raw.Count) promptSent=$promptSent settled=$settled exited=$($process.HasExited) code=$($process.ExitCode)"
$stderrText = $process.StandardError.ReadToEnd()
if ($stderrText.Trim().Length -gt 0) {
    Write-Host "--- pi stderr (tail) ---"
    $stderrText.Trim().Split("`n") | Select-Object -Last 8 | ForEach-Object { Write-Host $_ }
}
Write-Host "text=$text"
if (-not $settled) { exit 1 }
exit 0
