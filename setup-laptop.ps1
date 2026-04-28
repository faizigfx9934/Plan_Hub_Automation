# PlanHub Pro - Zero-Touch Ultimate Setup Script
# Configured specifically for your office fleet.

$ErrorActionPreference = "Stop"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   PlanHub Pro - Zero-Touch Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# --- USER INPUT SECTION ---
Write-Host "`n[!] USER CONFIGURATION REQUIRED" -ForegroundColor Yellow
$LaptopID = Read-Host "1. Enter Laptop ID (e.g. Laptop 1)"
$PhEmail = Read-Host "2. Enter PlanHub Email"
$PhPass = Read-Host "3. Enter PlanHub Password"

# --- SYSTEM SETUP ---
Write-Host "`n[1/6] Installing System Dependencies..." -ForegroundColor Yellow
$apps = @("Git.Git", "OpenJS.NodeJS.LTS", "Google.Chrome", "PrivateInternetAccess.PrivateInternetAccess", "Python.Python.3.11", "UB-Mannheim.TesseractOCR")
foreach ($app in $apps) {
    if (!(winget list --id $app -e)) {
        Write-Host "   Installing $app..." -ForegroundColor Gray
        winget install --id $app -e --silent --accept-package-agreements --accept-source-agreements
    }
}

# --- WORKSPACE SETUP ---
Write-Host "`n[2/6] Configuring Workspace..." -ForegroundColor Yellow
$InstallDir = "C:\planhub"
$OcrDir = "C:\ocr-pipeline"

# Clean Wipe
if (Test-Path $InstallDir) { 
    Write-Host "   Cleaning old scraper folder..." -ForegroundColor Red
    taskkill /F /IM node.exe /T 2>$null
    Remove-Item $InstallDir -Recurse -Force 
}
if (Test-Path $OcrDir) { 
    Write-Host "   Cleaning old OCR folder..." -ForegroundColor Red
    Remove-Item $OcrDir -Recurse -Force 
}

New-Item -ItemType Directory -Path $InstallDir
New-Item -ItemType Directory -Path $OcrDir

# --- CODE DOWNLOAD ---
Write-Host "`n[3/6] Downloading Fleet Code..." -ForegroundColor Yellow
Set-Location $InstallDir
git clone https://github.com/faizigfx9934/Plan_Hub_Automation.git .

# Move OCR to its separate folder
Write-Host "   Moving OCR components to $OcrDir..." -ForegroundColor Gray
Move-Item -Path "$InstallDir\ocr-pipeline\*" -Destination $OcrDir -Force

# --- CREDENTIALS INJECTION ---
Write-Host "`n[4/6] Injecting Office Credentials..." -ForegroundColor Yellow

