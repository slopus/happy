# Tauri Desktop Packaging

## Problem

Desktop app builds are manual and unsigned. macOS blocks unsigned apps. No CI pipeline exists for building cross-platform (macOS/Windows/Linux) distribution artifacts.

## Current State

- `pnpm tauri:build:production` works locally, outputs to `src-tauri/target/release/bundle/`
- Frontend: Expo web export bundled into Tauri shell
- No code signing, no notarization, no CI workflow
- Three config variants: production, preview, dev

## What's Needed

### 1. macOS Entitlements

Create `src-tauri/entitlements.plist`:
- `com.apple.security.network.client`
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

### 2. Signing Config (tauri.conf.json)

```json
"bundle": {
  "macOS": {
    "signingIdentity": null,
    "minimumSystemVersion": "10.13",
    "entitlements": "./entitlements.plist"
  }
}
```

Signing identity provided via `APPLE_SIGNING_IDENTITY` env var at build time.

### 3. GitHub Actions Workflow (`.github/workflows/tauri-release.yml`)

Matrix build on tag push (`v*`):
- `macos-latest` -> `.dmg`, `.app.tar.gz`
- `windows-latest` -> `.msi`, `.nsis`
- `ubuntu-latest` -> `.AppImage`, `.deb`

Uses `tauri-apps/tauri-action` — handles build + sign + upload to GitHub Release.

### 4. GitHub Secrets Required

| Secret | Platform | Purpose |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | macOS | Developer ID cert name |
| `APPLE_TEAM_ID` | macOS | 10-char team ID |
| `APPLE_ID` | macOS | Email for notarization |
| `APPLE_PASSWORD` | macOS | App-specific password |
| `APPLE_CERTIFICATE` | macOS | Base64 `.p12` cert |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | `.p12` password |

Windows signing optional (SmartScreen warning but installable).

### 5. OTA Strategy (future)

Point `frontendDist` at hosted web app URL instead of bundled `../dist`. JS updates deploy instantly without binary rebuild. Native updater only needed when Rust shell changes.

## Release Flow

1. Bump version in `tauri.conf.json`
2. `git tag v0.2.0 && git push --tags`
3. CI builds all platforms, creates GitHub Release with artifacts
4. Add download link on happy.engineering
