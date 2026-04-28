@echo off
title PlanHub Control Center Agent
color 0B
cd /d "%~dp0"

REM ---- Kill any old dashboard server ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9090.*LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)

REM ---- Start the Dashboard Server fresh ----
echo [1/2] Starting Dashboard Server...
start /min "PlanHub-Dashboard" cmd /c "node panels/server.js"
echo      Waiting for server...
timeout /t 4 >nul
echo      Opening browser...
start http://127.0.0.1:9090

REM ---- Run the Control Agent ----
echo [2/2] Starting Control Agent...
node src/control-agent.js
pause
