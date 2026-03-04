# Changes from Happy (main) → Happy Next (next)

[🇨🇳 中文](changes-from-happy.zh-CN.md)

This document summarizes what changed in the `next` branch compared to the original Happy on `main`.

## TL;DR

| Area | What changed |
|---|---|
| Multi-agent | Claude Code, Codex, and Gemini are all first-class agents |
| Voice | LiveKit-based voice gateway with pluggable STT/LLM/TTS providers |
| Workspaces | Multi-repo worktree creation, switching, archiving, and PR flows |
| Code browser | File browser, Monaco editor, commit history, git stage/commit/discard |
| Session sharing | Direct invite and public link sharing with E2E encryption and access control |
| DooTask | Task list, detail, real-time chat, one-click AI session launch, in-app task/project creation |
| Self-hosting | One-command `docker-compose` stack with separate origins |
| Sync | v3 messages API, HTTP outbox, server-confirmed sends, race condition fixes |
| Chat UX | Image attachment, pagination, blue dot, compact view, session search, pull-to-refresh |
| Bug fixes | 200+ fixes across message sending, sessions, rendering, navigation, security |
| Performance | Payload trimming, lazy-load diffs, rendering optimization |
| CLI | `happy-next-cli` with multi-agent support, worktree RPC, diff processing, self-upgrade |
| OpenClaw | External AI machine gateway with tunnel/direct connections and chat UI |
| Profiles | AI backend profiles with presets for DeepSeek, Z.AI, OpenAI, Azure, Google AI |
| Rebrand | CLI published as `happy-next-cli`, binary remains `happy` |

---

## Multi-Agent Support

The original Happy only supported Claude Code. Happy Next treats Claude Code, Codex, and Gemini as equal first-class agents.

- **Multi-agent history page** with per-provider tabs (Claude / Codex / Gemini)
- **Session resume and duplicate/fork** for all three agents
- **`/duplicate` slash command**: opens a message picker to fork a session from any point in the conversation, creating a new session with history up to the selected message
- **Per-agent model selection** cached independently, with context window display
- **Cost tracking** with accurate token usage for Claude models (cache tokens, reasoning tokens)
- **Codex reasoning effort** configuration (low / medium / high / xhigh)
- **ACP (Agent Client Protocol) backend** for Codex, replacing the MCP client approach
- **Codex App-Server backend**: alternative `codex app-server` JSON-RPC protocol over stdin/stdout for improved session management and reliability
- **Gemini session persistence** with JSONL storage
- **Per-provider slash commands**: `/clear` for all agents, `/compact` Claude-only
- **Model/mode switching** per session with live metadata sync
- **Codex/Gemini diff processing**: per-file +N/-N statistics displayed in app
- **Message backfill** for Codex and Gemini when resuming/duplicating sessions

## Voice Assistant (Happy Voice)

Happy Next includes a complete voice gateway stack, from a simple ElevenLabs-only setup to a full LiveKit pipeline.

- **LiveKit-based voice gateway** (`happy-voice`) with pluggable providers
- **Provider auto-switching by prefix**: `openai/gpt-4.1-mini` for LLM, `cartesia/sonic-3:voiceId` for TTS, `assemblyai/universal-streaming:en` for STT
- **Microphone mute** across all voice providers (ElevenLabs, LiveKit/Happy Voice)
- **Voice tools**: session management (navigate, end conversation), message sending
- **Voice message send confirmation** with configurable countdown
- **"Thinking" indicator** in voice status bar
- **Context-aware voice**: full app state (sessions, git status, etc.) injected as structured context
- **Silero VAD sensitivity** tuning via environment variables
- **Speech fragment merging** for interrupted user turns
- **Configurable welcome message** from app settings
- **System prompt engineering**: English prompts, semantic XML separation, inline LLM hints

## Multi-Repo Worktree Workspaces

A major new capability: manage multiple repositories as a unified workspace.

- **Create workspaces** with multiple repos from the new session wizard
- **RepoPickerBar** and **RepoSelector** components for workspace creation and switching
- **Per-repo settings**: branch selection (local + remote), scripts, configuration
- **Git status aggregation** across all workspace repos
- **Auto-generate workspace `CLAUDE.md` and `AGENTS.md`** with `@import` references
- **Workspace lifecycle management**: metadata tracking, git operations, archive/cleanup via daemon RPC
- **Worktree merge and PR creation** with target branch selection
- **AI-powered PR code review**: one-click launch of an AI session to review a PR, results posted as a GitHub PR comment
- **Path display** with `~/` notation instead of absolute paths

