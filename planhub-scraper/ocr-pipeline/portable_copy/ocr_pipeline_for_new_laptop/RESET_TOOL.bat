@echo off
title OCR Pipeline - Reset Tool State
echo ============================================
echo  OCR Pipeline Reset
echo  Resets logs and processing state
echo  Does NOT delete input or output data
echo ============================================
echo.

if not exist "input" mkdir input
if not exist "output" mkdir output
if not exist "logs" mkdir logs
if not exist "done" mkdir done

echo [1/3] Clearing log files...
del /q logs\* >nul 2>&1

echo [2/3] Clearing Python cache...
if exist "__pycache__" rmdir /s /q "__pycache__"

echo [3/3] Resetting processed-folder state...
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString(\"yyyyMMdd_HHmmss\")"') do set RESET_STAMP=%%i

if exist "done" (
    powershell -NoProfile -Command ^
        "$items = Get-ChildItem -Force 'done' -ErrorAction SilentlyContinue; if ($items) { New-Item -ItemType Directory -Force -Path 'reset_archive' | Out-Null; Move-Item -LiteralPath 'done' -Destination ('reset_archive\\done_%RESET_STAMP%'); New-Item -ItemType Directory -Force -Path 'done' | Out-Null }"
)

echo.
echo Reset complete.
echo - input/ kept as-is
echo - output/ kept as-is
echo - logs/ cleared
echo - done/ archived to reset_archive\done_%RESET_STAMP%
echo.
pause
