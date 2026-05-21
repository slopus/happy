# Set up a Windows machine as a happy CLI client of an existing self-hosted server.
#
# What it does:
#   - Verifies Node 20+ on PATH
#   - Installs happy@1.1.10-beta.4 globally
#   - Writes %USERPROFILE%\.happy\settings.json pointing at $HappyServerUrl
#   - Either copies an existing access.key (-AccessKeyPath) or runs
#     scripts/happy-register.mjs to mint a fresh account (-Register)
#   - Optionally creates a Chrome --app shortcut for the multiplexer
#   - Optionally starts a persistent SSH tunnel (for HTTP -> localhost so
#     browser secure context works for crypto.subtle)
#
# Usage (existing-account):
#   .\setup-happy-client-windows.ps1 `
#       -HappyServerUrl 'http://192.0.2.10:3006' `
#       -AccessKeyPath  'C:\path\to\access.key'
#
# Usage (fresh-account bootstrap, also starts the SSH tunnel + shortcut):
#   .\setup-happy-client-windows.ps1 `
#       -HappyServerUrl   'http://localhost:3006' `
#       -HappyBasicAuthUrl 'http://happy:URLENC@192.0.2.10:3006' `
#       -SshTunnelHost    'ubuntu' `
#       -SshTunnelPort    3006 `
#       -InstallShortcut  $true `
#       -Register

param(
    [Parameter(Mandatory=$true)] [string]$HappyServerUrl,
    [string]$HappyBasicAuthUrl   = '',
    [string]$AccessKeyPath       = '',
    [string]$SshTunnelHost       = '',
    [int]   $SshTunnelPort       = 3006,
    [bool]  $InstallShortcut     = $false,
    [string]$HappyCliVersion     = '1.1.10-beta.4',
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
function Red($s)   { Write-Host $s -ForegroundColor Red }
function Green($s) { Write-Host $s -ForegroundColor Green }
function Hl($s)    { Write-Host $s -ForegroundColor Cyan }

# --- Node ---
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Red 'node not found on PATH. Install Node 20+ first (nvm-windows or nodejs.org).'; exit 1 }
$nodeMajor = (& node --version).TrimStart('v').Split('.')[0] -as [int]
if ($nodeMajor -lt 20) { Red "Node 20+ required (have $(node --version))"; exit 1 }

# --- happy CLI ---
$installed = $false
try { $installed = (& happy --version 2>&1 | Out-String) -match $HappyCliVersion } catch {}
if (-not $installed) {
    Hl "Installing happy@$HappyCliVersion globally..."
    npm install -g "happy@$HappyCliVersion" | Select-Object -Last 3
}

# --- settings.json ---
$dir = Join-Path $env:USERPROFILE '.happy'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
@{
    schemaVersion       = 2
    onboardingCompleted = $false
    serverUrl           = $HappyServerUrl
    webappUrl           = $HappyServerUrl
} | ConvertTo-Json | Out-File -FilePath (Join-Path $dir 'settings.json') -Encoding utf8 -NoNewline
Hl "Wrote $dir\settings.json (serverUrl=$HappyServerUrl)"

# --- credentials ---
$keyPath = Join-Path $dir 'access.key'
if (Test-Path $keyPath) {
    Hl "$keyPath already exists — leaving in place"
} elseif ($AccessKeyPath -and (Test-Path $AccessKeyPath)) {
    Copy-Item -Path $AccessKeyPath -Destination $keyPath -Force
    Green "Copied access.key from $AccessKeyPath"
} elseif ($Register) {
    if (-not $HappyBasicAuthUrl) { Red 'Register requested but -HappyBasicAuthUrl not provided'; exit 1 }
    $regScript = Join-Path $PSScriptRoot 'happy-register.mjs'
    if (-not (Test-Path $regScript)) { Red "scripts\happy-register.mjs not next to this script"; exit 1 }
    Hl "Registering fresh account..."
    & node $regScript $HappyBasicAuthUrl
} else {
    Red 'No access.key, no -AccessKeyPath, no -Register. Provide one to authenticate.'; exit 1
}

# --- SSH tunnel (optional) ---
if ($SshTunnelHost) {
    $existing = Get-Process ssh -ErrorAction SilentlyContinue | Where-Object {
        try { (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -match "-L\s+${SshTunnelPort}:" } catch { $false }
    }
    if ($existing) {
        Hl "SSH tunnel already running (PID $($existing[0].Id))"
    } else {
        Hl "Starting SSH tunnel: -L ${SshTunnelPort}:127.0.0.1:${SshTunnelPort} -N $SshTunnelHost"
        Start-Process ssh -ArgumentList '-L', "${SshTunnelPort}:127.0.0.1:${SshTunnelPort}", '-N', $SshTunnelHost -WindowStyle Hidden -PassThru | Select-Object Id
    }
}

# --- Chrome shortcut (optional) ---
if ($InstallShortcut) {
    $chrome = $null
    foreach ($p in 'C:\Program Files\Google\Chrome\Application\chrome.exe',
                   'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
                   "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") {
        if (Test-Path $p) { $chrome = $p; break }
    }
    if (-not $chrome) {
        Red 'Chrome not found — skipping shortcut creation'
    } else {
        $profileDir = Join-Path $env:LOCALAPPDATA 'HappyDesktop'
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Happy (Multi).lnk'
        $url = if ($SshTunnelHost) { "http://localhost:${SshTunnelPort}/multi" } else { "$HappyServerUrl/multi" }
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($shortcutPath)
        $sc.TargetPath = $chrome
        $sc.Arguments  = "--app=`"$url`" --user-data-dir=`"$profileDir`""
        $sc.WorkingDirectory = $profileDir
        $sc.IconLocation = $chrome
        $sc.Save()
        Green "Created shortcut: $shortcutPath -> $url"
    }
}

# --- verify ---
Green "`n✓ Setup complete. Verification:"
happy doctor 2>&1 | Select-String -Pattern 'Server URL|Authent|Happy CLI Version' | Select-Object -First 6
Write-Host "`n  Try:  happy claude   (in any project directory)"