## Code Browser & Git Management

The app now includes a full code browsing and git management experience.

- **File browser** with directory navigation and search (current directory filter + project-wide)
- **File viewer** with Monaco editor (readonly mode for viewing, edit mode for changes)
- **Commit history** with branch selector (local and remote branches)
- **Commit detail page** with diff viewing and action buttons (copy hash, copy message)
- **Git changes page**: stage, unstage, commit, and discard changes
- **Per-file diff statistics** (+N/-N lines) for Claude Code, Codex, and Gemini sessions
- **Clickable file path links** in markdown with editor reveal position
- **Staged file diff display** with accurate line count
- **Base64 decoding** fixed for UTF-8 (CJK characters)

## Session Sharing

Share AI coding sessions with others through direct invites or public links, with full end-to-end encryption.

- **Direct sharing** with NaCl Box end-to-end encryption via uploaded content public keys
- **Public link sharing** with token-derived key encryption
- **Access levels**: view-only, edit, and admin permissions with server-side enforcement
- **Real-time sync**: messages, git status, and voice chat broadcast to all shared users via socket events
- **"All / Shared with me" filter tabs** in session list
- **Share indicator** on sessions shared with others
- **Sharer avatar** and **sender name** display in shared sessions
- **Public share web viewer** for link-based access without the app
- **Shared sessions on user profile** page
- **Permission-aware UI**: input bar, voice button, and session actions adapt to access level
- **Server-side access control** module with permission validation for messages, RPC calls, and voice
- **Access logging** for public share views

## OpenClaw Integration

Connect to external AI machines through a gateway system with its own chat interface.

- **Machine management**: add, edit, and remove OpenClaw machines from the app
- **Two connection modes**: Happy relay (tunnel through the Happy server) or direct WebSocket gateway
- **Ed25519 key exchange** for secure machine pairing
- **Chat interface** with real-time streaming AI responses, message retry, and typing indicators
- **Session management**: create, browse, and resume OpenClaw sessions
- **Server-side CRUD API** with encrypted metadata and optimistic concurrency
- **CLI tunnel manager** for relay connections

## AI Backend Profiles

Configure alternative LLM backends for Claude Code through environment variable profiles.

- **Built-in provider presets**: Anthropic (default), DeepSeek, Z.AI, OpenAI, Azure OpenAI, Google AI
- **Environment variable mapping**: automatically maps provider-specific env vars (e.g. `DEEPSEEK_*` → `ANTHROPIC_*`)
- **Custom profiles**: create profiles with arbitrary environment variables and `${VAR:-default}` expansion
- **Per-profile settings**: tmux session name, startup scripts, default permission mode, agent type compatibility
- **Profile editor**: full-page settings UI for creating and editing profiles

## DooTask Integration

Deep integration with DooTask project management, from browsing tasks to launching AI sessions.

- **Task list page** with filters (project, status, priority), search, and pagination
- **Task detail page** with HTML content rendering, status workflows, assignees, files, sub-tasks, tags
- **Real-time WebSocket chat** with Slack-style layout and avatars
- **Chat features**: emoji reactions, voice message playback, image/video messages, file cards
- **Optimistic UI** for message sending with HTTP/WebSocket race
- **One-click AI session launch** from task detail (with MCP server passthrough)
- **External context linking**: sessions launched from DooTask show a context banner and are linked back
- **DooTask connection page** with login, captcha support, and field caching
- **Task status management**: clickable status badges with workflow transitions
- **DooTask tab** in main navigation with connected account management
- **Create tasks and projects** directly from the app with dedicated form pages
- **Cross-platform date picker** (`react-native-ui-datepicker`) with bottom sheet confirm
- **Form caching** for task/project creation across navigation

## Self-Hosting

Happy Next adds a first-class self-hosting path.

- **Root `docker-compose.yml`** with all services: Web app (Nginx), API server, Voice gateway, Postgres, Redis, MinIO
- **Separate origins architecture**: Web, API, and Voice each use different ports/domains (no path reverse proxy)
- **`.env.example`** as the single source of truth for all configuration
- **Runtime env var injection** in Dockerfile/entrypoint for Docker builds
- **`APP_URL`** configuration for connect flows
- **`VOICE_TOOL_BRIDGE_BASE_URL`** for voice-to-server communication in Docker networks
- **Self-host documentation**: `docs/self-host.md`

