@echo off
title OCR Pipeline - Universal Setup
color 0E

echo ========================================
echo   OCR Pipeline - Universal Setup
echo ========================================
echo.

REM 1. Clean Wipe Check
if exist "venv" (
    echo [!] Previous OCR environment detected.
    set /p WIPE="Do you want to PERFORM A CLEAN WIPE? (Deletes old AI env/logs) (y/n): "
    if /I "%WIPE%"=="y" (
        echo    Wiping old environment...
        rmdir /S /Q venv 2>nul
        rmdir /S /Q __pycache__ 2>nul
        rmdir /S /Q logs 2>nul
        echo    Wipe complete.
    )
)

REM 2. Install Python if not found

REM 2. Setup Virtual Environment
echo [2/3] Setting up Python environment...
if not exist "venv" (
    python -m venv venv
)
call venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt --no-cache-dir
python -c "import google.oauth2; import gspread; print('[OK] Google API modules ready.')"

REM 3. Install Tesseract
where tesseract >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [3/3] Tesseract not found. Installing via Winget...
    winget install UB-Mannheim.TesseractOCR -e --silent
) else (
    echo [3/3] Tesseract already installed.
)

echo.
echo ========================================
echo   SETUP COMPLETE!
echo ========================================
echo 1. Copy your 'credentials.json' into this folder.
echo 2. Run 'RUN.bat' to start the OCR.
echo.
pause
