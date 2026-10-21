# FALLBACK autostart: use this only when you have no administrator rights.
# The preferred path is scripts\install-task.ps1 (scheduled task, needs admin).
# Do NOT enable both: two bridges fight over the same getupdates cursor.
#
# Install logon autostart for the WeChat bridge. No administrator required.
#
# Measured on this machine: scheduled tasks are refused
# (Register-ScheduledTask and schtasks /Create both return Access is denied),
# so this uses the current user's Run key plus a hidden-window wrapper.
# Neither needs elevation. Crashes are absorbed by start.cmd's loop, which
# restarts the bridge 5 seconds after it exits.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8
# script as ANSI and mangles non-ASCII output.
$ErrorActionPreference = 'Stop'

$bridgeDir = Split-Path -Parent $PSScriptRoot
$startCmd = Join-Path $bridgeDir 'start.cmd'
$startVbs = Join-Path $bridgeDir 'start-hidden.vbs'

if (-not (Test-Path $startCmd)) { throw "Missing $startCmd" }
if (-not (Test-Path $startVbs)) { throw "Missing $startVbs" }

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$value = 'wscript.exe "' + $startVbs + '"'
New-ItemProperty -Path $key -Name 'WeChatBridge' -Value $value -PropertyType String -Force | Out-Null

Write-Host ('Registered logon autostart: ' + $value)
Write-Host 'Supervisor: start.cmd loops, restarting 5s after exit.'
Write-Host ''

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*main.mjs*' }
if ($running) {
  $pids = ($running.ProcessId -join ', ')
  Write-Host ('Bridge already running (pid ' + $pids + '), not starting another copy.')
} else {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $startVbs + '"') -WindowStyle Hidden
  Write-Host 'Bridge started in a hidden window.'
}

Write-Host ''
Write-Host 'Remove autostart:'
Write-Host ('  Remove-ItemProperty -Path ' + "'" + $key + "'" + ' -Name WeChatBridge')
Write-Host 'Stop the bridge:'
Write-Host '  Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | Where-Object { $_.CommandLine -like ''*main.mjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
