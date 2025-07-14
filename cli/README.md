# Happy

Start a `claude` code and control it from your mobile device on the go in a native mobile app.

Free. Open source. Code on the go.

## Installation

```bash
npm install -g happy-coder-cli
```

## Usage

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan

## Requirements

- Node.js >= 18.0.0
- Claude CLI installed & logged in (`claude` command available in PATH)

## License

MIT