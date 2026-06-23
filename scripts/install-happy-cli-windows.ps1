# Happy CLI Install Script for Windows (PowerShell)
# Run this in PowerShell as Administrator
# Or install per-user without admin (npm link won't work, use full path instead)

param(
    [switch]$UserInstall  # Skip admin steps, install for current user only
)

$ErrorActionPreference = "Stop"
$HAPPY_SERVER = "https://happy.tail146e68.ts.net"
$REPO_URL = "https://github.com/gearshift/happy-cli.git"
$INSTALL_DIR = "$env:USERPROFILE\happy-cli"

Write-Host "=== Happy CLI Installer (Self-hosted)" -ForegroundColor Cyan
Write-Host "Server: $HAPPY_SERVER" -ForegroundColor Cyan
Write-Host ""

# 1. Check prerequisites
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Yellow

# Check Node.js
try {
    $nodeVer = node --version
    Write-Host "  ✓ Node.js $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Node.js not found!" -ForegroundColor Red
    Write-Host "  Download from: https://nodejs.org (v18 or later)" -ForegroundColor Yellow
    exit 1
}

# Check npm
try {
    $npmVer = npm --version
    Write-Host "  ✓ npm $npmVer" -ForegroundColor Green
} catch {
    Write-Host "  ✗ npm not found!" -ForegroundColor Red
    exit 1
}

# Check git
try {
    $gitVer = git --version
    Write-Host "  ✓ $gitVer" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Git not found!" -ForegroundColor Red
    Write-Host "  Download from: https://git-scm.com/downloads/win" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# 2. Clone repo
Write-Host "[2/5] Cloning happy-cli..." -ForegroundColor Yellow
if (Test-Path $INSTALL_DIR) {
    Write-Host "  Directory exists. Pulling latest..."
    Set-Location $INSTALL_DIR
    git pull
} else {
    git clone $REPO_URL $INSTALL_DIR
    Set-Location $INSTALL_DIR
}
Write-Host "  ✓ Repo cloned to $INSTALL_DIR" -ForegroundColor Green
Write-Host ""

# 3. Install dependencies
Write-Host "[3/5] Installing dependencies..." -ForegroundColor Yellow
npm install
Write-Host "  ✓ Dependencies installed" -ForegroundColor Green
Write-Host ""

# 4. Build
Write-Host "[4/5] Building..." -ForegroundColor Yellow
npm run build
Write-Host "  ✓ Build complete" -ForegroundColor Green
Write-Host ""

# 5. Install globally
Write-Host "[5/5] Installing..." -ForegroundColor Yellow

if ($UserInstall) {
    # Per-user install — add to PATH manually
    $npmPrefix = npm config get prefix
    $targetDir = "$npmPrefix\node_modules\happy-coder"
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    Copy-Item -Recurse -Force .\* $targetDir
    # Link the bin scripts
    $binFiles = @("happy", "happy-mcp")
    foreach ($bin in $binFiles) {
        $binPath = "$npmPrefix\$bin"
        if (-not (Test-Path $binPath)) {
            New-Item -ItemType SymbolicLink -Path $binPath -Target "$targetDir\bin\$bin.mjs" -Force | Out-Null
        }
    }
    # Add npm prefix to PATH if not already there
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$npmPrefix*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$npmPrefix", "User")
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    }
    Write-Host "  ✓ Installed for current user" -ForegroundColor Green
} else {
    # System-wide install (Admin)
    npm link
    Write-Host "  ✓ Installed globally (Admin)" -ForegroundColor Green
}

Write-Host ""

# 6. Set environment variables
Write-Host "Setting HAPPY_SERVER_URL and HAPPY_WEBAPP_URL..." -ForegroundColor Yellow

[Environment]::SetEnvironmentVariable("HAPPY_SERVER_URL", $HAPPY_SERVER, "User")
[Environment]::SetEnvironmentVariable("HAPPY_WEBAPP_URL", $HAPPY_SERVER, "User")

# Also set for current session
$env:HAPPY_SERVER_URL = $HAPPY_SERVER
$env:HAPPY_WEBAPP_URL = $HAPPY_SERVER

Write-Host "  ✓ Environment variables set (persistent)" -ForegroundColor Green
Write-Host ""

# 7. Verify
Write-Host "Verifying installation..." -ForegroundColor Yellow
try {
    $ver = happy --version 2>$null
    Write-Host "  ✓ happy $ver" -ForegroundColor Green
} catch {
    Write-Host "  ! 'happy' not found in PATH yet." -ForegroundColor Yellow
    Write-Host "    You may need to restart your terminal or run:" -ForegroundColor Yellow
    Write-Host "    refreshenv" -ForegroundColor White
}

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Close and reopen your terminal (or run: refreshenv)" -ForegroundColor White
Write-Host "  2. Authenticate: happy auth" -ForegroundColor White
Write-Host "  3. Start a session: happy" -ForegroundColor White
Write-Host ""
Write-Host "Your phone's Happy app must also be configured:" -ForegroundColor Yellow
Write-Host "  Settings → Server → $HAPPY_SERVER" -ForegroundColor White
Write-Host ""
Write-Host "To update later:" -ForegroundColor Yellow
Write-Host "  cd $INSTALL_DIR && git pull && npm install && npm run build && npm link" -ForegroundColor White
