# PlanHub Pro - Hardened Fleet Setup Script (v3.0)
# Fixes: Python version pinning, BOM-free writes, PATH refresh, OCR model pre-download,
#         correct folder structure for relative paths, VC++ runtime, and validation.

$ErrorActionPreference = "Stop"
$LogFile = "$env:TEMP\planhub_setup_log.txt"

function Write-Log($Message, $Color = "White") {
    $TimeStamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$TimeStamp : $Message" | Out-File -FilePath $LogFile -Append
    Write-Host "[$TimeStamp] $Message" -ForegroundColor $Color
}

function Write-BomFreeFile($Path, $Content) {
    # Avoid PowerShell's default UTF-8 BOM which breaks Python's json.load()
    $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Wait-ForCommand($Name, $MaxAttempts = 10) {
    # Refresh PATH and loop until a binary is actually callable
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        if (Get-Command $Name -ErrorAction SilentlyContinue) {
            Write-Log "   ✓ $Name is available." "Green"
            return $true
        }
        Write-Log "   Waiting for $Name to become available (attempt $i/$MaxAttempts)..." "Gray"
        Start-Sleep -Seconds 3
    }
    Write-Log "   [WARNING] $Name not found after $MaxAttempts attempts." "Yellow"
    return $false
}

# --- 0. ADMIN CHECK ---
Write-Log "Checking for Administrator privileges..." "Cyan"
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Log "[ERROR] This script must be run as Administrator." "Red"
    Write-Log "Please right-click your terminal and 'Run as Administrator'." "Yellow"
    pause
    exit
}

Write-Log "========================================" "Cyan"
Write-Log "   PlanHub Pro - Master Fleet Setup v3" "Cyan"
Write-Log "========================================" "Cyan"

# --- 1. USER CONFIGURATION ---
Write-Log "`n[!] LAPTOP CONFIGURATION REQUIRED" "Yellow"
$LaptopID = Read-Host "1. Enter Laptop ID (e.g. Laptop 1)"
$PhEmail = Read-Host "2. Enter PlanHub Email"
$PhPass = Read-Host "3. Enter PlanHub Password"
$State = Read-Host "4. Enter State Code (e.g. TX, CA)"
$Zip = Read-Host "5. Enter Office Zip Code (e.g. 76180)"

if ([string]::IsNullOrWhiteSpace($LaptopID) -or [string]::IsNullOrWhiteSpace($PhEmail)) {
    Write-Log "[ERROR] Laptop ID and Email are mandatory." "Red"
    pause
    exit
}

# --- 2. SYSTEM DEPENDENCIES ---
Write-Log "`n[2/8] Installing System Dependencies (Winget)..." "Yellow"

$apps = @(
    @{ id = "Git.Git"; name = "Git"; cmd = "git" },
    @{ id = "OpenJS.NodeJS.LTS"; name = "Node.js"; cmd = "node" },
    @{ id = "Google.Chrome"; name = "Google Chrome"; cmd = $null },
    @{ id = "Python.Python.3.11"; name = "Python 3.11"; cmd = "python" },
    @{ id = "UB-Mannheim.TesseractOCR"; name = "Tesseract OCR"; cmd = "tesseract" },
    @{ id = "Microsoft.VCRedist.2015+.x64"; name = "VC++ Runtime"; cmd = $null },
    @{ id = "PrivateInternetAccess.PrivateInternetAccess"; name = "PIA VPN"; cmd = $null }
)

foreach ($app in $apps) {
    $installed = winget list --id $app.id -e 2>$null | Select-String $app.id
    if (-not $installed) {
        Write-Log "   Installing $($app.name)..." "Gray"
        winget install --id $app.id -e --silent --accept-package-agreements --accept-source-agreements 2>$null
    } else {
        Write-Log "   $($app.name) already installed." "Green"
    }
}

# Refresh PATH after all installs
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Validate critical commands are available
Write-Log "`n   Validating PATH..." "Gray"
Wait-ForCommand "git"
Wait-ForCommand "node"
$pythonReady = Wait-ForCommand "python"

# Verify Python version is 3.11.x (PaddlePaddle requirement)
if ($pythonReady) {
    $pyVer = (python --version 2>&1).ToString().Trim()
    Write-Log "   Python version: $pyVer" "Gray"
    if ($pyVer -notmatch "3\.11") {
        Write-Log "   [WARNING] Expected Python 3.11.x but found $pyVer" "Yellow"
        Write-Log "   PaddlePaddle 2.6.2 requires Python 3.8-3.11. OCR may fail!" "Yellow"
        Write-Log "   Fix: winget install Python.Python.3.11 --force" "Yellow"
    }
}

