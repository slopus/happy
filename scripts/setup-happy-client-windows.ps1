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
    [string]$HappyServerUrl     = $env:HAPPY_SERVER_URL,
    [string]$HappyBasicAuthUrl  = $env:HAPPY_BASIC_AUTH_URL,
    [string]$AccessKeyPath      = '',
    [string]$SshTunnelHost      = $env:HAPPY_SSH_TUNNEL_HOST,
    [int]   $SshTunnelPort      = $(if ($env:HAPPY_PUBLIC_PORT) { [int]$env:HAPPY_PUBLIC_PORT } else { 3006 }),
    [bool]  $InstallShortcut    = $false,
    [string]$HappyCliVersion    = $(if ($env:HAPPY_CLI_VERSION) { $env:HAPPY_CLI_VERSION } else { '1.1.10-beta.4' }),
    [switch]$Register
)

$ErrorActionPreference = 'Stop'

# Load repo-root .env if present (one source of truth — see .env.example).
$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*#') { return }                 # comment line
        if ($_ -match '^\s*$') { return }                 # blank line
        if ($_ -match '^\s*([^=]+?)\s*=\s*(.*)\s*$') {
            $k = $matches[1].Trim()
            $v = $matches[2].Trim() -replace "^['""]|['""]$",''
            # primitive ${VAR} expansion
            while ($v -match '\$\{([^}]+)\}') {
                $vn = $matches[1]
                $vv = (Get-Item "env:$vn" -ErrorAction SilentlyContinue).Value
                $v  = $v -replace ('\$\{' + [regex]::Escape($vn) + '\}'), ($vv -as [string])
            }
            Set-Item "env:$k" $v
        }
    }
    if (-not $HappyServerUrl)    { $HappyServerUrl    = $env:HAPPY_SERVER_URL }
    if (-not $HappyBasicAuthUrl) { $HappyBasicAuthUrl = $env:HAPPY_BASIC_AUTH_URL }
    if (-not $SshTunnelHost)     { $SshTunnelHost     = $env:HAPPY_SSH_TUNNEL_HOST }
}

if (-not $HappyServerUrl) {
    Write-Host 'HappyServerUrl required (pass -HappyServerUrl or set HAPPY_SERVER_URL in .env)' -ForegroundColor Red
    exit 1
}
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

# --- bake auth into the Chrome HappyDesktop profile (optional) ---
# Browser webapp has isolated localStorage per origin; "Create Account" in
# the webapp mints a NEW server account instead of importing the CLI's
# ~/.happy/access.key. Run the injector to bridge that gap, so future
# Happy (Multi) shortcut launches land already-authenticated as the same
# identity the CLI uses.
if ($InstallShortcut -and (Test-Path $keyPath) -and $env:HAPPY_TLS_URL) {
    Hl 'Injecting CLI auth into the HappyDesktop Chrome profile (persistent)...'
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {
        try { (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -match 'HappyDesktop' } catch { $false }
    } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
    $injector = Join-Path $PSScriptRoot 'inject-happy-auth-windows.mjs'
    if (Test-Path $injector) {
        $env:HAPPY_TARGET_URL = "$($env:HAPPY_TLS_URL)/multi"
        & node $injector
    } else {
        Red "Injector not found at $injector"
    }
}

# --- verify ---
Green "`n✓ Setup complete. Verification:"
happy doctor 2>&1 | Select-String -Pattern 'Server URL|Authent|Happy CLI Version' | Select-Object -First 6
Write-Host "`n  Try:  happy claude   (in any project directory)"
