@echo off
cd /d "%~dp0.."
set "PATH=C:\Program Files\nodejs;%PATH%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-amazon-browser-worker-watchdog.ps1"
exit /b %ERRORLEVEL%
