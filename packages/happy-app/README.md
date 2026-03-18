<div align="center"><img src="/logo.png" width="200" title="Happy Next" alt="Happy Next"/></div>

<h1 align="center">
  Mobile and Web Client for Claude Code, Codex & Gemini
</h1>

<h4 align="center">
Use Claude Code, Codex, or Gemini from anywhere with end-to-end encryption.
</h4>

<div align="center">
  
[🌐 **GitHub**](https://github.com/hitosea/happy-next) • [📚 **Documentation**](https://github.com/hitosea/happy-next)

</div>

<img width="5178" height="2364" alt="github" src="https://github.com/user-attachments/assets/14d517e9-71a8-4fcb-98ae-9ebf9f7c149f" />


<h3 align="center">
Step 1: Install CLI on your computer
</h3>

```bash
npm install -g happy-next-cli
```

<h3 align="center">
Step 2: Start using `happy` instead of `claude`, `codex`, or `gemini`
</h3>

```bash

# Instead of: claude
# Use: happy

happy

# Instead of: codex
# Use: happy codex

happy codex

# Instead of: gemini
# Use: happy gemini

happy gemini

```

## How does it work?

On your computer, run `happy` instead of `claude`, `happy codex` instead of `codex`, or `happy gemini` instead of `gemini` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Next?

- 📱 **Mobile access to Claude Code, Codex & Gemini** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when your agent needs permission or encounters errors
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[happy-cli](../happy-cli)** - Command-line interface for Claude Code, Codex, and Gemini
- **[happy-server](../happy-server)** - Backend server for encrypted sync
- **[happy-voice](../happy-voice)** - Voice gateway (LiveKit-based)
- **[happy-wire](../happy-wire)** - Shared wire types and schemas
- **happy-app** - This mobile and web client (you are here)

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Next was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation](../../docs/README.md)** - Learn how Happy Next works
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development setup including iOS, Android, and macOS desktop variant builds

## License

MIT License - see [LICENSE](LICENSE) for details.
