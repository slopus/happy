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
  - Done: the resting capsule and its scrim, the composer it opens (backdrop, machine/project/worktree/harness menus, "Enter custom path", git worktrees, Composer's card with the permission, model and effort chips and the dock's filled send/stop button), the opening and closing motion with the text and the action row rising in their own beats, the start through `SessionStarter` with its status line and Stop, refusals while starting (the pressed control shakes, the hint and Stop flash), and the project card's `+` opening it on a new workspace.
  - Not yet: bots (the Session | Bot switch, faces, avatar) and picture attachments (the add button is hidden until there is an image picker).
- [x] Project grouping and expanded projects (`ProjectHomeList`, `ProjectGroup`, `projectGroups.ts`, `sessionListGrouping` setting) — Home
- [x] Session row actions as the iPhone shows them: the "Session" alert from `useSessionQuickActions.ts` (details, resume, fork, duplicate, archive). `SessionActionsPopover` is web-only — Home + Ops
  - Rename is absent from current happy-app and is not ported.
- [ ] Pending chats placeholder (`PendingChatPlaceholder`, `pendingChats.ts`) — Home
- [x] Update banner (`UpdateBanner`) and offline machines banner (`OfflineMachinesBanner`) — Home
  - The offline machines banner, the changelog's "What's new", and the store-version check (`sync.ts` `fetchNativeUpdate`, `POST /v1/version`). The check runs when home loads and whenever the app becomes active. When it reports an update, "App Update Available" takes "What's new"'s place and opens the store.
  - The check reads `update_required` and `update_url`, as happy-app does. `versionRoutes.ts` answers `{ updateUrl }` instead, so against the current server the store banner never shows, in happy-app or here.
  - The OTA update banner is excluded: a native build has no over-the-air JavaScript updates.
- [x] New session screen as a phone shows it (`new/index.tsx`, `machineChoices.ts`): the machine, path and worktree rows over a glass composer with the harness, its settings (permission, model, effort), the microphone and Send. Each picker opens in a glass popover above the control that opened it: a search field once there are more than four rows, the path field with the computer's places, and a page per setting. The offline help shows while the harness's daemon is down. Send starts through `SessionStarter`, as the dock does, and the session then replaces the screen. The screen shares the account's draft with home's dock. It opens from "Start New Session" on the empty home, and from a project's `+` when the dock can't open — Home
  - Deviations: back is the system navigation bar's, so off iOS 26 it is the plain chevron rather than happy-app's glass circle. The soft blur around a popover (`LocalBlurHalo`) is approximated with a partial blur. `autoSubmit` is not read, since nothing in happy-app sets it. The iPad sidebar, sheet and web layouts are not ported.
  - Current happy-app does not use recent paths; `recentMachinePaths` remains an untouched synced settings key for compatibility.
- [ ] Machine screen: status, sessions, resume, stop daemon, rename (`machine/[id].tsx`) — Secondary + Ops

## Chat

- [~] Session screen shell: header (title, avatar, status, git status), back, info (`session/[id].tsx`, `SessionView.tsx`, `ChatHeaderView`) — Chat
  - The title capsule and the avatar circle sit on the system navigation bar, made transparent, so back, its swipe and its menu are the platform's. Off iOS 26 the back button is the plain chevron and "Back", not happy-app's glass circle.
  - Not yet: the worktree tab strip and its title, the landscape layout without a header, and the file-view path segment.
  - Done: the CLI-outdated pill (dismissed per machine and version in `LocalSettings.acknowledgedCliVersions`), under the header on every device; see AGENTS.md.
  - Done: the stopped session's hint above the composer (`InactiveArchivedHint`), with Resume when its machine can run it, or the terminal commands, which a tap copies.
- [~] Inverted list engine with precomputed, off-main text layout, manual frames, bubble resize animations, scroll position keeping (`ChatList`) — Chat
  - A flipped collection view over `ChatListLayout`; rows are planned and measured off the main thread (`ChatRowMeasurer`), arrive and grow animated, and keep the reader's place, or the row they just opened or closed (`ChatScrollAnchor`). Older messages join the rendered window a page at a time as the reader nears them.
  - Not yet: AGENTS.md rule 8's minimal changesets and main-thread budgets for the apply path (Apply perf is reworking it), and paging older pages in from the server.
- [x] Keyboard: input bar tracks the keyboard, interactive dismiss, list insets — Chat
  - The dock rides the keyboard layout guide, through interactive dismiss too, and the list's insets follow it (`ChatScreenLayout`). The question sheet's footer also rides the keyboard; see AGENTS.md.
