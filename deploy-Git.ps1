$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

# Set console encoding for Ukrainian
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Читаємо Supabase project-ref з .env
$SUPABASE_PROJECT_REF = ""
if (Test-Path ".env") {
    $envLine = Get-Content ".env" | Where-Object { $_ -match '^VITE_SUPABASE_URL=' }
    if ($envLine -match 'https://([^.]+)\.supabase\.co') {
        $SUPABASE_PROJECT_REF = $Matches[1]
    }
}
if (-not $SUPABASE_PROJECT_REF) {
    Write-Host "❌ Не вдалося отримати Supabase project-ref з .env" -ForegroundColor Red
    exit 1
}
Write-Host "🔑 Supabase project-ref: $SUPABASE_PROJECT_REF" -ForegroundColor Cyan

Write-Host "========================================"
Write-Host "  Auto Deploy: Git Push -> Vercel"
Write-Host "========================================"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════════
# GIT ACCOUNT SELECTION (GUI Window)
# ═══════════════════════════════════════════════════════════════════════════════

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Читаємо git-акаунт з .env
$GIT_NAME = ""
$GIT_EMAIL = ""
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    $nameLine = $envContent | Where-Object { $_ -match '^VITE_GIT_USER_NAME=' }
    $emailLine = $envContent | Where-Object { $_ -match '^VITE_GIT_USER_EMAIL=' }
    if ($nameLine -match '=(.+)') { $GIT_NAME = $Matches[1].Trim() }
    if ($emailLine -match '=(.+)') { $GIT_EMAIL = $Matches[1].Trim() }
}
if (-not $GIT_NAME -or -not $GIT_EMAIL) {
    Write-Host "❌ VITE_GIT_USER_NAME або VITE_GIT_USER_EMAIL не знайдено в .env" -ForegroundColor Red
    exit 1
}

$gitAccounts = @(
    @{ Name = "$GIT_NAME (GitHub)"; Email = $GIT_EMAIL; Username = $GIT_NAME }
)

# Create form
$form = New-Object System.Windows.Forms.Form
$form.Text = "Git Account Selection"
$form.Size = New-Object System.Drawing.Size(400, 320)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(20, 15)
$label.Size = New-Object System.Drawing.Size(350, 25)
$label.Text = "Select Git account for deploy:"
$label.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($label)

$listBox = New-Object System.Windows.Forms.ListBox
$listBox.Location = New-Object System.Drawing.Point(20, 50)
$listBox.Size = New-Object System.Drawing.Size(350, 150)
$listBox.Font = New-Object System.Drawing.Font("Consolas", 10)

# Add accounts to list
$listBox.Items.Add("[Current] - Use current Git config")
foreach ($acc in $gitAccounts) {
    $listBox.Items.Add("$($acc.Name) - $($acc.Email)")
}
$listBox.SelectedIndex = 0

$form.Controls.Add($listBox)

$okButton = New-Object System.Windows.Forms.Button
$okButton.Location = New-Object System.Drawing.Point(150, 220)
$okButton.Size = New-Object System.Drawing.Size(100, 35)
$okButton.Text = "Deploy"
$okButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$okButton.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 215)
$okButton.ForeColor = [System.Drawing.Color]::White
$okButton.FlatStyle = "Flat"
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.AcceptButton = $okButton
$form.Controls.Add($okButton)

$result = $form.ShowDialog()

if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "Cancelled by user." -ForegroundColor Yellow
    exit 0
}

$selectedIndex = $listBox.SelectedIndex

if ($selectedIndex -eq 0) {
    $currentUser = git config user.name
    $currentEmail = git config user.email
    $msg = "Using current: " + $currentUser + " (" + $currentEmail + ")"
    Write-Host $msg -ForegroundColor Green
} else {
    $selected = $gitAccounts[$selectedIndex - 1]
    Write-Host "Setting Git config for: $($selected.Name)..." -ForegroundColor Cyan
    
    git config user.name $selected.Username
    git config user.email $selected.Email
    
    $msg = "Git configured: " + $selected.Username + " (" + $selected.Email + ")"
    Write-Host $msg -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================"

# 0. Sync
Write-Host "[0/4] Syncing with remote repository..."
git pull --rebase origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Pull rebase failed! Trying to continue..." -ForegroundColor Yellow
}
Write-Host "✅ Sync complete!" -ForegroundColor Green

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"

# 1. Build для GitHub (з базовим шляхом /STOSuprunec/)
Write-Host "[1/4] Building for GitHub Pages (base: /STOSuprunec/)..."
npm run build:github
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ BUILD FAILED! Fixing required before deploy." -ForegroundColor Red
    exit 1
}
Write-Host "✅ Build Success!" -ForegroundColor Green

# 2. Git Commit & Push (Triggers Vercel)
Write-Host "[2/4] Pushing to GitHub (will trigger Vercel build)..."
git add -A
git commit --allow-empty -m "deploy: $timestamp"
# Check if commit failed but continue (should not fail with --allow-empty)
if ($LASTEXITCODE -ne 0) { Write-Host "Commit failed (unexpected), proceeding..." }

# Збільшуємо HTTP буфер щоб уникнути HTTP 408 timeout при великих пакетах
git config http.postBuffer 524288000
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Push failed!" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Pushed to GitHub! Vercel should start building automatically." -ForegroundColor Green

# 3. Deploy to GitHub Pages (Optional but good to keep)
Write-Host "[3/4] Deploying to GitHub Pages..."
npm run deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ GitHub Pages deploy failed!" -ForegroundColor Red
    exit 1
}

Write-Host "[4/4] Deploying Supabase Edge Functions..."
npx supabase functions deploy telegram-bot --no-verify-jwt --project-ref $SUPABASE_PROJECT_REF
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ telegram-bot deploy failed (non-critical)" -ForegroundColor Yellow
} else {
    Write-Host "✅ telegram-bot deployed!" -ForegroundColor Green
}

npx supabase functions deploy check-reminders --no-verify-jwt --project-ref $SUPABASE_PROJECT_REF
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ check-reminders deploy failed (non-critical)" -ForegroundColor Yellow
} else {
    Write-Host "✅ check-reminders deployed!" -ForegroundColor Green
}

npx supabase functions deploy send-telegram --no-verify-jwt --project-ref $SUPABASE_PROJECT_REF
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ send-telegram deploy failed (non-critical)" -ForegroundColor Yellow
} else {
    Write-Host "✅ send-telegram deployed!" -ForegroundColor Green
}

Write-Host "[5/5] DONE!"
Write-Host ""
Write-Host "========================================"
Write-Host "  ✅ DEPLOYMENT STARTED"
Write-Host "  - Supabase: $SUPABASE_PROJECT_REF"
Write-Host "========================================"
