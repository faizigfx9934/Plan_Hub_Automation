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

REM Check if node is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

REM Check if scraper.js exists
if not exist "scraper.js" (
    echo [ERROR] scraper.js not found in current directory!
    pause
    exit /b 1
)

REM Check if .env exists
if not exist ".env" (
    echo [WARNING] .env file not found!
    echo Please create .env with your credentials.
    pause
    exit /b 1
)

REM Run the scraper
echo Starting scraper... (Press Ctrl+C to stop anytime)
echo.
node scraper.js

REM Check exit code
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
