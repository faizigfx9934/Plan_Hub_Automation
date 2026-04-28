@echo off
title OCR Pipeline - Setup
echo ============================================
echo  OCR Pipeline Setup
echo  Run this ONCE on each new machine
echo ============================================
echo.

echo [0/4] Creating required folders...
if not exist "input" mkdir input
if not exist "output" mkdir output
if not exist "logs" mkdir logs

set "PYTHON_CMD="

:: Prefer the Windows launcher when available, but fall back to plain python.
py -3.11 --version >nul 2>&1
if not errorlevel 1 set "PYTHON_CMD=py -3.11"

if not defined PYTHON_CMD (
    py -3 --version >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3"
)

if not defined PYTHON_CMD (
    python --version >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
    echo [Python] Compatible Python not found. Trying to install Python 3.11...
    winget --version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] winget is not available on this laptop.
        echo Please install Python 3.11 manually, then rerun SETUP.bat
        pause
        exit /b 1
    )

    winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [ERROR] Automatic Python install failed.
        echo Please install Python 3.11 manually, then rerun SETUP.bat
        pause
        exit /b 1
    )

    py -3.11 --version >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3.11"

    if not defined PYTHON_CMD (
        py -3 --version >nul 2>&1
        if not errorlevel 1 set "PYTHON_CMD=py -3"
    )

    if not defined PYTHON_CMD (
        python --version >nul 2>&1
        if not errorlevel 1 set "PYTHON_CMD=python"
    )

    if not defined PYTHON_CMD (
        echo [ERROR] Python was installed but is not available in this terminal yet.
        echo Close this window and run SETUP.bat again.
        pause
        exit /b 1
    )
)

echo [Python] Using %PYTHON_CMD%

if exist "venv\Scripts\python.exe" (
    echo [1/4] Virtual environment already exists.
) else (
    echo [1/4] Creating virtual environment...
    %PYTHON_CMD% -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create venv
        pause
        exit /b 1
    )
)

set VENV_PYTHON=venv\Scripts\python.exe

echo [3/4] Upgrading pip...
"%VENV_PYTHON%" -m pip install --upgrade pip
if errorlevel 1 (
    echo [ERROR] Failed to upgrade pip
    pause
    exit /b 1
)

echo [4/4] Installing dependencies (this may take 5-10 mins first time)...
"%VENV_PYTHON%" -m pip install -r requirements.txt

if errorlevel 1 (
    echo [ERROR] Installation failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Setup complete! 
echo  Now just drop PNGs into the INPUT folder
echo  and double-click RUN.bat
echo ============================================
pause