# Create .env for Scraper
$EnvContent = @"
PLANHUB_EMAIL=$PhEmail
PLANHUB_PASSWORD=$PhPass
LAPTOP_ID=$LaptopID
STATE=CA
START_DATE_OFFSET=4
TELEMETRY_URL=https://planhub-telemetry.itscyper987.workers.dev
INGEST_TOKEN=a2b5f70d02997a7847dc05bf01b96d0cbc4d957a8f10f616a8c743cba1c7fd26
PIA_USERNAME=p4414451
PIA_PASSWORD=D1$`p@tch
"@
$EnvContent | Out-File -FilePath "$InstallDir\.env" -Encoding utf8

# Create credentials.json for OCR (Decoded from Secure Base64)
$B64Creds = 'ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAgInByb2plY3RfaWQiOiAicGxhbmh1Yi1kYXRhIiwKICAicHJpdmF0ZV9rZXlfaWQiOiAiNTVjMDM2MzMzOWY5MDYyNDExM2M0ZmEzY2I2MDI3ODQ4MmJiMjBiNyIsCiAgInByaXZhdGVfa2V5IjogIi0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVxuTUlJRXZBSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS1l3Z2dTaUFnRUFBb0lCQVFDdVpyN1VzRDhJOW1XaFxuanNXOWZyc3I2Q1gxcFhKOE1BTFh0dUEveThXNFc1a2tGUGhUSWRjQzhUNWtQUi9ONmt0bHBISE5CYmxSUlNZbVxuYWRacFBzTHpCVE1GZEZDRVZuUjNvWWl4RmFTc3labHl1VjJPbTFZTm5IU1YwRytBb2hlNWxINmVzMk5JcnErOVxuMnNmWC9ra3l3ZkxXMG1yRURJN3AxeUczVkN5L2RXclFEVGFnR3RTZ2cxVDJKd3p4RVNSWkdPKzBVb2RjbFBFaFxuZk9qUWFCZmFRM1JYcmFNakFDWEFEdG1qL1VWaDgyRDkvb0J1R3ZMamIxbVV5aXQvRVdPSnBxL3JBdWdFL1BKMlxubmlacDV3R1hDU2VpQmJBZFAyL2N5VWdCQnozbHRxcC9sRExtMkU0OUxkaGNnVVpqY3RVOXBQYjJFZnJMaWUxb1xuK2htK080akRBZ01CQUFFQ2dnRUFCVlMzRkMrSHlYZmhVYTBjc0VHeFlZR1oreXpkYlBHMUo3eVpZYzhyNVU2TlxuVnZMeHJpRFp6NXA2L2RFQXcyaGdlWDNGSVVqajF1OGV4bW4wRHlMWVVvejVpUU42MkMrcWVzbXAvYWFzMks2NlxuTi9wQ3NGQ0RYVmVMMURybjl6clNoVjFicFBGTUE0OFQ4UlJSNzZSM3ZwZ3VLNkh2RWF0M1JMeFRsN1lBeDF4UlxuYURLWGhkVUJEWm5RMTRTYk5TZE4xeUpObUxNcnp2dllzVVIvL2R1THAvd1pBRW9IVlI1eUZjRU5OYmt0WFhMb1xuNEVGYlNkbkVxeVAyZlcyUG5QcUxFZ3dvTXcxV2VWaWU2ZlhWZU1LbVl1RDJnNmpTZVJMdGZkZmJ0TCt6empvNlxuQUZKNHNoT2pTbUhYVVd0OVRhaUZHSDNEYVQ1OHlMTzkxU2hiWm4wdFdRS0JnUURXNGlLWUFHOXUyTjJmaWt4R1xuS2tFb2xtMDJUcVRFODV4TDJ2MURlK1BwTlJiZTA3aVZ1MGlrZTNOcDdvUjZTQkRKcy9ZbGVTWmNmS0ZpanExRFxuWm10NFZ5ZXMweWJBeHJTdXJMTjluSnlYV3ZzL0Q1OTlnQWZzUUNtb2pTT1ZBMTlDZ0crSExGc00yZ2ExdXRUSFxuVEMrSElPK0hVT1RmY1o2bHRKZTFZaWtEVFFLQmdRRFB4YU1HS21pNDVRbjhQQkpReDM4clJMT056WTAzNm1aWFxuSlhHNTNndDVHdllFMjMrOHVYUjA1ZGhqamd1dXNheXdqL0JXZFNwWXl0TzRYVjd0Um5pYkx4NXlicXdmS2lma1xuVUdUUXN2ZVlsTEEyZXFXTVdHd214NGlpckJDMUsycTVmLzE2cmljMGVDVWFkazhibmNYbGl4cTEzSDlLUXJBSFxuQVFhKzJOZVVUd0tCZ0hwcndOdXFPOUlCK1ZsQU9DNHRPb3YrRDJCR003Y0ZOd0U4Vk5lU2lJaS9OelZobDZLdVxuWFRkZ0lhT3pRSVJOOUVxRm5YRkI4U24xMHhmTVEwZkgzT2hsZHZRT0krRG1FK0FFQWdwSkpDbFNxeHNGTW84VVxuVnU4d3Fzc2RCYTJLaTBYZTJDdEJpT25zZUxBbUxiMFJXVzU1eEJ6cWFFb29lQUxkdlNTWU5OZHRBb0dBRTQrTlxueTVUT2l5bTFDUFEyM1RnSzl1M2U0YWpLZE1zeW0xM0JHVGlZWit4cjRRVXhQM2xPUjNza0ppdEhXa2tMOHd0NlxuR3dtbzFQY3plNVgreStQb2t1T2F3RGMvS1NmMDNYL2NIZkhiY1pmK0J3TUE5dmVVSndwK0NLS2VhQkFRV2lwOFxubU1Jd21yWDgrRUxQSzlCc3d6R1hjQ3UwS0MrakZ1VzMxdHZmWCswQ2dZQlcwYnBSaG10TG1VZE9tUkpFMCt5S1xuTTFFaXBLTWdxYkJmVWVpSHdDVElBVE05a2pnRVFzTkEvS0hSeXdrYmFtU2FYYnBTMWRXSVduWFY3M1V0MXM3SVxubE9lRUdnblJFN1NsSVJMQ25XRitBaVNxWjlzVDlHYzk1WGFSTXZEU3ZEalNPbzYzamxwMFBHdTVhbzFGSHhhWVxuWnpPOXFuVFVDZGNKcm9SbStUUnNDdz09XG4tLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXG4iLAogICJjbGllbnRfZW1haWwiOiAicGxhbmh1Yi1kYXRhQHBsYW5odWItZGF0YS5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgImNsaWVudF9pZCI6ICIxMDA3MjYwMzEyMDM3NTUzMzc4MzQiLAogICJhdXRoX3VyaSI6ICJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20vby9vYXV0aDIvYXV0aCIsCiAgInRva2VuX3VyaSI6ICJodHRwczovL29hdXRoMi5nb29nbGVhcGlzLmNvbS90b2tlbiIsCiAgImF1dGhfcHJvdmlkZXJfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9vYXV0aDIvdjEvY2VydHMiLAogICJjbGllbnRfeDUwOV9jZXJ0X3VybCI6ICJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9yb2JvdC92MS9tZXRhZGF0YS94NTA5L3BsYW5odWItZGF0YSU0MHBsYW5odWItZGF0YS5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgInVuaXZlcnNlX2RvbWFpbiI6ICJnb29nbGVhcGlzLmNvbSIKfQo='
$CredsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($B64Creds))
$CredsJson | Out-File -FilePath "$OcrDir\credentials.json" -Encoding utf8

# --- DEPENDENCIES ---
Write-Host "`n[5/6] Finalizing Scraper Dependencies..." -ForegroundColor Yellow
Set-Location $InstallDir
npm install
npx playwright install chromium

Write-Host "`n[6/6] Finalizing OCR Dependencies..." -ForegroundColor Yellow
Set-Location $OcrDir
python -m venv venv
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install -r requirements.txt

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "   ZERO-TOUCH SETUP COMPLETE!" -ForegroundColor Green
Write-Host "   Scraper Folder: $InstallDir"
Write-Host "   OCR Folder: $OcrDir"
Write-Host "========================================" -ForegroundColor Green
Write-Host "Next Steps:"
Write-Host "1. Run '$InstallDir\run-control-center.bat' to connect to dashboard."
Write-Host "2. Run '$InstallDir\run-scraper.bat' to start scraping."
Write-Host "3. Run '$OcrDir\RUN.bat' to start OCR."
pause
