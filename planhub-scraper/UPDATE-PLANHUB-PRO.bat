@echo off
title PlanHub Pro - Update/Repair
color 0E

echo ========================================
echo   PlanHub Pro - Quick Update
echo ========================================
echo.

REM 1. Stop any running processes
echo [1/3] Stopping background processes...
taskkill /F /IM node.exe /T 2>nul

REM 2. Reset code to latest from GitHub
echo [2/3] Pulling latest "perfect" code from GitHub...
git fetch origin
git reset --hard origin/main

REM 3. Ensure dependencies are in sync
echo [3/3] Synchronizing dependencies...
call npm install --no-audit --no-fund --silent

echo.
echo ========================================
echo   UPDATE COMPLETE!
echo ========================================
echo All files are now updated to the latest version.
echo Your credentials and login session have been kept.
echo.
pause
