<img width="6828" height="3525" alt="wordart (1)" src="https://github.com/user-attachments/assets/343fa4c1-08e8-4342-bb33-6c332357e06c" />

<h1 align="center">
  Mobile Client for Claude Code
</h1>

<h4 align="center">
Your code. Your privacy. Your Claude Code companion.
</h4>

Happy Coder is a native mobile client that connects to Claude Code with full end-to-end encryption without replacing original experience of Claude Code.

<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<img width="180" height="52" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" />
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
<img width="180" height="52" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" />
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy-coder
```

<h3 align="center">
Step 3: Start using `happy` isntead of `claude`
</h3>

```bash

# Instead of claude, just run happy

happy

```

## How does it work?

This when you are on your computer, you are using the normal Claude Code UI, that is started by our wrapper `happy`, when you want to move control to the mobile app, it will restart the session in remote mode, when you want to get back to your computer you switch back by pressing any button on your physical keyboard.

## 📦 Project Components

- **[happy-cli](https://github.com/slopus/happy-cli)** - Command-line interface for Claude Code
- **[happy-server](https://github.com/slopus/happy-server)** - Backend server for encrypted sync
- **happy-coder** - This mobile client (you are here)

## 🔥 Why Happy Coder?

- 📱 **Seamless Mobile Experience** - Continue Claude Code sessions from anywhere with real-time streaming and instant desktop/mobile switching
- 🔔 **Push Notifications** - Get notified for permission requests, completed tasks, and errors - never miss important updates
- ☁️ **Cloud Sync & Offline Access** - Access your full conversation history even when terminals are offline, with automatic sync when reconnected
- 🛡️ **End-to-End Encryption** - Military-grade encryption using TweetNaCl ensures only you can read your code - perfect for proprietary projects
- 🔑 **Zero-Knowledge Architecture** - Your encryption keys never leave your device, server cannot decrypt messages even if compromised
- 📖 **Open Source** - Fully auditable codebase for complete transparency and trust

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how Claude is progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at Claude building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## License

MIT License - see [LICENSE](LICENSE) for details.
