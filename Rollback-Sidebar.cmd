@echo off
rem Restores the original OpenCode desktop app and disables the telemetry plugin.
rem 1. Quit OpenCode completely. 2. Double-click this file. 3. Relaunch OpenCode.
cd /d "%~dp0"
tasklist /FI "IMAGENAME eq OpenCode.exe" /FO CSV /NH | find /i "opencode.exe" >nul
if not errorlevel 1 (
  echo OpenCode is still running. Quit OpenCode completely, then run this again.
  echo No files were changed.
  pause
  exit /b 1
)
py patch_desktop.py rollback
echo.
pause
