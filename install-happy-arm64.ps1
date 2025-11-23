# Complete One-Command Setup for happy-coder on Windows ARM64
# This script does EVERYTHING - clone, fix, download, build, install
# With robust error handling and fallback to run from source

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   happy-coder Windows ARM64 Installer" -ForegroundColor Cyan
Write-Host "   This will set up happy-coder to work exactly like normal" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$RepoUrl = "https://github.com/slopus/happy-cli.git"
$WorkDir = Join-Path $env:USERPROFILE "happy-cli-arm64-setup"
$CloneDir = Join-Path $WorkDir "happy-cli"
$BuildSuccessful = $false

# Create working directory
Write-Host "Creating working directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
Set-Location $WorkDir

# Clone repository
Write-Host ""
Write-Host "Step 1/6: Cloning happy-cli repository..." -ForegroundColor Yellow
if (Test-Path $CloneDir) {
    Write-Host "  Repository already exists, pulling latest..." -ForegroundColor Gray
    Set-Location $CloneDir
    git pull
} else {
    git clone $RepoUrl
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Failed to clone repository" -ForegroundColor Red
        exit 1
    }
    Set-Location $CloneDir
}

# Apply the ARM64 fix
Write-Host ""
Write-Host "Step 2/6: Applying ARM64 Windows fix..." -ForegroundColor Yellow

$UnpackToolsPath = "scripts\unpack-tools.cjs"
$content = Get-Content $UnpackToolsPath -Raw

# Check if fix is already applied
if ($content -match "arch === 'arm64'.*return 'arm64-win32'") {
    Write-Host "  ARM64 fix already applied" -ForegroundColor Green
} else {
    Write-Host "  Patching unpack-tools.cjs..." -ForegroundColor Gray

    # Find the line and add ARM64 support
    $lines = Get-Content $UnpackToolsPath
    $newLines = @()

    for ($i = 0; $i -lt $lines.Length; $i++) {
        $newLines += $lines[$i]

        # After the line with "} else if (platform === 'win32') {"
        # Add the ARM64 check before x64
        if ($lines[$i] -match "else if \(platform === 'win32'\)") {
            $newLines += "        if (arch === 'arm64') return 'arm64-win32';"
        }
    }

    $newLines | Set-Content $UnpackToolsPath
    Write-Host "  ARM64 fix applied successfully" -ForegroundColor Green
}

# Create temp directory for downloads
$TmpDir = Join-Path $env:TEMP "happy-cli-binaries-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

# Download binaries
Write-Host ""
Write-Host "Step 3/6: Downloading ARM64 Windows binaries..." -ForegroundColor Yellow

try {
    Write-Host "  - Downloading ripgrep (this may take a minute)..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-pc-windows-msvc.zip" -OutFile "$TmpDir\ripgrep.zip" -UserAgent "Mozilla/5.0" -TimeoutSec 300

    Write-Host "  - Downloading difftastic..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "https://github.com/Wilfred/difftastic/releases/download/0.67.0/difft-aarch64-pc-windows-msvc.zip" -OutFile "$TmpDir\difftastic.zip" -UserAgent "Mozilla/5.0" -TimeoutSec 300

    Write-Host "  Downloads complete" -ForegroundColor Green
}
catch {
    Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
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
Write-Host "Step 4/6: Extracting and packaging binaries..." -ForegroundColor Yellow

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
    tar -czf (Join-Path $CloneDir "$ArchivesDir\ripgrep-arm64-win32.tar.gz") *
    Pop-Location

    # Package difftastic
    Write-Host "  - Packaging difftastic..." -ForegroundColor Gray
    $DifftPkg = Join-Path $TmpDir "difftastic-package"
    New-Item -ItemType Directory -Path $DifftPkg -Force | Out-Null
    Copy-Item "$TmpDir\difftastic-extracted\difft.exe" -Destination $DifftPkg

    Push-Location $DifftPkg
    tar -czf (Join-Path $CloneDir "$ArchivesDir\difftastic-arm64-win32.tar.gz") *
    Pop-Location

    Write-Host "  Binaries packaged successfully" -ForegroundColor Green
}
catch {
    Write-Host "  Packaging failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Build the package
Write-Host ""
Write-Host "Step 5/6: Building happy-coder..." -ForegroundColor Yellow

# Check if yarn is installed
if (!(Get-Command yarn -ErrorAction SilentlyContinue)) {
    Write-Host "  Installing yarn..." -ForegroundColor Gray
    npm install -g yarn
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Failed to install yarn" -ForegroundColor Red
        exit 1
    }
}

# Function to attempt build
function Attempt-Build {
    param (
        [string]$AttemptName
    )

    Write-Host "  $AttemptName" -ForegroundColor Gray
    Write-Host "  - Installing dependencies..." -ForegroundColor Gray

    $ErrorActionPreference = 'Continue'
    yarn install --silent 2>&1 | Out-Null
    $installExitCode = $LASTEXITCODE

    if ($installExitCode -ne 0) {
        Write-Host "  - Dependency installation failed (exit code: $installExitCode)" -ForegroundColor Red
        return $false
    }

    Write-Host "  - Building package..." -ForegroundColor Gray

    # Remove old dist if it exists
    if (Test-Path "dist") {
        Remove-Item -Path "dist" -Recurse -Force
    }

    yarn build 2>&1 | Out-Null
    $buildExitCode = $LASTEXITCODE

    # Always check for dist folder regardless of exit code
    $distExists = Test-Path "dist"
    $hasDistFiles = $false

    if ($distExists) {
        $distFiles = Get-ChildItem -Path "dist" -File -ErrorAction SilentlyContinue
        $hasDistFiles = ($distFiles -and $distFiles.Count -gt 0)
    }

    if ($buildExitCode -ne 0 -or !$distExists -or !$hasDistFiles) {
        Write-Host "  - Build failed (exit: $buildExitCode, dist exists: $distExists, has files: $hasDistFiles)" -ForegroundColor Red
        return $false
    }

    Write-Host "  - Build successful" -ForegroundColor Green
    return $true
}

