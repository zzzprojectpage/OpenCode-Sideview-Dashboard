@echo off
rem One-click installer for the OpenCode telemetry sidebar.
rem 1. Quit OpenCode completely (all windows, no tray icon).
rem 2. Double-click this file. 3. Relaunch OpenCode.
cd /d "%~dp0"
tasklist /FI "IMAGENAME eq OpenCode.exe" /FO CSV /NH | find /i "opencode.exe" >nul
if not errorlevel 1 (
  echo OpenCode is still running. Quit OpenCode completely, then run this again.
  echo No files were changed.
  pause
  exit /b 1
)
py patch_desktop.py install
echo.
pause
