@echo off
title PlanHub Pro - Ultimate Installer
color 0B

echo ========================================
echo   PlanHub Pro - Master Installer
echo ========================================
echo.

REM Check for Admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~0' -Verb RunAs"
    exit /b
)

set INSTALL_DIR=C:\planhub
set REPO_URL=https://github.com/faizigfx9934/Plan_Hub_Automation.git

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
cd /d "%INSTALL_DIR%"

echo [+] Starting Full Installation from %REPO_URL%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/faizigfx9934/Plan_Hub_Automation/main/setup-laptop.ps1' -OutFile 'setup-laptop.ps1'"

if not exist "setup-laptop.ps1" (
    echo [ERROR] Setup script missing. Please ensure internet access.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "setup-laptop.ps1"
pause