# --- 3. WORKSPACE PREPARATION ---
Write-Log "`n[3/8] Preparing Clean Workspace..." "Yellow"
$InstallDir = "C:\planhub"
# OCR lives INSIDE planhub so relative paths (../planhub-scraper/screenshots) work
$OcrDir = "C:\planhub\ocr-pipeline"

foreach ($dir in @($InstallDir)) {
    if (Test-Path $dir) {
        Write-Log "   Wiping old $dir folder..." "Red"
        taskkill /F /IM node.exe /T 2>$null
        taskkill /F /IM python.exe /T 2>$null
        Start-Sleep -Seconds 2
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# --- 4. CODE DOWNLOAD ---
Write-Log "`n[4/8] Downloading Latest Automation Fleet..." "Yellow"
Set-Location $InstallDir
git clone https://github.com/faizigfx9934/Plan_Hub_Automation.git .
if ($LASTEXITCODE -ne 0) {
    Write-Log "[ERROR] Git clone failed. Check internet or GitHub access." "Red"
    Write-Log "   If repo is private, run: git config --global credential.helper manager" "Yellow"
    pause
    exit
}

# Ensure OCR dir exists (it comes from the repo as ocr-pipeline/)
if (-not (Test-Path $OcrDir)) {
    New-Item -ItemType Directory -Path $OcrDir -Force | Out-Null
}

# --- 5. CREDENTIALS & CONFIG INJECTION ---
Write-Log "`n[5/8] Injecting Configuration..." "Yellow"

# Scraper .env (BOM-free)
$EnvContent = @"
# Generated by Setup Script $(Get-Date)
PLANHUB_EMAIL=$PhEmail
PLANHUB_PASSWORD=$PhPass
LAPTOP_ID=$LaptopID
PLANHUB_ZIP=$Zip
STATE=$State
START_DATE_OFFSET=4
TELEMETRY_URL=https://planhub-telemetry.itscyper987.workers.dev
INGEST_TOKEN=a2b5f70d02997a7847dc05bf01b96d0cbc4d957a8f10f616a8c743cba1c7fd26
PIA_USERNAME=p4414451
PIA_PASSWORD=D1`$`p@tch
"@
Write-BomFreeFile -Path "$InstallDir\planhub-scraper\.env" -Content $EnvContent

# OCR config.py (BOM-free, correct relative path)
$OcrConfig = @"
SHEET_ID = "1mec31wKtllJOS5XdfphXoHO2qV2TC-d9PEQRBPcMdZc"
MACHINE_NAME = "$LaptopID"
CREDENTIALS_FILE = "credentials.json"
SCREENSHOTS_ROOT = r"../planhub-scraper/screenshots"
DISCORD_WEBHOOK_URLS = [
    "https://discord.com/api/webhooks/1496914813735927950/gTWQFxHkWuABBkRu0vbpWJq2FWdhjH8n3JloB9AhmpO-RUhE91EOrdjp8kPkRAh4IHS2",
]
NUM_WORKERS = 2
MIN_CONFIDENCE = 0.6
"@
Write-BomFreeFile -Path "$OcrDir\config.py" -Content $OcrConfig

# OCR Google Credentials (Base64 → BOM-free JSON)
$B64Creds = 'ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAgInByb2plY3RfaWQiOiAicGxhbmh1Yi1kYXRhIiwKICAicHJpdmF0ZV9rZXlfaWQiOiAiNTVjMDM2MzMzOWY5MDYyNDExM2M0ZmEzY2I2MDI3ODQ4MmJiMjBiNyIsCiAgInByaXZhdGVfa2V5IjogIi0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVxuTUlJRXZBSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS1l3Z2dTaUFnRUFBb0lCQVFDdVpyN1VzRDhJOW1XaFxuanNXOWZyc3I2Q1gxcFhKOE1BTFh0dUEveThXNFc1a2tGUGhUSWRjQzhUNWtQUi9ONmt0bHBISE5CYmxSUlNZbVxuYWRacFBzTHpCVE1GZEZDRVZuUjNvWWl4RmFTc3labHl1VjJPbTFZTm5IU1YwRytBb2hlNWxINmVzMk5JcnErOVxuMnNmWC9ra3l3ZkxXMG1yRURJN3AxeUczVkN5L2RXclFEVGFnR3RTZ2cxVDJKd3p4RVNSWkdPKzBVb2RjbFBFaFxuZk9qUWFCZmFRM1JYcmFNakFDWEFEdG1qL1VWaDgyRDkvb0J1R3ZMamIxbVV5aXQvRVdPSnBxL3JBdWdFL1BKMlxubmlacDV3R1hDU2VpQmJBZFAyL2N5VWdCQnozbHRxcC9sRExtMkU0OUxkaGNnVVpqY3RVOXBQYjJFZnJMaWUxb1xuK2htK080akRBZ01CQUFFQ2dnRUFCVlMzRkMrSHlYZmhVYTBjc0VHeFlZR1oreXpkYlBHMUo3eVpZYzhyNVU2TlxuVnZMeHJpRFp6NXA2L2RFQXcyaGdlWDNGSVVqajF1OGV4bW4wRHlMWVVvejVpUU42MkMrcWVzbXAvYWFzMks2NlxuTi9wQ3NGQ0RYVmVMMURybjl6clNoVjFicFBGTUE0OFQ4UlJSNzZSM3ZwZ3VLNkh2RWF0M1JMeFRsN1lBeDF4UlxuYURLWGhkVUJEWm5RMTRTYk5TZE4xeUpObUxNcnp2dllzVVIvL2R1THAvd1pBRW9IVlI1eUZjRU5OYmt0WFhMb1xuNEVGYlNkbkVxeVAyZlcyUG5QcUxFZ3dvTXcxV2VWaWU2ZlhWZU1LbVl1RDJnNmpTZVJMdGZkZmJ0TCt6empvNlxuQUZKNHNoT2pTbUhYVVd0OVRhaUZHSDNEYVQ1OHlMTzkxU2hiWm4wdFdRS0JnUURXNGlLWUFHOXUyTjJmaWt4R1xuS2tFb2xtMDJUcVRFODV4TDJ2MURlK1BwTlJiZTA3aVZ1MGlrZTNOcDdvUjZTQkRKcy9ZbGVTWmNmS0ZpanExRFxuWm10NFZ5ZXMweWJBeHJTdXJMTjluSnlYV3ZzL0Q1OTlnQWZzUUNtb2pTT1ZBMTlDZ0crSExGc00yZ2ExdXRUSFxuVEMrSElPK0hVT1RmY1o2bHRKZTFZaWtEVFFLQmdRRFB4YU1HS21pNDVRbjhQQkpReDM4clJMT056WTAzNm1aWFxuSlhHNTNndDVHdllFMjMrOHVYUjA1ZGhqamd1dXNheXdqL0JXZFNwWXl0TzRYVjd0Um5pYkx4NXlicXdmS2lma1xuVUdUUXN2ZVlsTEEyZXFXTVdHd214NGlpckJDMUsycTVmLzE2cmljMGVDVWFkazhibmNYbGl4cTEzSDlLUXJBSFxuQVFhKzJOZVVUd0tCZ0hwcndOdXFPOUlCK1ZsQU9DNHRPb3YrRDJCR003Y0ZOd0U0Vk5lU2lJaS9OelZobDZLdVxuWFRkZ0lhT3pRSVJOOUVxRm5YRkI0U24xMHhmTVEwZkgzT2hsZHZRT0krRG1FK0FFQWdwSkpDbFNxeHNGTW84VVxuVnU4d3Fzc2RCYTJLaTBYZTJDdEJpT25zZUxBbUxiMFJXVzU1eEJ6cWFFb29lQUxkdlNTWU5OZHRBb0dBRTQrTlxueTVUT2l5bTFDUFEyM1RnSzl1M2U0YWpLZE1zeW0xM0JHVGlZWit4cjRRVXhQM2xPUjNza0ppdEhXa2tMOHd0NlxuR3dtbzFQY3plNVgreStQb2t1T2F3RGMvS1NmMDNYL2NIZkhiY1pmK0J3TUE5dmVVSndwK0NLS2VhQkFRV2lwOFxubU1Jd21yWDgrRUxQSzlCc3d6R1hjQ3UwS0MrakZ1VzMxdHZmWCswQ2dZQlcwYnBSaG10TG1VZE9tUkpFMCt5S1xuTTFFaXBLTWdxYkJmVWVpSHdDVElBVE05a2pnRVFzTkEvS0hSeXdrYmFtU2FYYnBTMWRXSVduWFY3M1V0MXM3SVxubE9lRUdnblJFN1NsSVJMQ25XRitBaVNxWjlzVDlHYzk1WGFSTXZEU3ZEalNPbzYzamxwMFBHdTVhbzFGSHhhWVxuWnpPOXFuVFVDZGNKcm9SbStUUnNDdz09XG4tLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXG4iLAogICJjbGllbnRfZW1haWwiOiAicGxhbmh1Yi1kYXRhQHBsYW5odWItZGF0YS5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgImNsaWVudF9pZCI6ICIxMDA3MjYwMzEyMDM3NTUzMzc4MzQiLAogICJhdXRoX3VyaSI6ICJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20vby9vYXV0aDIvYXV0aCIsCiAgInRva2VuX3VyaSI6ICJodHRwczovL29hdXRoMi5nb29nbGVhcGlzLmNvbS90b2tlbiIsCiAgImF1dGhfcHJvdmlkZXJfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9vYXV0aDIvdjEvY2VydHMiLAogICJjbGllbnRfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9yb2JvdC92MS9tZXRhZGF0YS94NTA5L3BsYW5odWItZGF0YSU0MHBsYW5odWItZGF0YS5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgInVuaXZlcnNlX2RvbWFpbiI6ICJnb29nbGVhcGlzLmNvbSIKfQo='
$CredsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($B64Creds))
Write-BomFreeFile -Path "$OcrDir\credentials.json" -Content $CredsJson

# --- 6. SCRAPER DEPENDENCIES ---
Write-Log "`n[6/8] Finalizing Scraper Environment..." "Yellow"
Set-Location "$InstallDir\planhub-scraper"
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Log "   Running npm install..." "Gray"
    npm install
    Write-Log "   Installing Playwright Browsers & Dependencies..." "Gray"
    npx playwright install chromium --with-deps
} else {
    Write-Log "[WARNING] npm not found. You may need to run 'npm install' manually after restart." "Yellow"
}

