# Complete One-Command Setup for happy-coder on Windows ARM64
# This script does EVERYTHING - clone, fix, download, build, install

Write-Host @"
╔══════════════════════════════════════════════════════════════╗
║   happy-coder Windows ARM64 Installer                        ║
║   This will set up happy-coder to work exactly like normal   ║
╚══════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

Write-Host ""

# Configuration
$RepoUrl = "https://github.com/slopus/happy-cli.git"
$WorkDir = Join-Path $env:USERPROFILE "happy-cli-arm64-setup"
$CloneDir = Join-Path $WorkDir "happy-cli"

# Create working directory
Write-Host "📁 Creating working directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
Set-Location $WorkDir

# Clone repository
Write-Host ""
Write-Host "⬇️  Step 1/6: Cloning happy-cli repository..." -ForegroundColor Yellow
if (Test-Path $CloneDir) {
    Write-Host "  Repository already exists, pulling latest..." -ForegroundColor Gray
    Set-Location $CloneDir
    git pull
} else {
    git clone $RepoUrl
    Set-Location $CloneDir
}

# Apply the ARM64 fix
Write-Host ""
Write-Host "🔧 Step 2/6: Applying ARM64 Windows fix..." -ForegroundColor Yellow

$UnpackToolsPath = "scripts\unpack-tools.cjs"
$content = Get-Content $UnpackToolsPath -Raw

# Check if fix is already applied
if ($content -match "if \(arch === 'arm64'\) return 'arm64-win32';") {
    Write-Host "  ✓ ARM64 fix already applied" -ForegroundColor Green
} else {
    Write-Host "  Patching unpack-tools.cjs..." -ForegroundColor Gray

    # Apply the fix
    $content = $content -replace `
        "(\s+\} else if \(platform === 'win32'\) \{)`r?`n(\s+if \(arch === 'x64'\))",
        "`$1`r`n        if (arch === 'arm64') return 'arm64-win32';`r`n`$2"

    Set-Content -Path $UnpackToolsPath -Value $content
    Write-Host "  ✓ ARM64 fix applied successfully" -ForegroundColor Green
}

# Create temp directory for downloads
$TmpDir = Join-Path $env:TEMP "happy-cli-binaries-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

# Download binaries
Write-Host ""
Write-Host "⬇️  Step 3/6: Downloading ARM64 Windows binaries..." -ForegroundColor Yellow

try {
    Write-Host "  - Downloading ripgrep (this may take a minute)..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-pc-windows-msvc.zip" `
        -OutFile "$TmpDir\ripgrep.zip" `
        -UserAgent "Mozilla/5.0" `
        -TimeoutSec 300

    Write-Host "  - Downloading difftastic..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "https://github.com/Wilfred/difftastic/releases/download/0.67.0/difft-aarch64-pc-windows-msvc.zip" `
        -OutFile "$TmpDir\difftastic.zip" `
        -UserAgent "Mozilla/5.0" `
        -TimeoutSec 300

    Write-Host "  ✓ Downloads complete" -ForegroundColor Green
}
catch {
    Write-Host "  ✗ Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please download manually from:" -ForegroundColor Yellow
    Write-Host "  Ripgrep:    https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-pc-windows-msvc.zip"
    Write-Host "  Difftastic: https://github.com/Wilfred/difftastic/releases/download/0.67.0/difft-aarch64-pc-windows-msvc.zip"
    Write-Host ""
    Write-Host "Place them in: $TmpDir" -ForegroundColor Yellow
    Write-Host "Then press Enter to continue..."
    Read-Host
}

# Extract binaries
Write-Host ""
Write-Host "📦 Step 4/6: Extracting and packaging binaries..." -ForegroundColor Yellow

