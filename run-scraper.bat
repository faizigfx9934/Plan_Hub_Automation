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
    echo [WARNING] git not found — auto-update disabled.
    echo Install Git from https://git-scm.com to enable auto-updates.
    set SKIP_UPDATE=1
)

if not exist ".env" (
    echo [ERROR] .env file not found!
    echo Copy .env.example to .env and fill in credentials.
    pause
    exit /b 1
)

REM ---- Auto-update: pull latest code from GitHub ----
if not defined SKIP_UPDATE (
    if exist ".git" (
        echo [1/3] Checking for updates...
        git pull --ff-only
        if %ERRORLEVEL% NEQ 0 (
            echo [WARNING] git pull failed — continuing with local code.
            echo This is usually a network issue or a local change that blocks fast-forward.
        )
        echo.
    ) else (
        echo [1/3] Not a git checkout — skipping auto-update.
        echo.
    )
)

REM ---- Install/update dependencies ----
echo [2/3] Ensuring dependencies are installed...
if not exist "node_modules" (
    echo    node_modules missing — running npm install ^(this takes a minute the first time^)...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
    call npx playwright install chromium
) else (
    REM Fast path: only reinstall if package-lock.json is newer than node_modules
    for %%I in (package-lock.json) do set LOCK_TIME=%%~tI
    echo    node_modules present — running npm install to sync any new deps...
    call npm install --no-audit --no-fund --silent
)
echo.

REM ---- Run the scraper ----
echo [3/3] Starting scraper... ^(Press Ctrl+C to stop anytime^)
echo.
node scraper.js

REM ---- Exit status ----
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   Scraper finished successfully!
    echo ========================================
) else (
    echo.
    echo ========================================
    echo   Scraper stopped with errors.
    echo ========================================
)

echo.
pause