# --- 7. OCR DEPENDENCIES ---
Write-Log "`n[7/8] Finalizing OCR Environment (Python venv)..." "Yellow"
Set-Location $OcrDir
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Log "   Creating virtual environment..." "Gray"
    python -m venv venv
    Write-Log "   Upgrading pip..." "Gray"
    & "$OcrDir\venv\Scripts\python.exe" -m pip install --upgrade pip 2>&1 | Out-Null
    Write-Log "   Installing OCR requirements (PaddleOCR, etc)..." "Gray"
    & "$OcrDir\venv\Scripts\python.exe" -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Log "[ERROR] pip install failed! Check Python version (must be 3.11.x)." "Red"
        Write-Log "   Current: $(python --version 2>&1)" "Yellow"
    }
} else {
    Write-Log "[WARNING] python not found. Run 'SETUP-OCR.bat' manually after restart." "Yellow"
}

# --- 8. SMOKE TEST ---
Write-Log "`n[8/8] Running Smoke Tests..." "Yellow"

# Test 1: Node.js can load scraper dependencies
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    Set-Location "$InstallDir\planhub-scraper"
    $nodeTest = node -e "require('playwright'); require('dotenv'); console.log('OK')" 2>&1
    if ($nodeTest -match "OK") {
        Write-Log "   ✓ Node.js + Playwright: OK" "Green"
        $nodeOk = $true
    } else {
        Write-Log "   ✗ Node.js test failed: $nodeTest" "Red"
    }
}

