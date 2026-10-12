@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title MIDI -> Subtitle Editor (static)

rem ===================================================================
rem  Static mode: build dist/static, serve it, open the browser.
rem
rem  No backend needed - projects are stored in the browser localStorage.
rem  Good for a quick look, or for copying dist/static onto any static
rem  host (GitHub Pages / Vercel / Netlify / nginx).
rem ===================================================================

cd /d "%~dp0"

set "PORT=4518"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   MIDI lyrics  -^>  Subtitle editor  [static mode]
echo   --------------------------------------------------
echo   Folder: %CD%
echo   Port:   %PORT%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found - needed to build and preview.
  echo   Install from https://nodejs.org/ then try again.
  echo.
  pause
  exit /b 1
)

echo   Building dist\static ...
node scripts\build-static.mjs
if errorlevel 1 (
  echo.
  echo   [ERROR] Build failed - see the messages above.
  echo.
  pause
  exit /b 1
)

set "KILLED="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    echo   Port %PORT% is held by PID %%p - clearing it...
    taskkill /PID %%p /F >nul 2>nul
    set "KILLED=1"
  )
)
if defined KILLED timeout /t 1 /nobreak >nul

echo.
echo   Serving dist\static ... the browser will open automatically.
echo   To stop: close this window (or press Ctrl+C).
echo.
echo   The ready-to-deploy folder is: %CD%\dist\static
echo.

set "DSH_STATIC_PORT=%PORT%"
start "" "http://127.0.0.1:%PORT%/"
node scripts\serve-static.mjs

echo.
echo   Server stopped.
pause
endlocal
