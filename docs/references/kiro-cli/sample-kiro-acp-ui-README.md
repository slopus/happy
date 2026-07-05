# Kiro ACP Chat Client

An example desktop chat application built on the [Agent Client Protocol (ACP)](https://kiro.dev). Use it as a starting point for building your own ACP client — fork it, swap the UI, or integrate ACP into your own tooling.

## Why This Exists

The ACP protocol lets any application communicate with [Kiro CLI](https://kiro.dev) as an AI backend. This project demonstrates a complete, working implementation with zero external dependencies (stdlib only), making it easy to read, understand, and adapt.

## How It Works

The application spawns `kiro-cli acp` as a subprocess and communicates over stdin/stdout using JSON-RPC 2.0 messages. It handles the full ACP lifecycle: initialization handshake, session creation, prompt sending, and streaming response display.

```
┌─────────────────┐       stdin/stdout        ┌──────────────┐
│  Chat UI        │ ◄──── JSON-RPC 2.0 ─────► │ kiro-cli acp │
│  (tkinter)      │                           │              │
└─────────────────┘                           └──────────────┘
```

## Use as a Starting Point

This project is designed to be forked and modified. The architecture separates concerns cleanly so you can replace any layer independently:

| Want to... | Modify |
|------------|--------|
| Build a different UI (web, CLI, Electron) | Replace `ui.py` |
| Change how messages are sent/received | Modify `process_manager.py` |
| Add custom ACP features or session handling | Extend `acp_client.py` |
| Change conversation logic or add middleware | Edit `controller.py` |

The protocol layer (`acp_client.py` + `process_manager.py`) works independently of the UI — you can reuse it as-is in any Python application.

## Example Experiences

ACP lets you build Kiro-powered experiences for non-technical users who may never touch a terminal. Here are some ideas:

| Experience | Description |
|------------|-------------|
| **IT Help Desk** | A desktop app where employees describe tech issues in plain language and get guided troubleshooting — no tickets, no jargon |
| **Report Generator** | A simple form where a manager types "Q2 sales summary" and gets a formatted report pulled from connected data sources |
| **Onboarding Assistant** | A friendly chat window that walks new hires through setup steps, answers policy questions, and files requests on their behalf |
| **Meeting Prep Tool** | Paste a meeting invite and get a briefing doc with attendee context, relevant docs, and suggested talking points |
| **Customer Email Drafter** | Sales reps describe the situation, get a polished email draft they can review and send with one click |
| **Company Knowledge Search** | A search bar that answers questions about company processes by reasoning over internal docs — no keyword guessing |
| **Expense Approver** | Finance team reviews expense reports with AI-generated summaries and policy compliance checks inline |
| **Content Reviewer** | Marketing uploads a blog draft and gets tone, grammar, and brand-guideline feedback in a clean sidebar |

The key insight: **the CLI disappears entirely**. End users interact with a polished UI tailored to their workflow while Kiro handles the reasoning behind the scenes. You control the experience — what tools are available, what context is provided, and how results are presented.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (dependency manager)
- [Kiro CLI](https://kiro.dev) installed and on your PATH

### Installing Kiro CLI

```bash
# macOS / Linux
curl -fsSL https://kiro.dev/install.sh | sh

# Windows
powershell -c "irm https://kiro.dev/install.ps1 | iex"
```

After installation, verify it's working:

```bash
kiro --version
```

## Getting Started

```bash
# Clone the repository
git clone https://github.com/aws-samples/sample-kiro-acp-ui.git
cd sample-kiro-acp-ui

# Install dependencies and run
uv run kiro-acp-chat
```

That's it. The application will spawn `kiro-cli acp`, establish a session, and present the chat window.

## Usage

Once the app launches, it connects to Kiro CLI and presents a chat window:

1. Wait for the "Ready!" message indicating the session is established
2. Type your message in the input field at the bottom
3. Press **Enter** or click **Send** to submit
4. Kiro's responses appear in the chat area with a typing indicator while processing
5. Tool permission requests appear as dialog prompts — approve or reject as needed

The chat window auto-scrolls to show new messages and resizes responsively.

## Development

```bash
# Set up the dev environment
uv sync --group dev

# Run tests
uv run pytest

# Run the app directly
uv run kiro-acp-chat
```

## Architecture

| Module | Responsibility |
|--------|---------------|
| `process_manager.py` | Subprocess lifecycle — spawn, read/write JSON messages, graceful shutdown |
| `acp_client.py` | ACP protocol — initialize, session management, prompt/response handling |
| `controller.py` | Coordination — validates input, orchestrates send/receive, manages conversation state |
| `ui.py` | Tkinter chat interface — message display, input field, typing indicators, auto-scroll |
| `models.py` | Data models — JSON-RPC message types, conversation and message dataclasses |

## Logs

Logs are written to `~/.kiro-acp-chat/logs/` on each startup. Check there for debugging ACP communication issues.

By default, message content (user prompts and assistant responses) is **not** logged to protect sensitive information. If you need to debug message-level issues, enable content logging in `~/.kiro-acp-chat/preferences.json`:

```json
{
  "log_message_content": true
}
```

When enabled, the first 50 characters of each outgoing message are written to the log file at INFO level. **Disable this after debugging** — log files may persist on disk and could contain sensitive information.

## Configuration

User preferences are stored in `~/.kiro-acp-chat/preferences.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model_id` | string | `"auto"` | Selected model ID (persisted across sessions) |
| `mode_id` | string | `""` | Selected agent mode ID (persisted across sessions) |
| `log_message_content` | boolean | `false` | Log message content to file for debugging (see Logs section) |

The `~/.kiro-acp-chat/` directory is created automatically on first run. This location is used regardless of install method (`uv tool install`, `pipx`, `pip install`, or running from source).

## Author

Bastian Töpfer ([@bttopfer](https://github.com/bttopfer))

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for more information.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
