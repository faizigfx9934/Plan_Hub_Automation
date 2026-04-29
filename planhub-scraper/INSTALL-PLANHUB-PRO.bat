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
set LOCAL_SETUP=%~dp0setup-laptop.ps1
set TEMP_SETUP=%TEMP%\setup-laptop-planhub.ps1
set REPO_URL=https://github.com/faizigfx9934/Plan_Hub_Automation.git

echo [+] Checking for setup script...

if exist "%LOCAL_SETUP%" (
    echo [!] Using LOCAL setup script found in folder.
    set "RUN_SCRIPT=%LOCAL_SETUP%"
) else (
    echo [!] Local script not found. Downloading latest from GitHub...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/faizigfx9934/Plan_Hub_Automation/main/setup-laptop.ps1' -OutFile '%TEMP_SETUP%'"
    set "RUN_SCRIPT=%TEMP_SETUP%"
)

if not exist "%RUN_SCRIPT%" (
    echo [ERROR] Setup script missing and download failed.
    echo Please ensure internet access or contact support.
    pause
    exit /b 1
)

echo [+] Launching Master Setup...
powershell -NoProfile -ExecutionPolicy Bypass -File "%RUN_SCRIPT%"

if %errorLevel% neq 0 (
    echo.
    echo [!] Installation encountered an error. 
    echo Check the log at %%TEMP%%\planhub_setup_log.txt
)

pause