- [x] Messages: user bubbles, agent text, thinking, events, unsupported placeholder (`MessageView`) — Chat
  - User bubbles with their delivery status, agent text with its copy button, events and the unsupported line. Thinking is hidden, as happy-app's reducer hides it.
- [~] Markdown: blocks, spans, links, lists, tables, code blocks with syntax highlighting, copy (`markdown/*`, `SyntaxText`, `SimpleSyntaxHighlighter`) — Chat
- [~] Text selection screen (`text-selection.tsx`) and long-press copy (`LongPressCopyable`, MarkdownView's `selectable`) — Chat
  - A user's message copies through LongPressCopyable's menu; an agent's paragraphs, list items, code blocks and table cells, and on a tool's screen the command and its output, bring up the edit menu's Copy for that text. With Markdown Copy v2 (`LocalSettings.markdownCopyV2`) a long press on an agent's message opens the text selection screen instead.
  - Not yet: the Developer screen's toggle for Markdown Copy v2 (the screen isn't ported), so the text selection screen can't be reached in the app yet. Copy puts plain text on the pasteboard, without React Native's RTF. In the chat both long presses take 400 ms; React Native's selectable text takes 500.
- [~] Tool calls, hidden by default; tool headers, sections, errors, full view (`tools/*`, `knownTools.tsx`) — Chat
  - Deviation from happy-app, on purpose: tool output is collapsed by default (header only, compact row or card as `compactToolCalls` picks); tap the header to expand, in memory for the screen's lifetime; a pending permission, question or plan keeps its input open, never its output.
  - Partial: on iPad, permission buttons stretch instead of right-aligning, and a long permission list doesn't scroll at min(260, 35% of the window).
- [~] Tool views: Bash, Edit, MultiEdit, Write, Todo, Task, MCP, Codex patch/diff/bash, Gemini edit/execute, file, exit plan, ask user question, request user input (`tools/views/*`) — Chat
  - Edit, Write, MultiEdit and Gemini edit draw Secondary's DiffChunk (`HappyUI/Diff`), without syntax colour until its tokenizer lands. Codex patches (CodexPatch, apply_patch, GeminiPatch) open to each file under its DiffFileHeader, which opens that file alone on the message's screen, and Codex diffs (CodexDiff, GeminiDiff) to the turn's diff under its file's header; both use Secondary's `CodexUnifiedDiff`. A file header shows no pressed state. FileView is not ported.
- [~] Permission prompts: allow, allow for session, deny, mode switch (`PermissionFooter`) — Chat
  - Claude's and Codex's buttons, the busy ring while a reply is on its way, and the mode change an answer brings.
  - Not yet: the tablet layout (`PermissionFooterLayout.tablet`); see Tool calls.
- [x] Agent questions: banner, modal, inline form (`AgentQuestionBanner`, `AgentQuestionModal`, `InlineQuestionForm`, `agentCommunications.ts`) — Chat
  - The banner over the composer for what the chat can't show inline, the answer sheet, and the inline form; a sent message answers a waiting question. The sheet's footer rides the keyboard; see AGENTS.md.
- [ ] Image and file messages, decrypted on demand (`FileView`) — Chat + Sending
- [~] Message detail screen (`session/[id]/message/[messageId].tsx`) — Chat
  - ToolHeader's title; ToolFullView's terminal (CommandView with all output), Task, Edit, Write and MultiEdit full views, the generic sections, the outcome after a specialized view, and dev mode's raw JSON; a text message's whole text. Long output is drawn in pieces near the screen only (`TextChunks`).
  - The Codex patch and diff full views are cards; a patch opened from one file's header shows that file alone (`file`), or every file when it is no longer in the patch.
  - Partial: those cards round their header's corners but don't clip the diff at their bottom corners, as React Native's `overflow: hidden` does.
- [~] Agent goal bar, work group headers, rig activity bar (`AgentGoalBar`, `AgentWorkGroupHeader`, `RigActivityBar`) — Chat
  - Stop shows but sends nothing, as in happy-app (`agentGoalActionHandler.ts`). The goal bar has no details sheet; happy-app doesn't open one from the chat either.
- [~] Empty and pending states (`EmptyMessages`, `ChatFooter`) — Chat
  - A `pending-chat:` screen draws `PendingChatPlaceholder` over the composer: the shimmering title, then what was sent before the chat existed or the folder of the chat it was started beside.
  - Not yet: EmptyMessages paging back through invisible older pages (Retry, Load more), since the chat feed has no older-page signal. On a `pending-chat:` screen, becoming the chat once it settles, going back to the anchor when it fails, and the header reading the anchor's checkout meanwhile: nothing opens a pending chat yet (the worktree strip's `+` isn't ported).
