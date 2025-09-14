<div align="center"><img src="/logo.png" width="200" title="Happy Coder" alt="Happy Coder"/></div>

<h1 align="center">
  Mobile and Web Client for Claude Code
</h1>

<h4 align="center">
Use Claude Code from anywhere with end-to-end encryption.
</h4>

<div align="center">

[![CI/CD](https://github.com/jeffersonwarrior/happy/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/jeffersonwarrior/happy/actions)
[![Security](https://github.com/jeffersonwarrior/happy/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/jeffersonwarrior/happy/security)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform Support](https://img.shields.io/badge/platform-iOS%20%7C%20Android%20%7C%20Web%20%7C%20Desktop-blue)](https://github.com/jeffersonwarrior/happy)

[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🖥️ **Desktop Apps**](https://github.com/jeffersonwarrior/happy/releases) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE)

</div>

<img width="5178" height="2364" alt="github" src="https://github.com/user-attachments/assets/14d517e9-71a8-4fcb-98ae-9ebf9f7c149f" />

## 🚀 Quick Start

<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://github.com/jeffersonwarrior/happy/releases"><img width="135" height="39" alt="desktop" src="https://img.shields.io/badge/Desktop-Download-blue?style=for-the-badge&logo=desktop" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy-coder
```

<h3 align="center">
Step 3: Start using `happy` instead of `claude`
</h3>

```bash
# Instead of claude, just run happy
happy
```

## ✨ Platform Support

| Platform | Status | Download |
|----------|--------|----------|
| 📱 **iOS** | ✅ Live | [App Store](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) |
| 🤖 **Android** | ✅ Live | [Google Play](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) |
| 🌐 **Web** | ✅ Live | [app.happy.engineering](https://app.happy.engineering) |
| 🖥️ **macOS** | ✅ Auto-built | [Releases](https://github.com/jeffersonwarrior/happy/releases) |
| 🪟 **Windows** | ✅ Auto-built | [Releases](https://github.com/jeffersonwarrior/happy/releases) |
| 🐧 **Linux** | ✅ Auto-built | [Releases](https://github.com/jeffersonwarrior/happy/releases) |

*Desktop builds are automatically generated via GitHub Actions for every release.*

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code** - Check what Claude is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude needs permission or encounters errors
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking
- 🖥️ **Desktop apps** - Native desktop applications for all major platforms

## 🛠️ Development

### Prerequisites
- Node.js 22+
- Rust (for desktop builds)
- Expo CLI

### Setup
```bash
# Clone repository
git clone https://github.com/jeffersonwarrior/happy.git
cd happy

# Install dependencies
npm install --legacy-peer-deps

# Start development server
npm run start

# Platform-specific development
npm run ios      # iOS simulator
npm run android  # Android emulator
npm run web      # Web browser
```

### Desktop Development
```bash
# Install Tauri CLI
npm install -g @tauri-apps/cli

# Run desktop app in dev mode
npm run tauri dev

# Build desktop app
npm run tauri build
```

### Contributing
We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📦 Project Components

- **[happy-cli](https://github.com/slopus/happy-cli)** - Command-line interface for Claude Code
- **[happy-server](https://github.com/slopus/happy-server)** - Backend server for encrypted sync
- **happy-coder** - This mobile/desktop client (you are here)

## 🔐 Security

- **End-to-end encryption** using tweetnacl
- **Automated security scanning** with CodeQL
- **Dependency monitoring** with Dependabot
- **Vulnerability alerts** for all dependencies

## 🌍 Internationalization

Happy supports multiple languages:
- 🇺🇸 **English** (en)
- 🇷🇺 **Russian** (ru)
- 🇵🇱 **Polish** (pl)
- 🇪🇸 **Spanish** (es)

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how Claude is progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at Claude building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ by developers, for developers</sub>
</div>