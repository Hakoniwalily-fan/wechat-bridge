# scripts\restart-once.ps1
# One-shot restart of the running bridge node process.
# Delayed by design: the bridge is the parent of the dsh run that is producing
# the reply to the user, so it may only be killed after that run has exited.
# The WeChatBridge scheduled task (start.cmd supervisor) brings node back in ~5s.
param(
  [string]$LogFile = (Join-Path $env:USERPROFILE '.wechat-bridge\logs\restart-once.log'),
  [int]$QuietWaitSec = 10,
  [int]$UpWaitSec = 60,
  [string]$TaskName = 'WeChatBridgeRestartOnce'
)

$ErrorActionPreference = 'Stop'
function Note([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

function Get-Bridge {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*src\main.mjs*' } |
    Select-Object -First 1
}

function Get-DshChildren([int]$parentPid) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh --profile*' }
}

try {
  Note "task fired"

  $bridge = Get-Bridge
  if (-not $bridge) { Note 'no bridge node process found, abort'; exit 0 }
  $oldPid = [int]$bridge.ProcessId
  Note "old bridge pid=$oldPid"

  # 1) wait for the in-flight dsh run (the one building the user's reply) to finish
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $busy = @(Get-DshChildren $oldPid)
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  Note 'dsh idle'

  # 2) give node time to send the final reply over WeChat
  Start-Sleep -Seconds $QuietWaitSec

  # 3) kill it; the supervisor restarts it and picks up the new router.mjs
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  Note "killed pid=$oldPid"

  # 4) wait until a fresh bridge process is up
  $deadline = (Get-Date).AddSeconds($UpWaitSec)
  $newPid = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $cur = Get-Bridge
    if ($cur -and [int]$cur.ProcessId -ne $oldPid) { $newPid = [int]$cur.ProcessId; break }
  }
  if ($newPid) {
    $p = Get-Process -Id $newPid -ErrorAction SilentlyContinue
    Note ("new bridge pid={0} started={1}" -f $newPid, $p.StartTime.ToString('HH:mm:ss'))
    Note 'restart OK'
  } else {
    Note 'restart FAILED: no new bridge within window'
  }
} catch {
  Note ("ERROR: " + $_.Exception.Message)
} finally {
  schtasks /delete /tn $TaskName /f 2>$null | Out-Null
}