## Sync & Messaging Reliability

Major reliability improvements to the real-time sync layer.

- **v3 messages API** with seq-based sync, batch writes, and cursor pagination
- **HTTP outbox** for reliable message delivery when WebSocket is unavailable
- **Server-confirmed message sending** with retry on failure
- **Fixes**: cursor skip on first push, outbox concurrent flush race, message duplication, seq gap message loss, syncing cursor reset, outbox drain on close
- **Message loss prevention** when CLI is offline
- **happy-wire** shared protocol types package to deduplicate schemas across CLI/app/server

## Chat & Session UX

Extensive improvements to the chat and session management experience.

- **Image attachment** in new session wizard and during chat
- **Image paste from clipboard** on web
- **Message pagination** for loading older messages
- **Unread blue dot indicator** when tasks complete (synced across devices via metadata)
- **Compact session list view**
- **Session search** in history page
- **Session rename** with lock to prevent AI auto-update
- **Session preview** on history page
- **`/duplicate` command** in chat input to fork a session from any message (with DuplicateSheet picker)
- **Options**: click-to-send and long-press-to-fill
- **Context menu** improvements (web backdrop blur, mobile action sheets)
- **Scroll-to-bottom button**
- **Markdown rendering**: tables with horizontal scroll, inline code in headers, nested code fences, inline markdown in table cells
- **Permission mode**: live updates, privileged/YOLO mode distinction, per-agent caching
- **QR scanner** migrated from expo-camera to vision-camera
- **Toast notifications** replacing modal alerts for lightweight feedback
- **Pull-to-refresh** for session list and inbox
- **Inset dividers** for cleaner list layouts
- **Agent tool display** with robot icon in known tools list
- **Tool input/output** formatted as key-value pairs instead of raw JSON
- **AskUserQuestion** "Other" custom input option with markdown preview
- **In-memory SWR cache** and search for agent session history
- **Real-time friend request updates** via socket events
- **Swipe-to-delete** for feed notifications
- **Friend search** with flat layout, GitHub connect prompt for users without username

## CLI Improvements

The CLI (`happy-next-cli`) received substantial upgrades.

- **Multi-agent support**: Claude Code, Codex (via ACP backend), and Gemini as first-class agents
- **Session resume/duplicate** for all agents with proper message backfill
- **Multi-repo worktree** workspace creation/cleanup via daemon RPC
- **Diff processing**: per-file +N/-N statistics for all agents
- **Payload optimization**: trim redundant fields, lazy-load diffs on demand
- **MCP config centralization** with per-agent adapter pattern (Claude HTTP, Codex stdio, Gemini HTTP)
- **Worktree detection** using native git instead of hardcoded path matching
- **Accurate cost calculation** for Claude models
- **Shell command injection fix** with unified escaping
- **Settings persistence**: "don't ask again" for tool approvals saved to `settings.local.json`
- **Session title management**: `change_title` tool with lock support
- **CI**: smoke tests on `next` branch, happy-wire build dependency
- **`happy update`** self-upgrade command
- **`happy --version`** displays Claude, Codex, and Gemini CLI versions
- **Worktree subdirectory detection** in workspace root
- **Latest CLI version** fetched from npm instead of hardcoded minimum

## Server

- **v3 messages API** with batch seq allocation and cursor pagination
- **GitHub OAuth** backward-compatible alias (`GITHUB_REDIRECT_URL` / `GITHUB_REDIRECT_URI`)
- **Usage metrics** merged incrementally instead of overwriting
- **S3 region/path normalization** for broader compatibility
- **Message loss prevention** when CLI is offline
- **Session sharing API**: direct sharing routes, public share routes, content key upload, access control
- **Socket events** for session sharing (real-time broadcast to shared users)
- **Public share access logging**

## UI & Polish

- **Dark mode** fixes throughout (text contrast, chips, status badges, input fields)
- **i18n**: Chinese Simplified/Traditional system locale declaration, CJK input height handling, internationalized pickers
- **Keyboard handling**: content follows keyboard smoothly, no jitter
- **Loading states**: skeleton screens, inline indicators, timeout feedback
- **Navigation**: static route fix for dynamic `[id]` matching, reset on login/logout
- **Image handling**: compression, MIME preservation, gallery viewer with zoom/gestures
- **Status bar**: expanded model/permission display, auto-collapse timeout, mobile mic button

## Bug Fixes & Stability

Over 200 bug fixes landed on `next`. The following are grouped by area.

