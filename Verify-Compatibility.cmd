@echo off
rem Checks whether this OpenCode build can be patched. Changes nothing.
cd /d "%~dp0"
py patch_desktop.py verify
echo.
pause
