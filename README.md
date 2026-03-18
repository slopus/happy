<div align="center"><img src="/.github/logotype-dark.png" width="400" title="Happy Next" alt="Happy Next"/></div>

<h1 align="center">
  Mobile and Web Client for Claude Code, Codex & Gemini
</h1>

<h4 align="center">
Use Claude Code, Codex, or Gemini from anywhere with end-to-end encryption.
</h4>

<div align="center">
  
[🌐 **GitHub**](https://github.com/hitosea/happy-next) • [🖥️ **Web App**](https://happy.hitosea.com/) • [📚 **Documentation**](docs/README.md) • [🇨🇳 **中文**](README.zh-CN.md)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


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

Running `happy` prints a QR code for device pairing.

- Open `https://happy.hitosea.com/` and scan the QR code (or follow the link shown in your terminal).
- Prerequisite: install the vendor CLI(s) you want to control (`claude`, `codex`, and/or `gemini`).

<div align="center"><img src="/.github/mascot.png" width="200" title="Happy Next" alt="Happy Next"/></div>

## Self-host (Docker Compose)

Happy Next works with the hosted server by default (`https://api.happy.hitosea.com`) and the hosted web app at `https://happy.hitosea.com/`.

If you want to self-host:

```bash
cp .env.example .env
# edit .env

docker-compose up -d
```

Note: this default stack also starts `happy-voice`. You must configure LiveKit + provider keys (OpenAI/Cartesia/etc.) in `.env`. See [docs/self-host.md](docs/self-host.md).

First run only (apply DB migrations):

```bash
docker-compose exec happy-server yarn --cwd packages/happy-server prisma migrate deploy
```

Open the web app at `http://localhost:3030`.

Full guide: [docs/self-host.md](docs/self-host.md)

To point the CLI at your self-hosted API:

```bash
HAPPY_SERVER_URL=http://localhost:3031 HAPPY_WEBAPP_URL=http://localhost:3030 happy
```

## Compatibility note

Happy Next intentionally changed client KDF labels as part of the rebrand. Treat this as a **new generation**: do not expect encrypted data created by older clients to be readable by Happy Next (and vice versa).

## What’s new in Happy Next

Happy Next is a major evolution of the original Happy. Here are the highlights:

### Orchestrator
- Define task dependency graphs (DAGs) with per-task model and working directory
- Auto-schedule execution across Claude, Codex, and Gemini agents
- Real-time status badges, activity count, and status-colored progress bars
- Follow up on completed tasks via session resume
- MCP tool integration with auto-filled working directory

### Pending Message Queue
- Messages sent while the CLI is busy are queued server-side and auto-dispatched
- Queue panel UI with image count badges and send-now option
- Reconnect sync and concurrent dispatch safety

### Multi-Agent (Claude Code + Codex + Gemini)
- All three agents are first-class citizens with session resume, duplicate/fork, and history
- Multi-agent history page with per-provider tabs, device and agent filter dropdowns
- Per-agent model selection, cost tracking, and context window display
- ACP and App-Server (JSON-RPC) backends for Codex, Codex v0.115.0 with fast mode
- AI backend profiles with presets for DeepSeek, Z.AI, OpenAI, Azure, and Google AI

### Voice Assistant (Happy Voice)
- LiveKit-based voice gateway with pluggable STT/LLM/TTS providers
- Microphone mute, voice message send confirmation, "thinking" indicator
- Context-aware voice: app state is injected into the voice LLM automatically
- Auto-switch providers by prefix (e.g. `openai/gpt-4.1-mini`, `cartesia/sonic-3`)

### Multi-Repo Worktree Workspaces
- Create, switch, and archive multi-repo workspaces from the app
- Per-repo branch selection, settings, and scripts
- Aggregated git status across repos
- Auto-generate workspace `CLAUDE.md` / `AGENTS.md` with `@import` refs
- Worktree merge and PR creation with target branch selection
- AI-powered PR code review with results posted as GitHub comments

### Code Browser & Git Management
- Full file browser with search, Monaco editor viewing/editing
- Commit history with branch selector (local + remote)
- Git changes page: stage, unstage, commit, discard
- Per-file diff stats (+N/-N) for Claude, Codex, and Gemini
- Image preview with sharing support

### Session Sharing
- Share sessions with friends via direct invite or public link
- End-to-end encrypted: NaCl Box (direct) and token-derived keys (public links)
- Real-time sync of messages, git status, and voice chat across shared users
- Access control with view, edit, and admin permission levels
- "All / Shared with me / Shared by me" filter tabs and share indicator in session list
- Public share web viewer for link-based access

### OpenClaw Gateway
- Connect to external AI machines via relay tunnel or direct WebSocket
- Machine pairing with Ed25519 key exchange
- Chat interface with real-time streaming and session management

### DooTask Integration
- Task list with filters, search, pagination, and status workflows
- Task detail with HTML rendering, assignees, files, sub-tasks
- Real-time WebSocket chat (Slack-style layout, emoji reactions, voice playback, images/video)
- One-click AI session launch from any task (MCP server passthrough)
- Create tasks and projects directly from the app with cross-platform date picker
- Globalized WebSocket connection with real-time task updates and persistent server-side connection

### Self-Hosting
- One-command `docker-compose up` (Web + API + Voice + Postgres + Redis + MinIO)
- Separate origins architecture (no path reverse proxy)
- `.env.example` with full configuration reference
- Runtime env var injection for Docker builds

### Sync & Reliability
- v3 messages API with seq-based sync, batch writes, and cursor pagination
- HTTP outbox for reliable delivery when WebSocket is unavailable
- Server-confirmed message sending with retry and message receipt tracking
- Fixes for cursor skip, outbox race, message duplication/loss

### Chat & Session UX
- Image attachment and clipboard paste (web), image support in drafts
- `/duplicate` command to fork a session from any message
- Message pagination, unread blue dot indicator, compact list view
- Active/Inactive tab filter, session preview expand/collapse, metadata caching
- Session rename with lock (prevent AI auto-update), search in history
- Options click-to-send / long-press-to-fill, scroll-to-bottom button
- Pull-to-refresh, inset dividers, Agent tool display with robot icon
- Tool input/output formatted as key-value pairs instead of raw JSON
- `preview_html` tool for full-page HTML preview, colon-separated MCP tool naming
- CLI hot-upgrade support mid-session

### CLI
- `happy update` self-upgrade, `happy --version` with all agent versions
- Daemon auto-start on boot (`happy daemon enable/disable`), restart command
- Unified system prompt injection for Codex and Gemini
- Message receipt tracking with legacy compatibility

### Bug Fixes & Stability
- 250+ bug fixes: message sending reliability, session lifecycle, Markdown rendering, navigation, voice, DooTask, sharing
- Security: shell command injection fix, plan mode permission handling
- Performance: payload trimming for mobile, lazy-load diffs, rendering optimization

### UI & Polish
- Dark mode fixes throughout the app
- i18n improvements (Chinese Simplified/Traditional, CJK input handling)
- Markdown rendering: tables, inline code, nested fences, clickable file paths
- Keyboard handling, loading states, navigation stability, icon font preloading

Full changelog: [docs/changes-from-happy.md](docs/changes-from-happy.md)

## How does it work?

On your computer, run `happy` instead of `claude`, `happy codex` instead of `codex`, or `happy gemini` instead of `gemini` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Next?

- 🎛️ **Remote control for Claude, Codex & Gemini** - All three agents as first-class citizens
- 🤖 **Orchestrator** - Define multi-agent task DAGs and auto-schedule execution
- ⚡ **Instant device handoff** - Take back control with a single keypress
- 🔔 **Push notifications** - Know when your agent needs attention
- 🔐 **E2EE + self-host option** - Encrypted by default, one-command Docker deployment
- 🎙️ **Voice assistant** - LiveKit-based voice gateway with pluggable STT/LLM/TTS providers
- 🧰 **Multi-repo workspaces** - Worktree-based multi-repo flows with branch selection and PR creation
- 📁 **Code browser & git management** - Browse files, view diffs, stage/commit/discard from your phone
- 📋 **DooTask integration** - Task management with real-time chat and one-click AI sessions
- 📨 **Pending message queue** - Messages queued and auto-dispatched when CLI is ready

## 📦 Project Components

- **[Happy App](packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](packages/happy-cli)** - Command-line interface for Claude Code, Codex, and Gemini
- **[Happy Server](packages/happy-server)** - Backend server for encrypted sync
- **[Happy Voice](packages/happy-voice)** - Voice gateway (LiveKit-based)
- **[Happy Wire](packages/happy-wire)** - Shared wire types and schemas

## 🏠 Who We Are

We build Happy Next because we want to supervise coding agents from anywhere (web/mobile) without giving up control, privacy, or the option to self-host.

## 📚 Documentation & Contributing

- **[Documentation](docs/README.md)** - Learn how Happy Next works (protocol, deployment, self-host, architecture)
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development setup and contributing guidelines
- **[SECURITY.md](SECURITY.md)** - Security vulnerability reporting policy
- **[SUPPORT.md](SUPPORT.md)** - Support and troubleshooting

## License

MIT License - see [LICENSE](LICENSE) for details.