### Message Sending
- Fix stale text state causing double-tap send and ghost resend (use ref-based text snapshot)
- Preserve `localId` on retry to prevent duplicate sends
- Enforce 800ms minimum interval between sends
- Fix input not clearing when WebSocket push beats send-ack
- Return failure on send timeout instead of assuming success
- Fix AskUserQuestion options submitting duplicate messages

### Unread Blue Dot Indicator
- Fix blue dot not showing for offline sessions
- Fix flickering when task completes while user is viewing the session
- Persist `lastViewedAt` to survive process kill
- Refresh on app resume from background
- Use timestamp comparison instead of complex clearing logic
- Sync dismissal across devices via metadata
- Fix tablet sidebar dot not updating (Zustand re-render trigger)

### Session Lifecycle
- Fix session flicker race condition during archive (optimistic update)
- Fix duplicate session numbering (use incremental counters)
- Fix Claude session resume path inconsistency
- Prevent session title overwrite by directory name on resume
- Fix Codex session ID collision after fork/restart (extract from filename)
- Fix newly created session briefly showing "deleted" status
- Fix copy/resume navigation causing detail page to freeze

### Codex & Gemini Agents
- Correct Codex token usage field mapping for accurate statistics
- Preserve reasoning effort when not explicitly changed
- Prevent keepalive race during Codex session archive
- Fix Gemini MCP tool registration failure
- Fix Codex icon invisible in dark mode
- Fix sub-agent messages overwriting session model metadata

### Markdown Rendering
- Fix table horizontal scroll and row height measurement
- Fix empty table cells causing column loss
- Fix nested code fences being truncated early
- Fix inline code in headers rendering too small
- Support inline markdown in table cells
- Fix table inline code line height stretching cells
- Lock row height after all columns are measured to eliminate jitter

### Voice
- Fix provider switching causing navigation stack reset
- Fix `getLatestAssistantReply` tool schema causing OpenAI 400 errors
- Unify voice language setting across providers
- Report "cancelled" instead of "sent" when user cancels message
- Allow closing voice session from error state
- Escape double quotes in tool name XML attributes

### DooTask
- Fix WebSocket pending message cleanup (FIFO order, error-state cleanup)
- Fix optimistic UI edge cases (HTTP/WS race)
- Fix invisible self-sent markdown messages
- Fix status badge layout shift during loading
- Fix due date highlighting for completed tasks
- Fix infinite re-render and web input polish
- Fix image extraction (DOM-based instead of regex)
- Fix member avatars and layout in create task form
- Fix date validation, clearDootaskData reset in create sheets
- Fix paginated column response in create task sheet

### Worktree
- Fix metadata race condition (pass via spawn params instead of async write)
- Add path-pattern fallback for worktree detection (not just metadata flag)
- Fix archive flow and align swipe options
- Fix branch selector disappearing on repo re-click

### Navigation & Routing
- Fix static routes matched by dynamic `[id]` on native
- Fix double title bar after session resume
- Reset navigation stack on login/logout
- Fix keyboard content jitter on new session page

### Security
- Fix shell command injection in CLI command assembly (unified escaping)
- Require user approval for ExitPlanMode in bypass-permissions mode
- Preserve privileged mode after plan approval (prevent regression to default)

### Sharing
- Fix shared session unable to display git status data
- Fix shared session unable to save drafts, switch model and permission mode
- Fix 10s delay when sending messages in shared sessions
- Fix shared session name display and online status sync
- Fix public share page owner display and message ordering
- Fix divider display in sharing dialogs
- Remove backoff retry from sharing API, fix 403 log spam
- Allow shared users to make RPC calls to session CLI
- Restrict session info actions by access level
- Hide input and voice button for view-only shared users

### Performance
- Optimize `applySessions` to avoid redundant re-renders when state unchanged
- Trim Codex/Gemini payloads before sending to mobile (remove large tool results)
- Lazy-load diffs: CLI persists to storage, app fetches on file-name click
- Pace per-session WebSocket updates to avoid autoscroll race
- Lock table row height measurement to eliminate measuring jitter
- Enable `removeClippedSubviews` for session list FlatList
- Git status retry no longer infinite; resets on session focus

## Repo Hygiene

- `LICENSE` (MIT), `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md` added
- GitHub Issue and PR templates
- Documentation refreshed; links updated to `next` branch
- `happy-wire` shared types package
- TypeScript upgraded across the monorepo
- Subscription/RevenueCat system removed
