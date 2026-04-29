@echo off
REM ============================================
REM   PlanHub Pro - One-Click Update
REM   Pulls latest code from GitHub and
REM   reinstalls dependencies.
REM ============================================

echo.
echo  =========================================
echo    PlanHub Pro - Updater
echo  =========================================
echo.

cd /d "%~dp0"

REM Check for git
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Git is not installed. Run setup-laptop.ps1 first.
    pause
    exit /b 1
)

echo [1/5] Saving local .env before update...
if exist ".env" copy ".env" ".env.backup" >nul

echo [2/5] Pulling latest code from GitHub...
git pull origin main
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [WARNING] Git pull failed. Trying with force...
    git stash
    git pull origin main
)

echo [3/5] Restoring your local .env...
if exist ".env.backup" copy ".env.backup" ".env" >nul

echo [4/5] Reinstalling Node.js dependencies...
call npm install --production 2>nul
call npx playwright install chromium 2>nul

echo [5/5] Rebuilding dashboard...
cd dashboard
call npm install 2>nul
call npm run build 2>nul
cd ..

echo.
echo  =========================================
echo    Update Complete!
echo    Your .env credentials are preserved.
echo    Run "run-scraper.bat" to start.
echo  =========================================
echo.
pause
