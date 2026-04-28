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
set SETUP_SCRIPT=%TEMP%\setup-laptop-planhub.ps1
set REPO_URL=https://github.com/faizigfx9934/Plan_Hub_Automation.git

echo [+] Starting Full Installation from %REPO_URL%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/faizigfx9934/Plan_Hub_Automation/main/setup-laptop.ps1' -OutFile '%SETUP_SCRIPT%'"

if not exist "%SETUP_SCRIPT%" (
    echo [ERROR] Setup script missing. Please ensure internet access.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%"
pause
