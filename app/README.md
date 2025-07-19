<img width="6828" height="3525" alt="wordart (1)" src="https://github.com/user-attachments/assets/343fa4c1-08e8-4342-bb33-6c332357e06c" />

# Happy Coder - Mobile Client for Claude Code

Happy Coder is a mobile client that connects to Claude Code with full end-to-end encryption without replacing original experience of Claude Code.

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

## 🔐 Why Happy Coder?

🛡️ **Your Code Stays Private** - End-to-end encryption ensures only you can read your conversations. Perfect for proprietary codebases and sensitive projects.

☁️ **Encrypted Cloud Sync** - Your sessions are stored in the cloud but fully encrypted. The server sees only encrypted data, never your actual code.

📱 **Real-Time Mobile Access** - Continue Claude Code sessions seamlessly between desktop and mobile. Watch Claude think and respond in real-time.

🔑 **Zero-Knowledge Architecture** - We use TweetNaCl (same as Signal) for military-grade encryption. Your keys never leave your device.

📡 **Works Offline** - Encrypted sessions cached locally. Access your conversation history even without internet.

## How It Works

1. **Pair with QR Code**: Scan a QR code from your Claude Code terminal to establish a secure connection
2. **Automatic Encryption**: Every message is encrypted with a unique key before transmission
3. **Secure Sync**: Your encrypted messages sync in real-time across all paired devices
4. **Local Storage**: Encrypted sessions are stored on-device for offline access

## Open Source Transparency

Happy Coder is completely open source. You can:
- Audit the encryption implementation
- Verify no data collection
- Contribute improvements
- Self-host your own server

## Technical Stack

- React Native with Expo for cross-platform mobile
- TypeScript with strict mode
- TweetNaCl for cryptography
- WebSocket for real-time sync
- NativeWind for styling

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Your code. Your privacy. Your Claude Code companion.**