try {
    # Extract archives
    Write-Host "  - Extracting ripgrep..." -ForegroundColor Gray
    Expand-Archive -Path "$TmpDir\ripgrep.zip" -DestinationPath "$TmpDir\ripgrep-extracted" -Force

    Write-Host "  - Extracting difftastic..." -ForegroundColor Gray
    Expand-Archive -Path "$TmpDir\difftastic.zip" -DestinationPath "$TmpDir\difftastic-extracted" -Force

    # Create archives directory
    $ArchivesDir = "tools\archives"
    New-Item -ItemType Directory -Path $ArchivesDir -Force | Out-Null

    # Package ripgrep
    Write-Host "  - Packaging ripgrep..." -ForegroundColor Gray
    $RipgrepDir = Get-ChildItem -Path "$TmpDir\ripgrep-extracted" -Directory | Select-Object -First 1
    $RipgrepPkg = Join-Path $TmpDir "ripgrep-package"
    New-Item -ItemType Directory -Path $RipgrepPkg -Force | Out-Null
    Copy-Item "$($RipgrepDir.FullName)\rg.exe" -Destination $RipgrepPkg

    Push-Location $RipgrepPkg
    tar -czf "$PWD\..\..\..\$ArchivesDir\ripgrep-arm64-win32.tar.gz" *
    Pop-Location

    # Package difftastic
    Write-Host "  - Packaging difftastic..." -ForegroundColor Gray
    $DifftPkg = Join-Path $TmpDir "difftastic-package"
    New-Item -ItemType Directory -Path $DifftPkg -Force | Out-Null
    Copy-Item "$TmpDir\difftastic-extracted\difft.exe" -Destination $DifftPkg

    Push-Location $DifftPkg
    tar -czf "$PWD\..\..\..\$ArchivesDir\difftastic-arm64-win32.tar.gz" *
    Pop-Location

    Write-Host "  ✓ Binaries packaged successfully" -ForegroundColor Green
}
catch {
    Write-Host "  ✗ Packaging failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Build the package
Write-Host ""
Write-Host "🔨 Step 5/6: Building happy-coder..." -ForegroundColor Yellow

# Check if yarn is installed
if (!(Get-Command yarn -ErrorAction SilentlyContinue)) {
    Write-Host "  Installing yarn..." -ForegroundColor Gray
    npm install -g yarn
}

Write-Host "  - Installing dependencies..." -ForegroundColor Gray
yarn install --silent

Write-Host "  - Building package..." -ForegroundColor Gray
yarn build

Write-Host "  ✓ Build complete" -ForegroundColor Green

# Install globally
Write-Host ""
Write-Host "📲 Step 6/6: Installing globally..." -ForegroundColor Yellow

# Unlink if already linked
npm unlink happy-coder 2>$null

# Link the package
npm link

Write-Host "  ✓ Installed successfully" -ForegroundColor Green

# Cleanup
Write-Host ""
Write-Host "🧹 Cleaning up..." -ForegroundColor Yellow
Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

# Success message
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅ Installation Complete!                                   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "You can now use happy-coder just like any other user:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To start Happy:" -ForegroundColor White
Write-Host "    PS> happy" -ForegroundColor Yellow
Write-Host ""
Write-Host "  To start Codex:" -ForegroundColor White
Write-Host "    PS> happy codex" -ForegroundColor Yellow
Write-Host ""
Write-Host "A QR code will appear - scan it with your phone's Happy app!" -ForegroundColor Cyan
Write-Host ""
Write-Host "📱 Download Happy app:" -ForegroundColor White
Write-Host "   iOS:     https://apps.apple.com/us/app/happy-claude-code-client/id6748571505" -ForegroundColor Gray
Write-Host "   Android: https://play.google.com/store/apps/details?id=com.ex3ndr.happy" -ForegroundColor Gray
Write-Host ""
Write-Host "🎉 Happy coding!" -ForegroundColor Magenta
Write-Host ""

# Ask if user wants to start happy now
$response = Read-Host "Would you like to start happy now? (y/N)"
if ($response -eq 'y' -or $response -eq 'Y') {
    Write-Host ""
    Write-Host "Starting happy..." -ForegroundColor Green
    happy
}
