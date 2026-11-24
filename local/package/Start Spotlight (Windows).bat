@echo off
title Spotlight local server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install the free LTS version from https://nodejs.org, then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
echo.
echo   If Windows asks whether Node.js may use the network, tick "Private networks" and click Allow.
node local\server.mjs
echo.
pause
