@echo off
title PlanHub Control Center Agent
color 0B
cd /d "%~dp0"

REM ---- Start the Dashboard Server if not already running ----
netstat -ano | findstr :5678 >nul
if %ERRORLEVEL% NEQ 0 (
    echo [1/2] Starting Dashboard Server on port 5678...
    start /min "DashboardServer" cmd /c "node panels/server.js"
    echo      Waiting for server to initialize...
    timeout /t 4 >nul
    start http://localhost:5678
) else (
    echo [1/2] Dashboard Server already running on port 5678.
    start http://localhost:5678
)

REM ---- Run the Control Agent ----
echo [2/2] Starting Control Agent...
node src/control-agent.js
pause
