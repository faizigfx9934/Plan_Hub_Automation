@echo off
title PlanHub Extractor
color 1F

echo.
echo  =========================================
echo    PlanHub Extractor — Ollama Local AI
echo  =========================================
echo.

:: Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python is not installed or not in PATH.
    echo  Download from: https://www.python.org/downloads/
    echo  Make sure to check "Add Python to PATH" during install.
    pause
    exit /b
)

:: Check Ollama is running
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Ollama is not running!
    echo.
    echo  Fix:
    echo    1. Install Ollama from https://ollama.com
    echo    2. Open a new CMD window and run: ollama pull minicpm-v
    echo    3. Then run this bat file again
    echo.
    pause
    exit /b
)

:: Install dependencies silently if missing
echo  Checking dependencies...
pip install requests openpyxl tqdm pillow -q --disable-pip-version-check

echo  All good. Starting extractor...
echo.

:: Run the script from same folder as this bat file
cd /d "%~dp0"
python planhub_extractor.py

echo.
pause
