$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

# Налаштування кодування консолі для української мови
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  📱 MOBILE APP BUILDER (Android/iOS)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Збірка веб-версії
Write-Host "[1/3] Building web project..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Web build success!" -ForegroundColor Green

# 2. Синхронізація з мобільними платформами
Write-Host "[2/3] Syncing with Capacitor..." -ForegroundColor Yellow
npx cap sync
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Sync failed!" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Capacitor sync success!" -ForegroundColor Green

# 3. Вибір платформи
Write-Host ""
Write-Host "Select platform to open:" -ForegroundColor White
Write-Host "1. Android (Android Studio -> Build APK)" -ForegroundColor Cyan
Write-Host "2. iOS (Xcode -> Archive)" -ForegroundColor Cyan
Write-Host "3. Exit" -ForegroundColor Gray

$choice = Read-Host "Choice [1-3]"

if ($choice -eq "1") {
    Write-Host "[3/3] Opening Android Studio..." -ForegroundColor Green
    npx cap open android
} elseif ($choice -eq "2") {
    Write-Host "[3/3] Opening Xcode..." -ForegroundColor Green
    npx cap open ios
} else {
    Write-Host "Finished." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================"
Write-Host "  ✅ READY FOR COMPILATION"
Write-Host "========================================"
