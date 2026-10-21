@echo off
REM ============================================================
REM Supervisor for the WeChatBridge scheduled task.
REM The task runs THIS file's launcher (start-hidden.vbs) instead of node
REM directly, so any death of the node process - crash, taskkill,
REM console-control exit - is absorbed and the bridge is back within 5s.
REM
REM Paths are derived from this file's location, so the repo can live
REM anywhere. Deliberately no %date%/%time%: those are locale- and
REM codepage-dependent and produce mojibake in the log. The bridge's own
REM log carries ISO timestamps; this file only needs to show restarts.
REM
REM Do not also enable scripts\install-autostart.ps1: two bridges
REM would fight over the same getupdates cursor.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "LOGDIR=%USERPROFILE%\.wechat-bridge\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\supervisor.log"
set /a N=0

:loop
set /a N+=1
echo [restart !N!] starting bridge >>"%LOG%"
node src\main.mjs
set "RC=!errorlevel!"
if "!RC!"=="3" (
  echo [restart !N!] another instance is already running, waiting 60s >>"%LOG%"
  timeout /t 60 /nobreak >nul
) else (
  echo [restart !N!] bridge exited with !RC!, restarting in 5s >>"%LOG%"
  timeout /t 5 /nobreak >nul
)
goto loop
