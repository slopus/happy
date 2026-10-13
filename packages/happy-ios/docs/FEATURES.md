# Feature inventory

Everything happy-app does on an iPhone, as a checklist for this port. Built
from `packages/happy-app/sources/app/(app)` (routes) and
`sources/components`. Tick an item only when it is merged on the
integration branch with its layout tests.

Owners are workstreams (see AGENTS.md, "Workstreams"). `[x]` done, `[~]`
partly done, `[ ]` not started.

## Exclusions

Not ported, on purpose. Each is still listed below so nothing is missed by
accident.

| What | Why | Where in happy-app |
| --- | --- | --- |
| Voice mode: the voice assistant, its settings and language picker, voice bars and status bar, the voice upsell | Out of scope for this app | `settings/voice.tsx`, `settings/voice/language.tsx`, `VoiceAssistantStatusBar`, `VoiceBars`, `apiVoice.ts`, `realtime/` |
| Usage page | Gated by `experiments` | `settings/usage.tsx`, `components/usage/` |
| Rig file browser in the chat | Gated by `experiments` (`SessionView.tsx` `onFileViewerPress`) | `FilesSidebar`, `FileViewPanel` |
| Session files browser (`/session/[id]/files`) | Gated by `experiments` | `session/[id]/files.tsx` |
| The `experiments` toggle's other effects | Anything gated by `experiments` | `SettingsView.tsx` |
| Developer tools and every `dev/*` screen | Dev-only | `app/(app)/dev/*` |
| Friends, user profiles, the inbox and the activity feed | Not reachable on an iPhone in happy-app: the Friends row is commented out in `SettingsView.tsx`, and the inbox tab exists only in the web `TabBar` | `friends/*`, `user/[id].tsx`, `inbox/index.tsx`, `InboxView`, `FeedItemCard`, `apiFriends.ts`, `apiFeed.ts` |
| Artifacts | No entry point in happy-app's UI (only the artifact screens link to each other) | `artifacts/*`, `apiArtifacts.ts` |
| Recent sessions screen | No entry point on a phone | `session/recent.tsx` |
| Web/desktop-only UI: command palette, keyboard shortcut hints, sidebar navigator, web tab bar | Not on iPhone | `CommandPalette/`, `ShortcutHints`, `SidebarNavigator`, `TabBar` |
| RevenueCat purchases and the paywall | Not shown in the iPhone UI | `purchases.ts`, `dev/purchases.tsx` |
| Over-the-air update banner | A native build has no over-the-air JavaScript bundle to update; the store-version check stays in scope | `UpdateBanner.tsx` (`useUpdates`) |
| Analytics (PostHog) | Not ported yet; the `analyticsOptOut` setting is kept and synced | `track/` |

## Onboarding and sign-in

- [x] Welcome, create account, restore with QR, restore with the secret key (`restore/*`)
- [x] Custom server (`server.tsx`), onboarding settings (`onboarding/settings.tsx`)
- [x] Link Your Computer, offline checklist, troubleshoot (`troubleshoot.tsx`)
- [x] Connect a terminal by QR or URL; `happy://terminal` deep links (`terminal/*`)
- [ ] The machine screen that troubleshoot rows open — Secondary
- [x] Copy terminal commands by selecting them (`TerminalBlock.tsx`): every line in the offline checklist and on troubleshoot is selectable, and a selection never takes in the `$ ` prompt — Home

## Home

