@echo off
title PlanHub Scraper - Running...
color 0A

echo.
echo ========================================
echo   PlanHub Scraper - Starting...
echo ========================================
echo.

REM Navigate to script directory
cd /d "%~dp0"

REM Refresh PATH from the latest machine/user environment
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); Write-Output ($m + ';' + $u)"`) do set "PATH=%%P"

REM ---- Prerequisite checks ----
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] git not found - auto-update disabled.
    echo Install Git from https://git-scm.com to enable auto-updates.
    set SKIP_UPDATE=1
)

if not exist ".env" (
    echo [ERROR] .env file not found!
    echo Copy .env.example to .env and fill in credentials.
    pause
    exit /b 1
)

REM ---- Auto-update ----
if not defined SKIP_UPDATE (
    if exist ".git" (
        echo [1/3] Checking for updates...
        git pull --ff-only
        if %ERRORLEVEL% NEQ 0 (
            echo [WARNING] git pull failed - continuing with local code.
        )
        echo.
    )
)

REM ---- Install/update dependencies ----
echo [2/4] Ensuring dependencies are installed...
if not exist "node_modules" (
    echo    node_modules missing - running npm install...
    call npm install
    call npx playwright install chromium
) else (
    echo    node_modules present - running npm install to sync...
    call npm install --no-audit --no-fund --silent
)
echo.

REM ---- Start the Dashboard UI if not already running ----
if not defined AGENT_MODE (
    netstat -ano | findstr :5555 >nul
    if %ERRORLEVEL% NEQ 0 (
        echo [3/4] Starting Dashboard UI in background...
        start /min cmd /c "cd dashboard && npm run dev"
        timeout /t 5 >nul
    ) else (
        echo [3/4] Dashboard UI already running on port 5555.
    )
)

REM ---- Run the scraper with auto-retry ----
set ATTEMPT=1

:RUN_SCRAPER
echo [4/4] Starting scraper ^(attempt %ATTEMPT%^)... ^(Press Ctrl+C to stop anytime^)
echo.
node src/scraper.js
set EXITCODE=%ERRORLEVEL%

if %EXITCODE% EQU 0 (
    echo.
    echo ========================================
    echo   Scraper finished successfully!
    echo ========================================
    goto :DONE
)

echo.
echo ========================================
echo   Scraper crashed ^(exit code %EXITCODE%^).
echo ========================================

set /a ATTEMPT=%ATTEMPT%+1
echo   Waiting 60s before retry attempt %ATTEMPT%...
timeout /t 60 /nobreak >nul
goto :RUN_SCRAPER

:DONE
echo.
pause
