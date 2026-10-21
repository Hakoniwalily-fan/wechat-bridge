# Register the WeChat bridge as a scheduled task. REQUIRES an elevated shell:
# this machine refuses Register-ScheduledTask / schtasks for a normal token.
#
#   Win+X  ->  "Terminal (Admin)"  ->  then run:
#   powershell -ExecutionPolicy Bypass -File D:\DHS\wechat-bridge\scripts\install-task.ps1
#
# Why the task runs start.cmd instead of node directly:
# a node process can die from events Task Scheduler does not treat as "task
# failure" - a console-control exit (0xC000013A) observed on 2026-10-21 was
# not restarted by -RestartCount. start.cmd loops, so the bridge is back in 5s
# no matter how it died; the repetition trigger below covers start.cmd itself.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8
# script as ANSI and mangles non-ASCII output.
$ErrorActionPreference = 'Stop'

function Assert-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
  if (-not $principal.IsInRole($admin)) {
    throw 'This script needs an elevated (Administrator) shell. Open "Terminal (Admin)" and run it again.'
  }
}

Assert-Elevated

$bridgeDir = Split-Path -Parent $PSScriptRoot
$startCmd = Join-Path $bridgeDir 'start.cmd'
$startVbs = Join-Path $bridgeDir 'start-hidden.vbs'
$taskName = 'WeChatBridge'
if (-not (Test-Path $startCmd)) { throw "Missing $startCmd" }
if (-not (Test-Path $startVbs)) { throw "Missing $startVbs" }

$node = (Get-Command node -ErrorAction Stop).Source
if (-not ($node -match '\.exe$')) {
  throw "node resolves to '$node', which is not a .exe; the bridge cannot launch it."
}
Write-Host ('node: ' + $node)

# 1) Stop anything already running so the task instance does not race it.
$live = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*main.mjs*' }
foreach ($p in $live) {
  Write-Host ('Stopping running bridge pid ' + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
$sup = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like '*start.cmd*' }
foreach ($p in $sup) {
  Write-Host ('Stopping supervisor pid ' + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 2) Drop the per-user Run entry, or both autostart paths would fire at logon.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $runKey -Name 'WeChatBridge' -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKey -Name 'WeChatBridge'
  Write-Host 'Removed the HKCU Run autostart entry (the task replaces it).'
}

# 3) Validate start.cmd: it must resolve node through PATH at run time.
$startText = Get-Content -LiteralPath $startCmd -Raw
if ($startText -notmatch 'node src\\main\.mjs') {
  throw 'start.cmd no longer contains "node src\main.mjs"; refusing to register a task that cannot start the bridge.'
}

# 4) Register: hidden, single-instance, at logon, plus a 5-minute self-heal pulse.
#    The action is wscript (not cmd) so the console stays hidden; the .vbs waits
#    for start.cmd, so the task process lives as long as the bridge does and
#    MultipleInstances=IgnoreNew keeps the pulse from stacking duplicates.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $startVbs + '"') -WorkingDirectory $bridgeDir

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$triggerPulse = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -Hidden `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerPulse) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host ('Registered ' + $taskName + ': at logon + every 5 minutes, hidden, single instance, supervisor-wrapped.')

# 5) Start once and verify.
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ('State: ' + (Get-ScheduledTask -TaskName $taskName).State + '   LastTaskResult: ' + $info.LastTaskResult)

$live = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*main.mjs*' }
if ($live) {
  Write-Host ('Bridge running as pid ' + (($live.ProcessId) -join ', '))
} else {
  Write-Host 'WARNING: no bridge process found. Check the supervisor log:'
  Write-Host ('  ' + (Join-Path (Join-Path $env:USERPROFILE '.wechat-bridge') 'logs\supervisor.log'))
}

Write-Host ''
Write-Host 'Status:      Get-ScheduledTaskInfo -TaskName WeChatBridge'
Write-Host 'Stop:        Stop-ScheduledTask -TaskName WeChatBridge'
Write-Host 'Unregister:  Unregister-ScheduledTask -TaskName WeChatBridge -Confirm:$false'
Write-Host 'Logs:        %USERPROFILE%\.wechat-bridge\logs\'
