@echo off
title OCR Pipeline - Running...
echo ============================================
echo  OCR Pipeline
echo  Processing all project folders in the screenshots root...
echo ============================================
echo.

:: Check venv exists
if not exist "venv\Scripts\activate.bat" (
    echo [ERROR] Virtual environment not found.
    echo Please run SETUP.bat first!
    pause
    exit /b 1
)

if not exist "output" mkdir output
if not exist "logs" mkdir logs

:: Auto-Repair check for missing modules
echo [+] Verifying dependencies...
venv\Scripts\python.exe -c "import gspread; import google.oauth2" 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [!] Missing modules detected. Running quick repair...
    venv\Scripts\python.exe -m pip install gspread google-auth --no-cache-dir
)

venv\Scripts\python.exe ocr_pipeline.py

echo.
echo Done! Check the OUTPUT folder for your CSV file.
pause
