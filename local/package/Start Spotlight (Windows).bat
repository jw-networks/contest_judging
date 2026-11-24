@echo off
title Spotlight local server
cd /d "%~dp0"
rem Use the Node.js that comes with this download if it's there, otherwise one installed on this computer.
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Node.js was not found. Download the Spotlight version for Windows that includes it,
    echo   or install the free LTS version from https://nodejs.org and double-click this file again.
    echo.
    start "" https://nodejs.org
    pause
    exit /b 1
  )
  set "NODE=node"
)
echo.
echo   If Windows asks whether Node.js may use the network, tick "Private networks" and click Allow.
"%NODE%" local\server.mjs
echo.
pause
