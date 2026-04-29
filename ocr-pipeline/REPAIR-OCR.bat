@echo off
title OCR Pipeline - Repair/Force Update
color 0B

echo ========================================
echo   OCR Pipeline - Deep Repair
echo ========================================
echo.

REM 1. Kill any running python processes
echo [+] Stopping running OCR processes...
taskkill /F /IM python.exe /T 2>nul

REM 2. Delete existing venv for a fresh start
if exist "venv" (
    echo [+] Deleting corrupted environment...
    rmdir /S /Q venv
)

REM 3. Recreate venv
echo [+] Creating fresh Python environment...
python -m venv venv
if %errorLevel% neq 0 (
    echo [ERROR] Failed to create venv. Is Python installed?
    pause
    exit /b 1
)

REM 4. Install dependencies with no cache
echo [+] Installing critical modules...
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install gspread google-auth --no-cache-dir
echo [+] Installing full requirements (this may take a few minutes)...
venv\Scripts\python.exe -m pip install -r requirements.txt --no-cache-dir

REM 5. Verify
echo [+] Verifying installation...
venv\Scripts\python.exe -c "import gspread; import google.oauth2; print('[OK] All modules installed successfully.')"

echo.
echo ========================================
echo   REPAIR COMPLETE!
echo ========================================
echo You can now run the OCR using RUN.bat.
echo.
pause