- [x] Home states: loading, link, offline, no sessions, list
- [x] Flat session list in a `UITableView`: live rows, archive toggle, archived by day
- [x] Archive by swipe and long press
- [x] Home header as the iPhone renders it (`MainView.tsx` phone header): logo, "Sessions" with the socket status, the filter menu and the settings gear. `HomeHeader.tsx` is not mounted on iPhone, so there is no new-session button or server entry; a signed-in iPhone reaches Server from the onboarding settings, and a new account picks its server at sign-in — Home
- [~] Home dock: the prompt that starts a session from home (`HomeDock`, `homeDock*.ts`) — Home
  - Done: the resting capsule and its scrim, the composer it opens (backdrop, machine/project/worktree/harness menus, "Enter custom path", git worktrees, Composer's card with the permission, model and effort chips), the opening and closing motion, the start through `SessionStarter` with its status line and Stop, refusals while starting, and the project card's `+` opening it on a new workspace.
  - Not yet: bots (the Session | Bot switch, faces, avatar), picture attachments (the add button is hidden until there is an image picker), and three card options Composer is adding: the dock's filled send/stop button, Stop's refusal flash, and the text and action row rising in their own beats.
- [x] Project grouping and expanded projects (`ProjectHomeList`, `ProjectGroup`, `projectGroups.ts`, `sessionListGrouping` setting) — Home
- [x] Session row actions as the iPhone shows them: the "Session" alert from `useSessionQuickActions.ts` (details, resume, fork, duplicate, archive). `SessionActionsPopover` is web-only — Home + Ops
  - Rename is absent from current happy-app and is not ported.
- [ ] Pending chats placeholder (`PendingChatPlaceholder`, `pendingChats.ts`) — Home
- [~] Update banner (`UpdateBanner`) and offline machines banner (`OfflineMachinesBanner`) — Home
  - Done: the offline machines banner and the changelog's "What's new". Not yet: the store-version check (`POST /v1/version`).
  - The OTA update banner is excluded: a native build has no over-the-air JavaScript updates.
- [ ] New session screen: machine, path, agent, model, permission mode, worktree (`new/index.tsx`, `newSessionProgress.ts`, `machineChoices.ts`) — Home + Ops
  - Current happy-app does not use recent paths; `recentMachinePaths` remains an untouched synced settings key for compatibility.
- [ ] Machine screen: status, sessions, resume, stop daemon, rename (`machine/[id].tsx`) — Secondary + Ops

## Chat

- [ ] Session screen shell: header (title, avatar, status, git status), back, info (`session/[id].tsx`, `SessionView.tsx`, `ChatHeaderView`) — Chat
- [ ] Inverted list engine with precomputed, off-main text layout, manual frames, bubble resize animations, scroll position keeping (`ChatList`) — Chat
- [ ] Keyboard: input bar tracks the keyboard, interactive dismiss, list insets — Chat
- [ ] Messages: user bubbles, agent text, thinking, events, unsupported placeholder (`MessageView`) — Chat
- [~] Markdown: blocks, spans, links, lists, tables, code blocks with syntax highlighting, copy (`markdown/*`, `SyntaxText`, `SimpleSyntaxHighlighter`) — Chat
- [ ] Text selection screen (`text-selection.tsx`) — Chat
- [ ] Tool calls, hidden by default; tool headers, sections, errors, full view (`tools/*`, `knownTools.tsx`) — Chat
  - Deviation from happy-app, on purpose: tool output is collapsed by default (header only, compact row or card as `compactToolCalls` picks); tap the header to expand, in memory for the screen's lifetime; a pending permission, question or plan keeps its input open, never its output.
  - Partial: on iPad, permission buttons stretch instead of right-aligning, and a long permission list doesn't scroll at min(260, 35% of the window).
- [ ] Tool views: Bash, Edit, MultiEdit, Write, Todo, Task, MCP, Codex patch/diff/bash, Gemini edit/execute, file, exit plan, ask user question, request user input (`tools/views/*`) — Chat
- [ ] Permission prompts: allow, allow for session, deny, mode switch (`PermissionFooter`) — Chat
- [ ] Agent questions: banner, modal, inline form (`AgentQuestionBanner`, `AgentQuestionModal`, `InlineQuestionForm`, `agentCommunications.ts`) — Chat
- [ ] Image and file messages, decrypted on demand (`FileView`) — Chat + Sending
- [ ] Message detail screen (`session/[id]/message/[messageId].tsx`) — Chat
- [ ] Agent goal bar, work group headers, rig activity bar (`AgentGoalBar`, `AgentWorkGroupHeader`, `RigActivityBar`) — Chat
- [ ] Empty and pending states (`EmptyMessages`, `ChatFooter`) — Chat
- [ ] Composer: growing text input, send/stop button, drafts (`AgentInput`, `MultiTextInput`, `agentInputLayout.ts`, `agentInputPrimaryAction.ts`) — Composer
- [ ] Autocomplete: slash commands and file mentions (`autocomplete/*`, `AgentInputAutocomplete`) — Composer
- [ ] Attachments: picker (photos, camera, files), strip, upload progress (`AgentInputAttachmentStrip`, `attachmentSupport.ts`) — Composer + Sending
- [ ] Permission mode, model and effort pickers (`PermissionModeSelector`, `modelModeOptions.ts`, `NativeOptionsPicker`) — Composer
- [ ] Session info: metadata, machine, path, archive, delete, duplicate, fork (`session/[id]/info.tsx`) — Secondary + Ops
  - The duplicate sheet is `Screens/SessionInfoDuplicateSheet.swift`, entered through `UIViewController.presentDuplicateSheet(sessionId:context:)`, which works like `push(_:context:)`. Home's row alert and the chat call that entry point instead of building their own.
- [ ] File viewer and changes with diffs (`file.tsx`, `changes.tsx`, `diff/*`, `CodeView`) — Secondary
  - The `/files` browser is gated behind `experiments` and excluded (see Exclusions). The `/file` viewer is reachable without it, from tool rows and changes, and is in scope.

## Settings

- [x] Settings index: header, connect terminal, account, features, appearance, agents, about, version, logout (`SettingsView.tsx`) — Settings
- [x] Account: profile, public id, secret key backup, linked devices, GitHub connect, logout, delete (`settings/account.tsx`) — Settings
- [x] Account switcher: list, switch, add, sign out one — Settings + Accounts
- [x] Appearance: theme, avatar style, bubble colours, session list options, compact mode (`settings/appearance.tsx`) — Settings
- [x] Language (`settings/language.tsx`) — Settings
- [x] Agents: machines and agent defaults (`settings/agents.tsx`) — Settings
- [x] Connect Claude (`settings/connect/claude.tsx`) — Settings. Diverges on purpose: the command is in the text colour, because happy-app's white-on-transparent card vanishes in light mode.
- [x] What's new (`changelog.tsx`) — Settings
- [~] Push notification settings and registration (`apiPush.ts`) — Settings + Ops (settings rows done; APNs registration is Ops)
- [x] Synced settings model with pending deltas (`AccountSettings`, `SyncEngine.pushSettings`)

## Platform

- [x] Credentials in the RN app's Keychain item
- [x] Multiple accounts with separate caches, RN custom server imported — Accounts
- [x] Offline-first delta sync: sessions, machines, settings, profile, projects, messages
- [x] Outbox for messages and attachments, with retry and failure states — Sending
- [x] Session protocol normalization and the reducer (`typesRaw.ts`, `sync/reducer/*`) — Reducer
- [ ] Session ops over RPC: spawn, resume, fork, duplicate, rename, machine ops, bash, files (`sync/ops.ts`) — Ops
- [ ] Git status (`gitStatusSync.ts`) — Ops
- [x] Icons as vector outlines, no icon fonts — Icons
- [x] Light and dark theme switching (`themePreference`) — Icons
- [ ] Dynamic Type — unassigned
- [ ] iPad layout (sidebar + detail) — unassigned
- [ ] Push notifications (APNs registration, open from a notification) — Ops
