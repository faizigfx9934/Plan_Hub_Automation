@echo off
title OCR Pipeline - Test Discord Webhook
echo ============================================
echo  OCR Pipeline Discord Webhook Test
echo ============================================
echo.

if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found.
    echo Please run SETUP.bat first!
    pause
    exit /b 1
)

venv\Scripts\python.exe test_webhook.py

if errorlevel 1 (
    echo.
    echo [ERROR] Webhook test failed.
    pause
    exit /b 1
)

echo.
echo Webhook test sent. Check your Discord channel.
pause