- [x] Composer: growing text input, send/stop button, drafts (`AgentInput`, `MultiTextInput`, `agentInputLayout.ts`, `agentInputPrimaryAction.ts`) — Composer
  - Done: the card (`AgentInputCardView`, shared with Home's dock) with the status row and its vibing words, the week quota menu and the context gauge; send, Stop (at least 300ms of spinner), the locked button and its shake; drafts as useDraft.ts keeps them, Happy Agent drafts synced on every edit, remote edits taken (not mid-composition), the post-send clear left to the sender.
  - Not ported: the voice button and microphone (voice mode is excluded); zen mode, Enter to send and Shift+Tab, which are desktop and web only.
- [~] Autocomplete: slash commands and file mentions (`autocomplete/*`, `AgentInputAutocomplete`) — Composer
  - Done: `findActiveWord`, `applySuggestion` and suggestions.ts, tested on happy-app's own cases; commands from the defaults, `slashCommands` and `skills`; files and folders from `rg --files --follow`, kept five minutes; Fuse.js 7.1's ranking, checked against fuse.js on the same lists and queries; the glass list (48pt rows, 320 at most), picked by tap or Return.
  - Not yet: rows above the chat dock's top edge can't be tapped until the dock passes touches through to the composer (ChatViewController). Not ported: `LocalBlurHalo` behind the list; arrow keys and Escape, which React Native's iOS input never reports.
- [x] Attachments: picker (photos, camera, files), strip, upload progress (`AgentInputAttachmentStrip`, `attachmentSupport.ts`) — Composer + Sending
  - Done: the add button where `canUseAttachments` allows, "Add Image" with Paste from Clipboard and Photo Library (PHPicker, no permission prompt), images as JPEG at most 3072 on the long edge at 0.92, the 20-image and 10MB limits with their alerts, the strip, the not-supported alert before sending and the upload-failed alert after.
  - Not ported: camera and files, which happy-app's iPhone composer doesn't offer; upload progress, which it doesn't show; thumbhashes, which it can't make natively either.
- [x] Permission mode, model and effort pickers (`PermissionModeSelector`, `modelModeOptions.ts`, `NativeOptionsPicker`) — Composer
  - Native menus on the chips; a pick shows at once and goes out through `sessionSetAgentModes`. Happy Agent sessions offer their own models and reasoning levels.
- [ ] Session info: metadata, machine, path, archive, delete, duplicate, fork (`session/[id]/info.tsx`) — Secondary + Ops
  - The duplicate sheet is `Screens/SessionInfoDuplicateSheet.swift`, entered through `UIViewController.presentDuplicateSheet(sessionId:context:)`, which works like `push(_:context:)`. Home's row alert and the chat call that entry point instead of building their own.
  - The duplicate sheet draws its pre-iOS 26 look (blur material, sheen and hairline) on every iOS. happy-app's Liquid Glass card on iOS 26 is a follow-up, with this BlurView look kept as the fallback before 26.
- [ ] File viewer and changes with diffs (`file.tsx`, `changes.tsx`, `diff/*`, `CodeView`) — Secondary
  - The `/files` browser is gated behind `experiments` and excluded (see Exclusions). The `/file` viewer is reachable without it, from tool rows and changes, and is in scope.
  - The diff engine (`HappyCore/Diff`) and its layout (`HappyLayout/Diff`) are shared: Chat's Edit/Write/patch cards draw with `DiffChunkView`, and changes with `DiffFileView` sections.
  - Not ported yet: syntax colour in diff rows. happy-app colours rows after they are built, in a Prism worker (`components/diff/syntax/*`), and holds a file back (at most a second) until it is coloured; here rows draw in the plain text colour, with word-level emphasis. The renderer already colours by span kind, so the follow-up is a tokenizer that fills in the kinds.
  - Not ported: selecting text in diff rows (`selectable` on iOS in DiffFilesList).
  - Changes (`Screens/SessionChangesScreen.swift`) has both viewers: a CLI session's uncommitted files from git status, and a Happy Agent session's comparison with its branch base. File icons are the Seti outlines from `scripts/generate-file-icons.py` (`HappyIcons/FileIcons.swift`, drawn by `FileIconView`). One deliberate difference: when git status changes while a legacy fetch is in flight, the results are still applied and changed files are fetched again. happy-app drops the batch, which can leave those files loading.
  - Rows are drawn only near the screen instead of being mounted in batches (`useProgressiveRows`), so a long file is full height from the first frame rather than growing over a few frames.
  - The file viewer (`Screens/SessionFileScreen.swift`, routed from `.sessionFile`) reads the file and its `git diff`, keeps the last read per session for revisits, and shows the diff (DiffDisplay) or the syntax-coloured text (SimpleSyntaxHighlighter's tokenizer and colours). Lines are measured off the main thread and drawn only near the screen; the one Text block in happy-app wraps each line the same way. A long press on the text offers Copy for the whole file, as RN's selectable Text does (plain text only; RN also puts RTF on the pasteboard). A CRLF line's carriage return is left off the drawn text; alone at the end of a DiffDisplay row's Text, RN may measure it as an extra empty line (unverified). The route carries no line or column, as no happy-app caller passes one, but the screen takes them and scrolls as file.tsx does.

## Settings

- [x] Settings index: header, connect terminal, account, features, appearance, agents, about, version, logout (`SettingsView.tsx`) — Settings
- [x] Account: profile, public id, secret key backup, linked devices, GitHub connect, logout, delete (`settings/account.tsx`) — Settings
- [x] Account switcher: list, switch, add, sign out one — Settings + Accounts
- [x] Appearance: theme, avatar style, bubble colours, session list options, compact mode (`settings/appearance.tsx`) — Settings
- [x] Language (`settings/language.tsx`) — Settings
- [x] Agents: machines and agent defaults (`settings/agents.tsx`) — Settings
- [x] Connect Claude (`settings/connect/claude.tsx`) — Settings. Diverges on purpose: the command is in the text colour, because happy-app's white-on-transparent card vanishes in light mode.
- [x] What's new (`changelog.tsx`) — Settings
- [x] Push notification settings and registration (`apiPush.ts`) — Settings + Ops + Push. The rows read the active account's registration (`SettingsHooks.pushRegistration`).
- [x] Synced settings model with pending deltas (`AccountSettings`, `SyncEngine.pushSettings`)

## Platform

- [x] Credentials in the RN app's Keychain item
- [x] Multiple accounts with separate caches, RN custom server imported — Accounts
- [x] Offline-first delta sync: sessions, machines, settings, profile, projects, messages
- [x] Outbox for messages and attachments, with retry and failure states — Sending
- [x] Session protocol normalization and the reducer (`typesRaw.ts`, `sync/reducer/*`) — Reducer
- [x] Session ops over RPC: spawn, resume, fork, duplicate, machine ops, bash, files, mode sync, Happy Agent draft sync and git (`sync/ops.ts`, `rigComposer.ts`, `happyAgentGit.ts`) — Ops. There is no session rename in happy-app, so none here (`docs/OPS.md`)
- [x] Git status (`gitStatusSync.ts`) — Ops
- [x] Icons as vector outlines, no icon fonts — Icons
- [x] Light and dark theme switching (`themePreference`) — Icons
- [ ] Dynamic Type, scaled as RN scales it: every text follows the system size, uncapped, except the onboarding titles (`maxFontSizeMultiplier` 1.2) — scheduled after the open chat, composer, Home and Secondary items
- [~] iPad layout (sidebar + detail) (`SidebarNavigator`, `SidebarView`, `EmptySessionsTablet`, `useIsTablet`, `deviceCalculations.ts`, `layout.ts`) — Tablet
  - Done: a window 768 points wide or more switches live to the tablet shell (`TabletShellViewController`): the sidebar at 30% of the width clamped to 250–360, the persistent header with zen mode and back, zen mode kept in local settings, Home's session list reused in the sidebar with the open session selected, new session, show/hide archived, the Settings row, the blank detail and the tablet empty state. The 50-point header on iPad, the plain header's back button dropped on a tablet with the edge swipe kept, and `layout.ts`'s content width (800 only on 13-inch iPads) for the chat, the composer and item groups.
  - Not yet: the chat header's tablet branch (plain title, no avatar, no glass, 50 high) and its landscape hiding, the session screen's tablet spacing (content top, docked composer, 12-point input padding, oldest-end spacer), right-aligned permission buttons (the frames are `PermissionFooterLayout.tablet`), zen mode in the composer, the worktree strip's glass, the header's max width, and project grouping in the sidebar (happy-app uses `SessionsList`'s machine and project headers there). The rules for each are in `HappyLayout/Tablet/TabletBranches.swift`.
  - Untested on a device or simulator: rendering, rotation, Split View and Slide Over resizing. The layout math and rules are tested on Linux.
- [x] Push notifications (APNs registration, open from a notification) — Ops + Push. See AGENTS.md, "Push notifications".
  - Delivery, foreground presentation and taps are untested on a device or simulator; the routing, registration, installation id and signing-environment logic is tested on Linux.
