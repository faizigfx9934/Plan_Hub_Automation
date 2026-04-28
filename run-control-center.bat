@echo off
title PlanHub Control Center Agent
color 0B
cd /d "%~dp0"

REM ---- Start the Dashboard UI if not already running ----
netstat -ano | findstr :5555 >nul
if %ERRORLEVEL% NEQ 0 (
    echo [1/2] Starting Dashboard UI in background...
    start /min cmd /c "cd dashboard && npm run dev"
    timeout /t 5 >nul
    start http://localhost:5555
) else (
    echo [1/2] Dashboard UI already running on port 5555.
    start http://localhost:5555
)

REM ---- Run the Control Agent ----
echo [2/2] Starting Control Agent...
node src/control-agent.js
pause
