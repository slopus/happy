# Happy Next Server

Minimal backend for open-source end-to-end encrypted AI coding agent clients (Claude Code, Codex, and Gemini).

## What is Happy Next?

Happy Next Server is the synchronization backbone for secure AI coding agent clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when your AI agent finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your AI coding clients generate encryption keys locally and use Happy Next Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Hosting

**You don't need to self-host!** Our free cloud Happy Next Server at `api.happy.hitosea.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Happy Next Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own. See [docs/self-host.md](../../docs/self-host.md) for setup instructions.

## License

MIT - Use it, modify it, deploy it anywhere.
