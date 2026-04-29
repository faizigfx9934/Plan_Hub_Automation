@echo off
title PlanHub - FORCE RESET
color 0C

echo ========================================
echo   PlanHub Scraper - Emergency Reset
echo ========================================
echo.
echo This will kill all running scraper and dashboard processes.
echo Use this if the dashboard is frozen or showing 'Already Running'.
echo.
pause

echo [1/3] Killing all Node.js processes...
taskkill /F /IM node.exe /T 2>nul

echo [2/3] Killing any stray browsers...
taskkill /F /IM chrome.exe /T 2>nul
taskkill /F /IM msedge.exe /T 2>nul

echo Reset Complete.
pause
