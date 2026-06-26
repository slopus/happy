<#
.SYNOPSIS
  Install/upgrade the Happy CLI from the gearshift/happy monorepo on Windows.

.DESCRIPTION
  Clones or updates gearshift/happy, installs monorepo dependencies with
  Corepack/pnpm, builds packages/happy-cli, writes user-local happy/happy-mcp
  command shims, and persists self-hosted Happy URLs for the current user.

.PARAMETER RepoUrl
  Git repository URL. Defaults to https://github.com/gearshift/happy.git

.PARAMETER InstallDir
  Monorepo checkout directory. Defaults to %USERPROFILE%\happy

.PARAMETER Ref
  Branch/tag/ref to install. Defaults to main.

.PARAMETER ServerUrl
  Happy API server URL. Defaults to Jon's self-hosted API hostname.

.PARAMETER WebappUrl
  Happy web app URL. Defaults to Jon's self-hosted web hostname.

.PARAMETER BinDir
  Directory for user-local command shims. Defaults to %LOCALAPPDATA%\Programs\happy-cli\bin

.PARAMETER InstallMode
  'User' creates user-local command shims. 'NpmLink' runs npm link in packages/happy-cli.
#>

[CmdletBinding()]
param(
    [string]$RepoUrl = $(if ($env:HAPPY_REPO_URL) { $env:HAPPY_REPO_URL } else { "https://github.com/gearshift/happy.git" }),
    [string]$InstallDir = $(if ($env:HAPPY_REPO_DIR) { $env:HAPPY_REPO_DIR } else { Join-Path $env:USERPROFILE "happy" }),
    [string]$Ref = $(if ($env:HAPPY_REF) { $env:HAPPY_REF } else { "main" }),
    [string]$ServerUrl = $(if ($env:HAPPY_SERVER_URL) { $env:HAPPY_SERVER_URL } else { "https://happy-api.tail146e68.ts.net" }),
    [string]$WebappUrl = $(if ($env:HAPPY_WEBAPP_URL) { $env:HAPPY_WEBAPP_URL } else { "https://happy.tail146e68.ts.net" }),
    [string]$BinDir = $(if ($env:HAPPY_CLI_BIN_DIR) { $env:HAPPY_CLI_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\happy-cli\bin" }),
    [ValidateSet("User", "NpmLink")]
    [string]$InstallMode = $(if ($env:HAPPY_CLI_INSTALL_MODE) { $env:HAPPY_CLI_INSTALL_MODE } else { "User" })
)

$ErrorActionPreference = "Stop"
$CliDir = Join-Path $InstallDir "packages\happy-cli"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Assert-NodeVersion {
    Assert-Command node
    $major = [int](& node -p "Number(process.versions.node.split('.')[0])")
    if ($major -lt 20) {
        $version = & node --version
        throw "Node.js 20+ is required; found $version"
    }
}

function Remove-UntrackedFile {
    param(
        [string]$RelativePath,
        [string]$Description
    )

    $path = Join-Path $InstallDir $RelativePath
    if (-not (Test-Path $path)) {
        return
    }

    $trackedPath = & git -C $InstallDir ls-files -- $RelativePath
    if ($trackedPath) {
        return
    }

    Write-Step "Removing untracked $Description at $path"
    Remove-Item -Force $path
}

function Remove-GeneratedFiles {
    Remove-UntrackedFile -RelativePath "package-lock.json" -Description "npm lockfile"
    Remove-UntrackedFile -RelativePath "yarn.lock" -Description "Yarn lockfile"
    Remove-UntrackedFile -RelativePath "packages\happy-cli\package-lock.json" -Description "CLI npm lockfile"
    Remove-UntrackedFile -RelativePath "packages\happy-cli\yarn.lock" -Description "CLI Yarn lockfile"
    Remove-UntrackedFile -RelativePath "upgrade-happy-cli.ps1" -Description "downloaded legacy upgrade script"
    Remove-UntrackedFile -RelativePath "install-happy-cli.ps1" -Description "downloaded installer script"
}

function Assert-HappyMonorepoOrigin {
    $origin = & git -C $InstallDir remote get-url origin 2>$null
    if (-not (
        $origin -like "*github.com/gearshift/happy.git" -or
        $origin -like "*github.com:gearshift/happy.git" -or
        $origin -like "*github.com/slopus/happy.git" -or
        $origin -like "*github.com:slopus/happy.git"
    )) {
        throw "$InstallDir is a git checkout, but its origin is '$origin' instead of the Happy monorepo. Use HAPPY_REPO_DIR=%USERPROFILE%\happy-monorepo or move the old checkout out of the way."
    }
}

function Update-Repo {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Step "Updating existing happy monorepo checkout at $InstallDir"
        Assert-HappyMonorepoOrigin
        Remove-GeneratedFiles
        $dirty = & git -C $InstallDir status --porcelain
        if ($dirty) {
            throw "$InstallDir has uncommitted changes:`n$dirty`nCommit/stash them or set HAPPY_REPO_DIR to a clean checkout."
        }
        & git -C $InstallDir fetch origin $Ref
        & git -C $InstallDir checkout $Ref
        & git -C $InstallDir pull --ff-only origin $Ref
    }
    elseif (Test-Path $InstallDir) {
        throw "$InstallDir exists but is not a git checkout"
    }
    else {
        Write-Step "Cloning $RepoUrl into $InstallDir"
        & git clone --branch $Ref $RepoUrl $InstallDir
    }

    if (-not (Test-Path $CliDir)) {
        throw "Expected CLI package at $CliDir, but it was not found"
    }
}

function Build-Cli {
    Write-Step "Installing monorepo dependencies and building Happy CLI"
    Push-Location $InstallDir
    try {
        & corepack enable
        & corepack pnpm install --frozen-lockfile
        & corepack pnpm --filter happy build
    }
    finally {
        Pop-Location
    }
}

function Add-UserPathEntry {
    param([string]$PathEntry)

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if ($currentUserPath) {
        $entries = $currentUserPath -split ";" | Where-Object { $_ }
    }

    $alreadyPresent = $entries | Where-Object { $_.TrimEnd("\") -ieq $PathEntry.TrimEnd("\") }
    if (-not $alreadyPresent) {
        $newPath = if ($currentUserPath) { "$currentUserPath;$PathEntry" } else { $PathEntry }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        $env:Path = "$env:Path;$PathEntry"
        Write-Host "Added $PathEntry to the current user's PATH. Open a new terminal if this one does not pick it up."
    }
}

function Write-CmdShim {
    param(
        [string]$Name,
        [string]$Target
    )

    $cmdPath = Join-Path $BinDir "$Name.cmd"
    $ps1Path = Join-Path $BinDir "$Name.ps1"

    $cmdContent = @"
@echo off
set "HAPPY_SERVER_URL=$ServerUrl"
set "HAPPY_WEBAPP_URL=$WebappUrl"
node "$Target" %*
"@
    Set-Content -Path $cmdPath -Value $cmdContent -Encoding ASCII

    $escapedTarget = $Target.Replace("'", "''")
    $ps1Content = @"
`$env:HAPPY_SERVER_URL = '$ServerUrl'
`$env:HAPPY_WEBAPP_URL = '$WebappUrl'
& node '$escapedTarget' @args
exit `$LASTEXITCODE
"@
    Set-Content -Path $ps1Path -Value $ps1Content -Encoding UTF8
}

function Install-UserShims {
    Write-Step "Installing user-local command shims in $BinDir"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

    Write-CmdShim -Name "happy" -Target (Join-Path $CliDir "bin\happy.mjs")

    $mcpTarget = Join-Path $CliDir "bin\happy-mcp.mjs"
    if (Test-Path $mcpTarget) {
        Write-CmdShim -Name "happy-mcp" -Target $mcpTarget
    }

    [Environment]::SetEnvironmentVariable("HAPPY_SERVER_URL", $ServerUrl, "User")
    [Environment]::SetEnvironmentVariable("HAPPY_WEBAPP_URL", $WebappUrl, "User")
    $env:HAPPY_SERVER_URL = $ServerUrl
    $env:HAPPY_WEBAPP_URL = $WebappUrl
    Add-UserPathEntry -PathEntry $BinDir
}

function Install-NpmLink {
    Write-Step "Linking CLI package with npm link"
    Push-Location $CliDir
    try {
        & npm link
    }
    finally {
        Pop-Location
    }

    [Environment]::SetEnvironmentVariable("HAPPY_SERVER_URL", $ServerUrl, "User")
    [Environment]::SetEnvironmentVariable("HAPPY_WEBAPP_URL", $WebappUrl, "User")
    $env:HAPPY_SERVER_URL = $ServerUrl
    $env:HAPPY_WEBAPP_URL = $WebappUrl
}

function Main {
    Assert-Command git
    Assert-Command corepack
    Assert-Command npm
    Assert-NodeVersion

    Update-Repo
    Build-Cli

    switch ($InstallMode) {
        "User" { Install-UserShims }
        "NpmLink" { Install-NpmLink }
    }

    Write-Step "Verifying installed CLI"
    try {
        & happy --version
    }
    catch {
        Write-Warning "Could not run 'happy --version' in this shell. Open a new terminal and try again."
    }

    Write-Host ""
    Write-Host "Done." -ForegroundColor Green
    Write-Host ""
    Write-Host "Happy monorepo checkout: $InstallDir"
    Write-Host "Happy CLI package: $CliDir"
    Write-Host "Command: happy"
    Write-Host "Server URL: $ServerUrl"
    Write-Host "Web app URL: $WebappUrl"
    Write-Host ""
    Write-Host "If this is the first install on this host, run:"
    Write-Host "  happy auth"
}

Main
