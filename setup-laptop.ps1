# PlanHub Ultimate Fleet Setup Script
# Automatically configures the environment, installs dependencies, and pulls the latest code.

$ErrorActionPreference = "Stop"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   PlanHub Pro - Environment Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Install System Dependencies via Winget
Write-Host "`n[1/5] Checking System Dependencies..." -ForegroundColor Yellow
$apps = @("Git.Git", "OpenJS.NodeJS.LTS", "Google.Chrome", "PrivateInternetAccess.PrivateInternetAccess")

foreach ($app in $apps) {
    if (!(winget list --id $app -e)) {
        Write-Host "   Installing $app..." -ForegroundColor Gray
        winget install --id $app -e --silent --accept-package-agreements --accept-source-agreements
    } else {
        Write-Host "   $app already installed." -ForegroundColor Green
    }
}

# 2. Setup Working Directory
Write-Host "`n[2/5] Configuring Workspace (C:\planhub)..." -ForegroundColor Yellow
$InstallDir = "C:\planhub"
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir
}
Set-Location $InstallDir

# 3. Clone / Update Repository
Write-Host "`n[3/5] Pulling Latest Fleet Code..." -ForegroundColor Yellow
$RepoUrl = "https://github.com/faizigfx9934/Plan_Hub_Automation.git"
if (!(Test-Path ".git")) {
    git clone $RepoUrl .
} else {
    git fetch origin
    git reset --hard origin/main
}

# 4. Install Project Dependencies
Write-Host "`n[4/5] Installing Node.js Modules..." -ForegroundColor Yellow
npm install
npx playwright install chromium

# 5. Final Configuration
Write-Host "`n[5/5] Finalizing Config..." -ForegroundColor Yellow
if (!(Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "   [!] Created .env from example. PLEASE FILL IN YOUR CREDENTIALS!" -ForegroundColor Magenta
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "   SETUP COMPLETE!" -ForegroundColor Green
Write-Host "   Your fleet is ready to run."
Write-Host "========================================" -ForegroundColor Green
Write-Host "Next Steps:"
Write-Host "1. Fill in .env with your PlanHub login and Token."
Write-Host "2. Run 'run-control-center.bat' to connect to the dashboard."
Write-Host "3. Run 'run-scraper.bat' to start the work."
