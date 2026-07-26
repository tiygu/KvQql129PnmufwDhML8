@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
set "NODE_DISABLE_COLORS=1"
set "NPM_CONFIG_UNICODE=true"
title Mini Game Adapter Lab - Live Logs

echo.
echo ============================================
echo   Mini Game Adapter Lab
echo ============================================
echo.

if not exist "node_modules\" (
  echo [ERROR] node_modules not found.
  echo Please run "npm install" first, then try again.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js 22 or newer.
  echo.
  pause
  exit /b 1
)

echo [1/2] Cleaning up an existing project process tree...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-start.ps1" -ReplaceExisting
set "LAUNCH_STATE=%ERRORLEVEL%"

if not "%LAUNCH_STATE%"=="10" (
  echo [ERROR] Startup check failed with code %LAUNCH_STATE%.
  echo.
  pause
  exit /b %LAUNCH_STATE%
)

echo [2/2] Starting application server...
echo Live runtime and connection logs will remain in this window.
echo Press Ctrl+C or close this window to stop the complete process tree.
echo.

node run.cjs %*
set "APP_EXIT=%ERRORLEVEL%"
echo.
echo Application server has stopped (exit code: %APP_EXIT%).
echo.
if not "%APP_EXIT%"=="0" pause
exit /b %APP_EXIT%