# Attempt 1: Regular build
$BuildSuccessful = Attempt-Build "Attempting build..."

# Attempt 2: Clean reinstall if first build failed
if (!$BuildSuccessful) {
    Write-Host ""
    Write-Host "  Build failed. Trying clean reinstall (npm suggested fix)..." -ForegroundColor Yellow
    Write-Host "  - Removing package-lock.json and node_modules..." -ForegroundColor Gray

    Remove-Item -Path "package-lock.json" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "node_modules" -Recurse -Force -ErrorAction SilentlyContinue

    $BuildSuccessful = Attempt-Build "Retrying build after clean..."
}

# If build still failed, set up source-based execution
if (!$BuildSuccessful) {
    Write-Host ""
    Write-Host "  Build failed after retry. Setting up fallback mode..." -ForegroundColor Yellow
    Write-Host "  (happy will run from source using tsx instead of compiled code)" -ForegroundColor Gray

    # Ensure tsx is available
    Write-Host "  - Installing tsx globally..." -ForegroundColor Gray
    npm install -g tsx
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Failed to install tsx" -ForegroundColor Red
        exit 1
    }

    # Create a wrapper script that runs from source
    $WrapperContent = @"
#!/usr/bin/env node
// Wrapper to run happy-coder from source on Windows ARM64
// This is used when the build fails due to Rollup ARM64 issues

const { spawn } = require('child_process');
const path = require('path');

const sourceDir = '$($CloneDir.Replace('\', '\\'))';
const mainFile = path.join(sourceDir, 'src', 'index.ts');

const args = process.argv.slice(2);

const child = spawn('tsx', [mainFile, ...args], {
    stdio: 'inherit',
    cwd: sourceDir,
    env: { ...process.env }
});

child.on('exit', (code) => {
    process.exit(code || 0);
});
"@

    $WrapperPath = Join-Path $CloneDir "happy-wrapper.cjs"
    $WrapperContent | Set-Content -Path $WrapperPath -Encoding UTF8

    # Update package.json to use the wrapper
    $PackageJsonPath = Join-Path $CloneDir "package.json"
    $packageJson = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json

    # Store original bin value
    $originalBin = $packageJson.bin

    # Update bin to point to wrapper
    $packageJson.bin = @{
        "happy" = "./happy-wrapper.cjs"
    }

    # If there are other binaries, add them pointing to the wrapper too
    if ($originalBin -is [hashtable] -or $originalBin -is [PSCustomObject]) {
        $originalBin.PSObject.Properties | ForEach-Object {
            if ($_.Name -ne "happy") {
                $packageJson.bin[$_.Name] = "./happy-wrapper.cjs"
            }
        }
    }

    $packageJson | ConvertTo-Json -Depth 10 | Set-Content -Path $PackageJsonPath

    Write-Host "  - Fallback mode configured" -ForegroundColor Green
}

# Install globally
Write-Host ""
Write-Host "Step 6/6: Installing globally..." -ForegroundColor Yellow

# Unlink if already linked
npm unlink happy-coder 2>$null

# Link the package
npm link
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Failed to link package globally" -ForegroundColor Red
    Write-Host ""
    Write-Host "You can still run happy from the source directory:" -ForegroundColor Yellow
    Write-Host "  cd $CloneDir" -ForegroundColor Gray
    if ($BuildSuccessful) {
        Write-Host "  node dist/index.js" -ForegroundColor Gray
    } else {
        Write-Host "  npx tsx src/index.ts" -ForegroundColor Gray
    }
    exit 1
}

Write-Host "  Installed successfully" -ForegroundColor Green

# Cleanup
Write-Host ""
Write-Host "Cleaning up..." -ForegroundColor Yellow
Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

# Success message
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

if (!$BuildSuccessful) {
    Write-Host "NOTE: Running in fallback mode (from source with tsx)" -ForegroundColor Yellow
    Write-Host "This is slightly slower but fully functional." -ForegroundColor Yellow
    Write-Host ""
}

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
Write-Host "Download Happy app:" -ForegroundColor White
Write-Host "   iOS:     https://apps.apple.com/us/app/happy-claude-code-client/id6748571505" -ForegroundColor Gray
Write-Host "   Android: https://play.google.com/store/apps/details?id=com.ex3ndr.happy" -ForegroundColor Gray
Write-Host ""
Write-Host "Happy coding!" -ForegroundColor Magenta
Write-Host ""

# Ask if user wants to start happy now
$response = Read-Host "Would you like to start happy now? (y/N)"
if ($response -eq 'y' -or $response -eq 'Y') {
    Write-Host ""
    Write-Host "Starting happy..." -ForegroundColor Green
    happy
}