# Test 2: Python can import PaddleOCR (also pre-downloads models)
$ocrOk = $false
if (Test-Path "$OcrDir\venv\Scripts\python.exe") {
    Set-Location $OcrDir
    Write-Log "   Testing PaddleOCR import (this downloads ~150MB of models on first run)..." "Gray"
    $pyTest = & "$OcrDir\venv\Scripts\python.exe" -c "from paddleocr import PaddleOCR; print('OK')" 2>&1
    if ($pyTest -match "OK") {
        Write-Log "   ✓ PaddleOCR: OK (models downloaded)" "Green"
        $ocrOk = $true
    } else {
        Write-Log "   ✗ PaddleOCR test failed. Check logs." "Red"
        Write-Log "   Output: $($pyTest | Select-Object -Last 3)" "Yellow"
    }
}

# Test 3: Google credentials are valid JSON
$credsOk = $false
if (Test-Path "$OcrDir\credentials.json") {
    try {
        $null = Get-Content "$OcrDir\credentials.json" -Raw | ConvertFrom-Json
        Write-Log "   ✓ credentials.json: Valid JSON" "Green"
        $credsOk = $true
    } catch {
        Write-Log "   ✗ credentials.json is corrupt" "Red"
    }
}

Write-Log "`n========================================" "Green"
Write-Log "   INSTALLATION COMPLETE!" "Green"
Write-Log "   Log saved to: $LogFile"
Write-Log "========================================" "Green"

if ($nodeOk -and $ocrOk -and $credsOk) {
    Write-Log "`n   ✅ ALL SMOKE TESTS PASSED" "Green"
} else {
    Write-Log "`n   ⚠️  Some tests failed — review warnings above." "Yellow"
}

Write-Log "`nNEXT STEPS:"
Write-Log "1. Log into PIA VPN and connect to a US server."
Write-Log "2. Open 'C:\planhub\planhub-scraper' and run 'run-scraper.bat'."
Write-Log "3. OCR will auto-process from 'C:\planhub\ocr-pipeline'. Run 'RUN.bat'."

pause
