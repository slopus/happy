# Building Happy for ARM64 Laptops

This guide covers building the Happy desktop application for ARM64 architecture (Apple Silicon Macs, ARM64 Linux laptops, and Windows on ARM).

## Overview

Happy uses **Tauri** (a Rust-based desktop framework) that wraps the Expo web build into a native desktop application. This approach provides excellent ARM64 support because:

- The web build is pure JavaScript (no native compilation needed)
- All native dependencies have web fallbacks using browser APIs
- Tauri's Rust runtime compiles cleanly for all ARM64 targets
- Encryption uses WebAssembly (`libsodium-wrappers`) instead of native modules

## Prerequisites

### All Platforms

1. **Node.js 18+** and **Yarn**
   ```bash
   node --version  # Should be 18+
   yarn --version
   ```

2. **Rust** (install from [rustup.rs](https://rustup.rs/))
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. **Install Dependencies**
   ```bash
   yarn install
   ```

### Linux ARM64 Specific

Install system dependencies for webkit2gtk:

**Debian/Ubuntu:**
```bash
sudo apt-get update
sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libgtk-3-dev \
    patchelf
```

**Fedora/RHEL:**
```bash
sudo dnf install -y \
    webkit2gtk4.1-devel \
    openssl-devel \
    curl \
    wget \
    file \
    libappindicator-gtk3-devel \
    librsvg2-devel \
    patchelf
```

**Arch Linux:**
```bash
sudo pacman -Sy \
    webkit2gtk-4.1 \
    base-devel \
    curl \
    wget \
    file \
    openssl \
    gtk3 \
    libappindicator-gtk3 \
    librsvg \
    patchelf
```

### macOS ARM64 Specific (Apple Silicon)

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **No additional dependencies needed** - macOS includes WebKit by default

### Windows ARM64 Specific

1. **Visual Studio 2022** with:
   - Desktop development with C++
   - Windows 11 SDK
   - ARM64 build tools

2. **WebView2 Runtime** (usually pre-installed on Windows 11)

## Installing ARM64 Rust Targets

The Rust toolchain needs platform-specific targets for cross-compilation:

```bash
# For Linux ARM64
rustup target add aarch64-unknown-linux-gnu

# For macOS ARM64 (Apple Silicon)
rustup target add aarch64-apple-darwin

# For Windows ARM64
rustup target add aarch64-pc-windows-msvc
```

**Note:** All three targets are already installed if you followed the setup above.

## Building for ARM64

### Development Mode

Run the app in development mode (hot reload enabled):

```bash
yarn desktop:dev
```

This will:
1. Start the Expo dev server on `http://localhost:8081`
2. Launch Tauri in dev mode, loading the live dev server
3. Enable hot module reloading for instant updates

### Production Builds

#### Build for Your Current Platform

```bash
yarn desktop:build
```

This automatically detects your platform and builds for it.

#### Build for Specific ARM64 Platforms

**Linux ARM64:**
```bash
yarn desktop:build:arm64-linux
```

Output: `src-tauri/target/aarch64-unknown-linux-gnu/release/happy`

**macOS ARM64 (Apple Silicon):**
```bash
yarn desktop:build:arm64-mac
```

Output: `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Happy_*.dmg`

**Windows ARM64:**
```bash
yarn desktop:build:arm64-windows
```

Output: `src-tauri/target/aarch64-pc-windows-msvc/release/happy.exe`

#### Build for All ARM64 Platforms at Once

```bash
yarn desktop:build:all-arm64
```

This creates builds for Linux, macOS, and Windows ARM64 in a single command.

## Cross-Compilation Notes

### Building on x86_64 for ARM64

**Linux → Linux ARM64:**
- Requires ARM64 cross-compilation toolchain
- Install: `sudo apt-get install gcc-aarch64-linux-gnu`
- May need to configure linker in `.cargo/config.toml`

**macOS Intel → macOS ARM64:**
- Supported natively by Xcode
- Just use the `aarch64-apple-darwin` target

**Windows x64 → Windows ARM64:**
- Requires Visual Studio with ARM64 tools
- Cross-compilation works seamlessly

### Building on ARM64 for ARM64 (Native)

If you're already on an ARM64 laptop, just run:

```bash
yarn desktop:build
```

Tauri will automatically build for your native architecture.

## Troubleshooting

### Missing System Dependencies (Linux)

**Error:** `Package webkit2gtk-4.1 was not found`

**Solution:**
```bash
sudo apt-get install libwebkit2gtk-4.1-dev
```

### Rust Linker Errors

**Error:** `error: linker 'aarch64-linux-gnu-gcc' not found`

**Solution:** Install cross-compilation toolchain:
```bash
sudo apt-get install gcc-aarch64-linux-gnu
```

Then create `.cargo/config.toml`:
```toml
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
```

### WebView2 Missing (Windows)

**Error:** WebView2 Runtime not found

**Solution:** Download and install from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### Slow Builds

**Solution:** Enable parallel compilation:
```bash
export CARGO_BUILD_JOBS=4  # Adjust based on CPU cores
yarn desktop:build:arm64-linux
```

## Architecture Details

### How It Works

1. **Web Export:** `yarn desktop:export` runs `expo export --platform web` to create an optimized web bundle in `/dist`

2. **Tauri Bundling:** Tauri embeds the web bundle into a native application using:
   - **Linux:** WebKitGTK for rendering
   - **macOS:** WKWebView (native WebKit)
   - **Windows:** WebView2 (Chromium-based)

3. **Native APIs:** Tauri provides Rust-based APIs for:
   - HTTP requests (`@tauri-apps/plugin-http`)
   - Logging (`tauri-plugin-log`)
   - File system access
   - System tray integration

### Why This Works for ARM64

- **No Native React Native Modules:** The web build doesn't use native React Native dependencies like `react-native-mmkv` or `react-native-quick-base64`

- **Browser API Fallbacks:** Platform-specific code uses `.web.tsx` variants that rely on browser APIs:
  - Encryption: `libsodium-wrappers` (WebAssembly)
  - Base64: Browser `atob`/`btoa`
  - Storage: LocalStorage/IndexedDB
  - Camera/QR: WebRTC `getUserMedia`

- **Rust Cross-Compilation:** Tauri's Rust core compiles to ARM64 with standard toolchains

## Distribution

### Linux ARM64

**AppImage** (recommended):
```bash
yarn desktop:build:arm64-linux
# Output: src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/appimage/happy_*.AppImage
```

**Debian Package:**
```bash
yarn desktop:build:arm64-linux
# Output: src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/deb/happy_*.deb
```

### macOS ARM64

**DMG Installer:**
```bash
yarn desktop:build:arm64-mac
# Output: src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Happy_*.dmg
```

**App Bundle:**
```bash
# Output: src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Happy.app
```

### Windows ARM64

**MSI Installer:**
```bash
yarn desktop:build:arm64-windows
# Output: src-tauri/target/aarch64-pc-windows-msvc/release/bundle/msi/Happy_*.msi
```

**Portable EXE:**
```bash
# Output: src-tauri/target/aarch64-pc-windows-msvc/release/happy.exe
```

## Running the Built Application

After building:

**Linux:**
```bash
./src-tauri/target/aarch64-unknown-linux-gnu/release/happy
```

**macOS:**
```bash
open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Happy.app
```

**Windows:**
```bash
.\src-tauri\target\aarch64-pc-windows-msvc\release\happy.exe
```

## CI/CD Integration

For automated ARM64 builds in GitHub Actions, see the example workflow:

```yaml
name: Build ARM64

on:
  push:
    branches: [main]

jobs:
  build-linux-arm64:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-unknown-linux-gnu
      - run: sudo apt-get install -y gcc-aarch64-linux-gnu libwebkit2gtk-4.1-dev
      - run: yarn install
      - run: yarn desktop:build:arm64-linux
      - uses: actions/upload-artifact@v4
        with:
          name: happy-linux-arm64
          path: src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/
```

## Need Help?

- **Tauri Documentation:** https://tauri.app/
- **Expo Web Documentation:** https://docs.expo.dev/workflow/web/
- **Happy Project Issues:** https://github.com/slopus/happy/issues

## Performance Notes

ARM64 builds typically show:
- **Faster startup times** compared to x86_64 (especially on Apple Silicon)
- **Better battery efficiency** on ARM laptops
- **Native performance** without translation layers (like Rosetta 2)
- **Smaller bundle sizes** in some cases due to optimized ARM instruction sets
