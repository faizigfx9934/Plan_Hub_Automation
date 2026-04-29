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

venv\Scripts\python.exe ocr_pipeline.py

echo.
echo Done! Check the OUTPUT folder for your CSV file.
pause
