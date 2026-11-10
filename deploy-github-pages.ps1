# Deploy to GitHub Pages Script
# This script builds the project and deploys it to gh-pages branch

Write-Host "🚀 Starting GitHub Pages deployment..." -ForegroundColor Cyan

# Читаємо GitHub username/repo з .env
$GITHUB_USERNAME = ""
$GITHUB_REPO = ""
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    $userLine = $envContent | Where-Object { $_ -match '^VITE_GITHUB_USERNAME=' }
    $repoLine = $envContent | Where-Object { $_ -match '^VITE_GITHUB_REPO=' }
    if ($userLine -match '=(.+)') { $GITHUB_USERNAME = $Matches[1].Trim() }
    if ($repoLine -match '=(.+)') { $GITHUB_REPO = $Matches[1].Trim() }
}
if (-not $GITHUB_USERNAME -or -not $GITHUB_REPO) {
    Write-Host "❌ VITE_GITHUB_USERNAME або VITE_GITHUB_REPO не знайдено в .env" -ForegroundColor Red
    exit 1
}
$GITHUB_REPO_URL = "https://github.com/$GITHUB_USERNAME/$GITHUB_REPO.git"
Write-Host "🔑 GitHub: $GITHUB_REPO_URL" -ForegroundColor Cyan

# Step 1: Build the project
Write-Host "`n📦 Building project for GitHub Pages..." -ForegroundColor Yellow
npm run build:github

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Build completed successfully!" -ForegroundColor Green

# Step 2: Navigate to dist folder
Set-Location dist

# Step 3: Initialize git in dist (if not already)
if (-not (Test-Path ".git")) {
    Write-Host "`n🔧 Initializing git in dist folder..." -ForegroundColor Yellow
    git init
    git checkout -b gh-pages
} else {
    Write-Host "`n🔧 Using existing git in dist folder..." -ForegroundColor Yellow
}

# Step 4: Add .nojekyll file (important for GitHub Pages)
Write-Host "`n📝 Creating .nojekyll file..." -ForegroundColor Yellow
New-Item -ItemType File -Name ".nojekyll" -Force | Out-Null

# Step 5: Add all files
Write-Host "`n📁 Adding files to git..." -ForegroundColor Yellow
git add -A

# Step 6: Commit
Write-Host "`n💾 Committing changes..." -ForegroundColor Yellow
$commitMessage = "Deploy to GitHub Pages - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
git commit -m $commitMessage

# Step 7: Add remote (if not exists)
$remoteUrl = $GITHUB_REPO_URL
$remoteExists = git remote | Select-String -Pattern "origin"

if (-not $remoteExists) {
    Write-Host "`n🔗 Adding remote origin..." -ForegroundColor Yellow
    git remote add origin $remoteUrl
}

# Step 8: Force push to gh-pages
Write-Host "`n🚀 Pushing to GitHub Pages..." -ForegroundColor Yellow
git push -f origin gh-pages

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Push failed!" -ForegroundColor Red
    Set-Location ..
    exit 1
}

# Step 9: Go back to project root
Set-Location ..

Write-Host "`n✅ Deployment completed successfully!" -ForegroundColor Green
Write-Host "🌐 Your site will be available at: https://$GITHUB_USERNAME.github.io/$GITHUB_REPO/" -ForegroundColor Cyan
Write-Host "⏳ Note: It may take a few minutes for changes to appear." -ForegroundColor Yellow
