@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title MIDI -> Subtitle Editor

rem ===================================================================
rem  One-click start: check env -> free the port -> serve -> open browser
rem
rem  Just double-click this file. Keep the window open; closing it stops
rem  the server. Optional: start.bat 8080   (use another port)
rem
rem  NOTE: batch files are read by cmd.exe in the console codepage, so
rem  every message below is plain ASCII on purpose. Chinese text in a
rem  .bat shows up as mojibake unless the file is saved as GBK - not
rem  worth the fragility for a launcher.
rem ===================================================================

cd /d "%~dp0"

set "PORT=4517"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   MIDI lyrics  -^>  Subtitle editor
echo   --------------------------------------------------
echo   Folder: %CD%
echo   Port:   %PORT%
echo.

rem ---------- 1. locate Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found.
  echo.
  echo   This project has zero dependencies, but it still needs the Node
  echo   runtime to host the local server. Install it from:
  echo       https://nodejs.org/
  echo   then double-click this file again.
  echo.
  echo   Prefer not to install Node? Use serve-static.bat instead
  echo   ^(static build, data lives in the browser localStorage^).
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
echo   Node:   %NODEV%

rem ---------- 2. sanity check ----------
if not exist "server\server.mjs" (
  echo.
  echo   [ERROR] server\server.mjs not found.
  echo   Put this file in the project root and run it from there.
  echo   Current folder: %CD%
  echo.
  pause
  exit /b 1
)

rem ---------- 3. free the port ----------
rem  If a previous run was closed uncleanly, the old process still holds
rem  the port and the new one dies with EADDRINUSE - the window just
rem  flashes and the user has nothing to go on. Clear the holder first.
set "KILLED="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    echo   Port %PORT% is held by PID %%p - clearing it...
    taskkill /PID %%p /F >nul 2>nul
    set "KILLED=1"
  )
)
if defined KILLED timeout /t 1 /nobreak >nul

rem ---------- 4. serve + open browser ----------
echo.
echo   Starting... the browser will open automatically.
echo   To stop: close this window (or press Ctrl+C).
echo.

start "" "http://127.0.0.1:%PORT%/"
node server\server.mjs --port %PORT%

rem reaching here means node exited (error or Ctrl+C)
echo.
echo   Server stopped.
pause
endlocal
