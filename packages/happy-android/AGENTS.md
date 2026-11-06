# happy-android

Native Android client for Happy, in Kotlin. `packages/happy-ios` is the iOS counterpart; keep the two
architectures comparable (local store, delta sync, crypto layer).

The React Native app has been removed. References below to its implementation
are historical porting notes, not live source dependencies. Current native
code, checked-in compatibility fixtures, `happy-wire`, and CLI/agent producers
are authoritative. Translation catalogs now live as plain JSON in
`packages/happy-i18n/translations`; run
`node tools/translations/generate.mjs` with no TypeScript loader. The old
RN-based crypto/send/diff generators are retired; their checked-in fixtures
remain compatibility baselines. Version and legacy voice configuration are
owned by `app/build.gradle.kts`, Firebase by `app/google-services.json`.
Preserve credential and push compatibility on upgrades.

## Scope

- **Latest protocol only.** `packages/happy-wire`, the CLI/agent producers,
  and the native clients' sync and encryption code are the source of truth.
  Do not port legacy protocol paths:
  sessions and machines without a `dataEncryptionKey` are skipped, not
  decrypted with the account secret.
- **Voice** in Happy (relay) sessions is switched off: `AppGraph.voice` is
  built with `enabled = false`, so a session's chat shows no voice button and
  `start` answers `NotAvailable` before the microphone, the server's grant,
  a sheet or ElevenLabs. The engine stays in the tree (removal not decided).
  When on, it uses Happy's server-controlled allowance and the app's own
  offer sheets (`payments/`, see "Purchases"), with ElevenLabs over WebRTC. The pinned SDK source patch in
  `vendor/elevenlabs` fixes audio focus, teardown and call-local mute.
- **An agent connection's voice call** (`call/`, `ui/call/`), iOS's
  `HappyCore/Call` ported: apart from the relay's voice above, its own new
  hosted ElevenLabs agent and four client tools (`CallTool`), no permission
  or question tool, hearing only new words and stopping errors from the last
  four conversations visited. Home's three-bar button sits immediately left of compose
  (`ComposeFab(onVoice)`); the call's bar (`CallFrame`, after Telegram-iOS's
  in-call status bar) slides down over the status bar and pushes the whole
  window, the top app bar first, down by its height, taking the top inset.
  A full-screen dialog goes through `PageDialog` or `WindowDialog` so that it
  carries the bar.
  It ends when the app leaves the foreground, another account opens or the
  relay's voice starts. For launch it connects to a public agent by its ID
  (`PublicAgentCallGrants`), a connection mechanism and not authentication;
  the ID comes from `HAPPY_CALL_AGENT_ID`, `-Phappy.callAgentId` or the
  ignored `local.properties` into `BuildConfig.CALL_AGENT_ID`, and is never
  committed. Without it the tap says "Voice isn't set up for this
  connection yet". Each device gets 20 free connected minutes in any
  rolling 30 days, 5 hours a month with the subscription (`CallAllowance`,
  local). The app's own sheet (`CallSheet`, no vendor UI) is the welcome,
  once, on the first tap while the subscription is on sale, and, once the
  time is used, says when it is back with Start greyed out. It sells only
  what the store and RevenueCat say is on sale (`Offer.OnSale`), never a
  made-up price (`Preview` is a debug-only test screen). A `ModalBottomSheet` calls
  `SheetStatusIcons()` so the bar under its scrim keeps light icons.
  `openSession` replaces a conversation on top and goes over anything else
  (`openConversationInPlace`). See
  `docs/agent-voice-call.md` at the repository root. The `happy.call.*`
  intent extras (`CallFixtures`), `CallProbe` and `CallLiveDeviceCheck`
  are for debug builds only.
- **Offline first.** Everything the account has lives on the phone; the
  server is only asked for what changed since the last sync.
- **Tool outputs are hidden by default** once the chat UI exists.
- The port includes auth, offline/live sync, home and session management,
  chat/composer/tools, attachments, diffs/files, onboarding/connect, settings,
  push, tablet layouts, purchases and voice. Experimental and social surfaces
  remain excluded. Store validation needs the existing signing identity,
  EAS build number and public RevenueCat Google key.
- **Happy Protocol V2**: a Happy Agent connected straight to the phone
  over Tailcat, with no relay account. Each pairing is an **agent
  connection**, an account of its own beside relay Happy accounts, shown by
  the agent's own name and avatar (see "Happy Protocol V2" below). It is
  added with the same **"Add"** as a Happy account (scan, routed by the
  code); the pairing screen is titled "Connect Agent". Never
  call these "computer" (relay "machine" wording is a separate, legacy
  concept and stays). Call the protocol Happy Protocol V2 in strings, docs
  and prose; never "direct" or "direct mode", except where the wire itself
  says it (`happy://direct?`, endpoints, JSON keys).
- **Naming on screen** (iOS's 64edb6a34): the two kinds of account are
  Happy Agent (an agent connection) and Happy CLI (a relay Happy account)
  wherever the person reads them; "legacy" is never shown. The words are
  `account_kind_*` in `strings_shell.xml`, iOS's own translations.
- **Naming in code:** current code has no prefix; old relay code that
  clashes is `Legacy*`; never `V2`, `New`, `Direct` or feature prefixes.
  `Legacy*` = used only by the legacy relay protocol or its UI. Shared
  components are main-app code with plain names, and legacy reuses them.
- **Excluded:** Stories, Stem Cells (and its spaces, sidebars,
  Prioritizing, Artifacts and Surfaces rows), and every experimental or social
  surface.
- `packages/happy-ios` is the reference for Steve's design decisions below;
  happy-app stays the reference for everything else.

## Rules

1. **UI is Jetpack Compose** (Material 3 is fine), with the theme and design
   tokens taken from happy-app (`sources/theme.ts`, `constants/Typography.ts`).
   Use the Android branch where theme.ts uses `Platform.select`. Strings are
   generated from shared JSON catalogs (see Localization); never edit
   `res/values*/strings.xml` by hand.
2. **Gradle with the Kotlin DSL and the version catalog**
   (`gradle/libs.versions.toml`). The wrapper is committed; there is no Gradle
   on PATH.
3. **Every component and screen has layout tests** that measure sizes and
   positions against the happy-app spec, and the composable's KDoc states
   that spec. They are Compose UI tests on the JVM through Robolectric (no
   device or emulator): see `app/src/test/.../ui`. Tests run on a
   411x891 dp, xxhdpi phone (`PHONE` in `LayoutTestSupport.kt`), so whole-dp
   values are whole pixels and comparisons are exact to a third of a dp.
   Put test tags on the outermost modifier of the measured box (before
   padding), and look nodes up with `useUnmergedTree = true` (`rule.node`).
   **Font scale:** text scales with the system font size, uncapped, as RN's
   does: sizes and line heights in sp (`happyTextStyle`), never dp. Icons,
   paddings and avatars stay in dp (`Icon` converts its size with `toSp()`,
   which undoes the non-linear curve). A box that holds text takes its RN
   height as `heightIn(min = …)`, so it is exact at 1.0 and grows instead of
   clipping; where RN keeps a fixed height and lets text overflow visibly
   (the header bar, Home's timestamp slot), keep the height and give the text
   `wrapContentHeight(unbounded = true)`. The only cap is the onboarding
   titles' 1.2. `ui/layout/FontScaleLayoutTest` checks screens at 2.0. Under
   Android 14's non-linear scaling Compose keeps each line height's ratio to
   its font, where RN converts the line height separately, so at large
   scales our lines run a few dp taller.
   **Tablet:** `ui/layout/WindowLayout.kt` answers responsive.ts and
   layout.ts through `LocalWindowLayout`. The two-pane tablet shell is
   Material's expanded class, width ≥ 840 (`TabletBreakpoint` reads
   `WidthClass.expandedMin`; happy-app's 768 is deliberately not used), so
   the Fold7's inner screen, 750 upright and 832 on its side, is one pane.
   Read it, not `LocalConfiguration`, for any `useIsTablet` branch.
   **Horizontal layout is one token set by Material width class**
   (`ContentTokens`, research/foldable-layout.md): compact (< 600) 16 margin
   and no cap, exactly the phone; medium (600–839, the Fold's inner screen)
   24 margin and a 640 measure; expanded 24 and 768 (the 800 column). Hold
   every content column with `Modifier.contentMaxWidth` (or
   `CenteredInputWidth`) *before* its own 16 inset, so cards, rows, message
   text and the bars' glyphs share one keyline per side. Top bars sit on the
   same column with 48 targets 4 in, so a 24 glyph's edge is on the keyline;
   never pad a bar control from the outside. Home's bar (both homes,
   `AgentTopBar(inset = HomeCardSpec.inset)`) is the one exception: Steve
   wants its account avatar on the left edge of the rows' avatars and marks
   inside the cards, and its last action's glyph on the rows' content end,
   so the whole bar comes a card's 16 further in (32 from the column's edge;
   48 targets kept). iOS's home doesn't do this; settings' bar stays on the
   column, as iOS's does. The compose FAB stays 16 from the column's edge,
   as iOS's dock does. Dialogs take
   `ContentTokens.dialogMaxWidth`, sheets `sheetMaxWidth`.
   **The window's unsafe sides**
   (iOS's b73b1accd): a phone on its side has the cutout on one side and
   may have the navigation bar on the other; `WindowLayout.safeLeft` and
   `safeRight` (system bars and cutout, never the keyboard) are the least
   room `contentMaxWidth` keeps there, so lists, cards and bars stay in
   the safe band while their grounds run edge to edge. Beside the tablet
   sidebar the main panel's sidebar side is safe.
   `ui/layout/FoldableLayoutTest` checks screens at 411, 750, 832 and 1280;
   `TabletShellTest` pins one pane at 750, 768 and 832 and the shell at 840.
   **The tablet split is happy-ios docs/IPAD.md's**, for Happy Agent and
   Happy CLI alike (`ui/tablet/TabletShell` around HappyApp's NavHost). The
   sidebar (30% of the window, held to 340–360) is the account's home
   itself under `LocalSidebarHome`, which gives it the sidebar's chrome: the
   bar holds the account and its name alone, agent home's search is a 36
   field at the top of the list with Cancel while open, and the foot has a
   48 settings circle and a 48 "New task" / "New session" pill
   (`SidebarFootBar`; settings alone with nothing to start). The sidebar
   never pushes: home opens through a `MainPanelOpener`, and the sidebar's
   (`MainPanel.opener`) makes what it opens the main panel's new root at
   once (`NavMotion.cutting`, no slide), or goes back to the root when it
   is already that (`MainPanelKey`: the route, the agent, the Surface),
   which is also the row it selects. A new home action goes through `go`
   with its key, never `nav` directly. The main panel's screens keep their
   own back; wrap a screen's back in `BackOrSidebarToggle`, which is the
   sidebar's toggle on the panel's root (Hide Sidebar / Show Sidebar, kept
   in local settings' `zenMode`). Home's page with home in the sidebar is
   the empty panel, desktop's owl (`MainPanelPlaceholder`). Tablet tests use
   `w1280dp-h800dp-xhdpi`; without `ProvideWindowLayout` a composable lays
   out as an unlimited phone.
   **Moving between screens:** one motion, measured from One UI Settings on
   the Fold7 (`research/navigation-motion.md`). The one NavHost takes all six
   of `ui/NavMotion`'s transitions and `Modifier.backdrop(nav)`: the new page
   slides across the whole pane over the old one in 450 ms on
   cubic-bezier(0.22, 0.4, 0, 1), the old one moves 26% the other way and
   dims 20%, nothing fades. The dim is a black scrim over the page beneath
   (`PageDims`, which every destination wears by being a `page<Route>`, not a
   bare `composable`), never the page's alpha: a page at 0.8 alpha costs
   HWUI a full-window offscreen layer, 10 to 18 ms of GPU allocation on the
   first frame of every push on the Fold. Toolbar back, system back and a gesture's commit
   run the same pop. The predictive gesture is that pop held at the finger's
   progress, and it finishes or cancels on the curve from there. Mirrored in
   right-to-left; with animations off, none. Never leave a NavHost on
   navigation-compose's defaults (a 700 ms crossfade, and a scale on the
   gesture), and never give a destination its own transitions.
   **Switching accounts** is not a push (`ui/AccountSwitch.kt`, iOS's
   12a4c4bc9): from home's account menu a new stack's home dissolves in over
   the old one in 0.28 s (`Dissolve`, iOS's `rootCrossfade`); from
   Settings' accounts card or search the stack is kept, Settings stays on top
   where it was scrolled and home changes under it unseen (`HomeRoute` and
   `SettingsRoute` show whichever account is open). A Happy account and an
   agent connection have different pages, so a switch between kinds
   dissolves Settings' scrolling part, the bar steady; one of the same kind
   only changes the values. Signing out of or disconnecting the open account
   from Settings keeps Settings too. The screens follow
   `AppGraph.openAccount`, which changes once per switch (`whileSwitching`),
   never through "none": a switch never shows the first screen
   (`AccountSwitchTest`).
4. **The local store is SQLite through the framework API**
   (`SQLiteOpenHelper`, WAL, hand-written SQL in `data/`). Why not a library:
   the schema is a handful of tables whose rows are mostly JSON documents
   keyed by server ids, and the access paths are few and known (upsert a page,
   read by watermark, list newest first). Room would add annotation processing,
   generated code and a migration framework for no query we need; SQLDelight
   adds a build plugin. The framework API costs no dependency and no startup
   time, and `HappyStore` keeps it typed.

5. **Every screen has the standard top app bar** (`Header`, through
   `Screen`/`StackHeader` where it can), and its back button does what the
   system back does. Never hide it, or replace it with a custom or floating
   bar, without Steve's explicit OK. Steve made two exceptions: the
   first screen (`ui/start`): no bar, only a floating ⋮ over the
   full-window gradient; and the QR scanner: no bar, the camera full
   window with a floating close (✕) top right.
6. **System back works on every screen, predictive back included**
   (`enableOnBackInvokedCallback`). A `BackHandler` may close something open
   on the screen (a sheet, the focused dock) and then let back through; it
   never swallows back for good.

### Design decisions that override happy-app

Steve made these for the native apps. Where happy-app does otherwise, they
win:

- **Top app bar, back:** rules 5 and 6. happy-app's first-run Link Your
  Computer page swallows back; here back leaves the app as on any root.
- **Home's top bar:** the current account's avatar on the left opens a
  drop-down of the relay accounts and agent connections (avatar and
  name each, a check on the open one), then one "Add". The two kinds are
  "Happy CLI" (a relay account) and "Happy Agent" (an agent connection),
  never "legacy" (iOS 64edb6a34): one with no name of its own goes by
  its kind, and TalkBack hears the kind after each row's name
  (`ui/home/AccountMenu.kt`); picking one switches
  (`AppGraph.open`). Settings on the right. The legacy home and agent
  home share one bar (`AgentTopBar`, `BarTitle`): the account's name as
  the title. While the link is on its way (iOS 7aee3a9b8, Telegram's
  title) "Waiting for network…", "Connecting…" or "Updating…" stands in
  the name's place behind a 16 spinner, debounced by `LinkStateDebounce`
  and swapped with a 6 slide and fade over 250 ms; offline keeps the
  name, since home's list says why. No logo, filter menu
  (grouping is in Appearance) or "Sessions" title. Compose is a FAB at the
  bottom right of both homes (`ComposeFab`); home has no text input. One account is open at a
  time: a Happy account or an agent connection (`openAgentId`); each has
  its own back stack. **Add** opens the scanner straight away (the
  app's one `LocalAddFlow`, the same as the first screen's Connect;
  without a scanner it asks for the link): a terminal code adds a Happy
  account that approves it, a pairing code adds an agent connection. The
  open account stays signed in. A Happy account added while one is open
  goes to that account's server; with an agent connection open, to the
  server chosen on the first screen.
- **First screen** (`ui/start`), a splash shown only while the phone has
  no Happy account and no agent connection; never again once one is
  added. Deliberately not iOS's:
  Paper's Grain Gradient (AGSL port, Apache-2.0, attribution in
  `GrainGradient.kt`) behind everything, edge to edge; the logotype
  centred; one centred "Start" that scans, 48 above the bottom inset. The code is routed
  (`ConnectKind.Add`): `happy://terminal?` creates a Happy account and
  approves that terminal in one step (`AuthRepository.createAccount`'s
  `prepare`; a failed approval keeps no account), `happy:///account?`
  says it needs a signed-in phone, `happy://direct?` pairs an agent. The
  ⋮ drop-down holds Enter link manually (same routing), Restore Happy CLI
  account and Happy CLI server, and nothing else: no "Get help", and no
  "Create account" because a Happy account is only ever made by a
  terminal code. A pasted link routes exactly as the scanned code does
  (`ConnectFlow.connectWithUrl` through `route`); only a link of no known
  kind reads differently, as "Invalid authentication URL". Dialogs are Material 3
  (`HappyAlert`, `PromptModal`), not happy-app's iOS-style card, and only
  screens with a text field of their own move for the keyboard
  (`Screen(avoidKeyboard = true)`); the first screen never does. Palette: blue and violet
  over near-black (dark) or their tints over lavender white (light), no
  green or orange, text AA or better. The shader runs on Android 13+
  (`RuntimeShader`), about 15 frames a second while resumed, still with
  animations removed; older Android draws a still gradient in the same
  colours.
- **Compose:** from home it opens an empty new chat; from a chat it
  replaces that chat with an empty one, animated, with Back going to home.
  The empty chat becomes the real session in place on the first send, with
  no route change (not happy-app's draft route then navigate). On a
  Happy account the empty chat is `SessionRoute("compose-chat:<uuid>")`
  (`ui/chat/ComposeChat.kt`, iOS's LegacyComposeStart): its composer
  writes the account's new-session draft; centred between the bar and the
  composer (`ui/chat/NewWorkPanel.kt`, iOS's NewWorkPanel/NewWorkLayout)
  sit Session | Bot | Task (always shown; a kind no computer's Happy Agent
  makes is dimmed, all pickable while the computers are still arriving),
  the computer (always, with an Online / Offline · 3d / Happy Agent offline
  chip on its corner, "Loading computers…" until they are in), then a
  session's folder and harness, or a bot's name (a refusal said inside the
  field), each a menu, the folders following the computer. Bot and Task
  go to a computer whose Happy Agent makes them and answers
  (`MachineTarget`, `NewSessionServices.setKind`), moved off an offline
  one unless the person picked it. Short of room the block drops its note,
  then tightens. Its first send starts the session, bot or task (Happy
  Agent's `target: {kind: "task"}`) with that text and images, and the
  screen then shows it. A send to a computer that doesn't answer, or
  before the computers are in, is refused in full before anything starts;
  a refused or failed start says why and keeps the text; leaving before
  the computer answers stops the start and the draft stays. On a tablet
  the sidebar's New session opens the same chat as the main panel's root. An
  agent connection's empty chat asks Task or Bot and an
  optional name in the same place; its first send makes that kind under
  that name (`POST /v0/tasks` or `/v0/bots`, once, the same ids on a
  retry) and only then sends, so a refusal keeps the text and says why.
  Left unsent, the next compose opens it as it was (`AgentSession.unsentWork`).
- **Home cards:** the legacy home's rows sit in the agent home's inset
  cards (`HomeCardRow`: 16 in, radius 26, 24 between cards, hairlines
  inside). Day and section headings become gaps; a computer heads its
  cards only when there is more than one; the archive is one card under
  its toggle. Rows show no timestamp.
- **Legacy tasks** (iOS 36b11c5bf): a Happy Agent session with
  `metadata.task` is a task. Each computer's tasks follow its bots, in
  the person's `orderKey` (plain string order), then unjoined ones newest
  first. A task is named by the task, placed at `~/Tasks/<folder>`, wears
  its seed's face with no harness badge, and its folder is never a place
  for new work. Its machine alone ends it: Leave task (`leaveTask`, offered
  where `rpcMethods` lists it; also the swipe) and Archive task
  (`killSession`, only where `task.canArchive`); never a server archive or
  delete. Left or archived, it leaves every list at once and comes back
  only with the machine's refusal.
- **Fonts:** the system font for all text, the platform monospace
  (`FontFamily.Monospace`) for code. Not IBM Plex.
- **Home rows** have strict, precomputed heights, per row kind and font
  scale. Idle updates (time ago, presence, working) never change a height,
  and neither home nor chat scrolls by itself while nothing changed.
- **Settings cards** look the same everywhere and come from one component
  (`ItemGroup`).
- **Animated emoji never loop** (Kirill, for both apps). An animated emoji
  or sticker (the Lottie art in `res/raw`: state pictures, the boba,
  voice's mic) plays once when it appears, holds its last frame, and plays
  once more on a tap; with animations removed it holds still. Draw every one
  with `SceneAnimation` (or `StateAnimation`), never
  `LottieConstants.IterateForever`. A row icon that is an emoji sits on a
  tile like every other row's glyph, the tile's size (30) in the row's 32
  icon box and orange for the boba, at the row's top when the row grows
  (`SupportBobaCard`).
- **Settings search** (iOS's, `ui/settings/SettingsSearch.kt`), on both
  kinds of Settings: the bar's search button turns the bar into a field
  and hides the picture, name and cards; what is typed finds accounts by
  name, the page's rows (`SettingsEntry`, which the page draws too) and the
  rows of its own pages (`accountPageEntries` and the like, beside each
  page), in one card under the bar, or "Nothing found". A page's row opens
  that page with `reveal` in its route: it scrolls the row to the middle and
  flashes it (`ProvideRowReveal`, `Modifier.revealRow`). A new row on such
  a page goes in its `*PageEntries` too; `SettingsSearchTest` checks they
  agree. An agent's home search finds its Settings rows the same way, from
  `agentSettingsIndex()` (iOS's `SettingsIndex.computer`):
  `openAgentSettingsRow` opens the agent's Settings or Appearance page with
  `reveal`, or Chief of Staff with the ask for name and avatar.
- **Agent home search** looks and moves as iOS's
  (`HappyCore/Agents/Search.swift`, `ui/connection/AgentSearch.kt`): the
  results fade in over home (200 ms ease-out) on its own ground, drawn as
  home is, and home never moves under them. Nothing typed shows the eight
  bots and tasks last active (`AgentSearch.recent`). A query is the node's
  one search (happy-agent API.md, "Search"): one flat card fusing the
  phone's half with the daemon's, then quick actions and settings (local
  only), each under its heading, at most six, or "Nothing found" in a
  capsule. It is the only search over vaults; a vault has none of its own.
  - The phone's half (`localSearch`), at keystroke speed, from what it
    holds: home's conversations (`agent:`), projects and worktrees, the
    catalog's documents (`document:`) and other Surfaces (`surface:`),
    joined or not (`AgentSearchSources`, read only while search is open),
    the open todos kept (`todo:`), the kept artifact page (`artifact:`),
    and home's own pages (`home:`, phone only). Each kind is ranked by
    desktop's `AgentSearch.rank` (words in any order, a kind's name three
    below a title match, joined before not), then the kinds fused as the
    daemon fuses its providers: by place, then provider order.
  - The daemon's half: `POST /v0/search` with `{q, limit}`
    (`search/Search.kt`), 120 ms after the typing rests, cancelled by the
    next keystroke, only where health says `capabilities.search`; offline
    or older, the phone's alone. `SearchFusion` is the shared RRF (k = 60)
    over `key`, the client package's vectors in `test/resources/search/`
    (from happy-agent c67719baf, client 0.0.158). A daemon's answer joins
    only the query it was for. A result found by both keeps the phone's
    row unless the daemon has a content line for it; vault items, messages
    (titled by their conversation, opening it), events and content matches
    are the daemon's rows, with a second line (66 high). People and skills
    have no page on the phone and are left out with unknown types.
  What a result opens leaves the search for coming back; new work, Cancel
  or back, and a pull down from the results' top end it.
  The Happy CLI home has no search, as on iOS.
- **Bot invitations** (happy-ios HappyGuest, docs/APP-CLIP.md; `guest/`,
  `ui/guest/`): `https://app.happy.engineering/bot/invite/<token>` opens a
  guest chat with someone's bot, signed in or out, over whatever is up. The
  manifest's autoVerify filter takes that path alone (production's overlay
  already takes the whole host). The guest names themselves once, joins, and
  chats as plain text with "Message as <name>"; ⋮ reports or leaves. Its
  transport is its own (no cookies, cache, redirects or owner credential),
  and its sessions live in their own Keystore-sealed store
  (`guest-sessions`, service `bot-guest`), off backups and transfers, never
  the accounts'. Expiry, revocation, a full invite and Leave wipe that
  invitation's session; one a day past expiry is pruned; with none left the
  item goes. A debug build reaches a local bridge with
  `adb shell setprop debug.happy.guest_api http://127.0.0.1:<port>`, never
  from the link. iOS Preview's demo host isn't taken.
- **QR codes:** every scan is classified (terminal, account, agent
  connection, or not ours) and routed. A code the screen can't use shows an
  error; nothing is silently ignored. Scanning works while signed in.

## Layout

```
crypto/   pure Kotlin/JVM, no Android: every primitive and key derivation of
          happy-app's encryption, byte for byte. BouncyCastle low-level
          classes (no JCA provider), so it behaves the same on every device.
analytics/ product analytics, its own Android library behind the `Analytics`
          facade (see "Analytics"); knows none of the app's types.
app/
  auth/     account auth (POST /v1/auth), credentials in expo-secure-store's format
  config/   server URL (survives logout), device-only settings (theme)
  data/     HappyDatabase (schema), HappyStore (typed access + change ticks)
  sync/     AccountSync (per-account owner), SyncEngine (delta sync), LiveUpdates,
            Presence, MessageSync (history), MessageSender (outbox), MessageMeta,
            RpcClient + SessionOps + MachineOps (ops.ts), SessionComposer (picks
            and drafts), HappyAgentGit, RigCapabilities, SyncApi + UpdateTypes
  net/      HappyHttp (OkHttp + kotlinx.serialization, X-Happy-Client header),
            SocketIoClient (the /v1/updates socket)
  ui/       theme, components (Item, ItemGroup, RoundButton, Header, ...), screens
            start/      the first screen, its ⋮ menu, GrainGradient (AGSL)
            onboarding/ restore, Link Your Computer, onboarding settings
            connect/    QR scanner and codes, connect flows, terminal screens, deep links
            troubleshoot/
  AppGraph  hand-wired object graph; owns the signed-in sync loop
  model/    typed views of the stored JSON: Settings (sync/settings.ts);
            settings/ has agentDefaults.ts, local settings, SettingsRepository
  text/     Resources.plural / pluralResource, PluralExactNumbers (generated)
benchmark/  on a device, against the bench build: StartupBenchmark (cold start) and the
          Baseline Profile generator (research/cold-start.md)
tools/translations/  generates string resources from shared JSON catalogs
```

## Localization

Shared UI text comes from the ten JSON catalogs in
`packages/happy-i18n/translations`, generated into
`res/values/strings.xml` and `res/values-{ru,pl,es,it,pt,ca,ja,b+zh+Hans,b+zh+Hant}/strings.xml`.
After the JSON catalogs change, regenerate and commit the output:

```
node tools/translations/generate.mjs
```

`TranslationResourcesTest` fails until you do.

A string happy-app's catalogs don't have (iOS's words, Android's own) first
reuses a catalog key whose English and meaning match exactly
(`session_new_chat`, `common_back`, `settings_account_status`…). Otherwise it
goes in `res/values/strings_<area>.xml` (`strings_settings.xml`,
`strings_conversation.xml`, `strings_android.xml`…) **and** in every
language, `values-<locale>/strings_<area>.xml` under the same name, with the
same placeholders and each plural with that language's categories (one/few/
many/other in Russian and Polish, one/many/other in the Romance languages,
other alone in Japanese and Chinese). `AndroidStringsTranslatedTest` fails
while one is missing, stale or mismatched. Brand and product names and
literal examples (`Happy`, `Happy Cloud`, `Chief of Staff`, `deploy-api`) are
`translatable="false"`.

Where happy-app calls `t()`, use the catalog key; never re-type its English.
Where happy-app writes English inline instead (most of HomeDock, the machine
screen, info.tsx's activity rows, the agents and push-diagnostics settings,
useStartSessionFromDraft's errors), the port takes its words into
`strings_<area>.xml` (`strings_home.xml`, `strings_tablet.xml`,
`strings_push.xml`, `strings_chat.xml`…) and translates them like any other
Android string. No file is English-only.

Text decided outside composition is not English either: it is a typed
reason the screen resolves with `stringResource`. A conversation's errors and
alerts are a `Problem`, an agent turn's failure a `FailureReason`
(`ui/conversation/ProblemText.kt` words both), a scan's a `ScanFailure`,
a start refusal carries `StartRefusal.text`, and spawn, worktree, bot name
and changes errors are `Words` (`text/Words.kt`): `Words.Ours` for our
sentence, `Words.Said` for what the server, daemon or git said, shown as it
came. Raw agent, daemon and server messages are never translated, but our
wrapper around them is. What stays a Kotlin literal: tool titles
(`chat/tools`), slash-command descriptions (`autocomplete`), reducer events,
the developer-only voice diagnostics, and brand and product names ("Claude
Code", "OpenAI Codex", "Happy Engineering"). When happy-app moves one of these
into its catalogs, switch to the key.

How a catalog entry becomes a resource:

- **Name**: the key path, camelCase to snake_case, dots to `_`
  (`settings.whatsNewSubtitle` → `settings_whats_new_subtitle`). If two keys
  come out alike, the later one keeps its dots as `__`
  (`settingsVoice.language.title` → `settings_voice__language__title`).
- **String**: `stringResource(R.string.common_cancel)`.
- **Function**: a format string whose arguments are the function's
  parameters in `_default.ts`'s annotation order, text as `%n$s` and numbers
  as `%n$d` (pass `Int`):
  `stringResource(R.string.settings_github_connected, login)`.
- **Function that picks words by a count**: `<plurals>`, rendered with
  `pluralResource(R.plurals.time_minutes_ago, count, count)` (or
  `resources.plural(…)`), never `pluralStringResource`: where a catalog
  spells out a number its Android plural category doesn't cover (Japanese
  `count === 1`, Portuguese 0), the generator adds a `<name>_n<number>`
  string, and only `plural` knows to use it. The count is also a format
  argument, in its place among the parameters.
- **Function that picks words by a boolean or a fixed set of strings**: one
  string per case, `<name>_true` / `<name>_false` or `<name>_<value>`
  (`settings.featureToggled({ feature, enabled })` →
  `settings_feature_toggled_true` / `_false`, each taking `feature` as
  `%1$s`; `settings.machineStatus({ name, status })` →
  `settings_machine_status_online` / `_offline`). Choose the resource in
  Kotlin; the chooser is not a format argument.

## Credentials and upgrades from the React Native build

The app reads and writes the account credentials in **exactly** the entry
happy-app uses, so installing this app over the React Native build (same
applicationId) keeps the user signed in, and going back to the RN build
does too. There is no second copy. `auth/ExpoSecureStore.kt` reimplements
expo-secure-store 55.0.9's Android storage (`SecureStoreModule.kt`,
`AESEncryptor.kt`, `HybridAESEncryptor.kt`):

- SharedPreferences file `SecureStore`, key `key_v1-auth_credentials`
  (default keychain service `key_v1`; the unprefixed key of older versions is
  read too).
- Value: JSON `{ct, iv, tlen, scheme: "aes", usesKeystoreSuffix: true,
  keystoreAlias: "key_v1", requireAuthentication: false}`, base64 without
  line breaks; plaintext is tokenStorage.ts's `{"token":…,"secret":…}`.
- AES-256-GCM key in AndroidKeyStore under
  `AES/GCM/NoPadding:key_v1:keystoreUnauthenticated` (no suffix for items
  with `usesKeystoreSuffix: false`). The hybrid RSA scheme (API < 23) is
  read-only, as in expo.
- Failure handling matches expo: a missing Keystore key or one that no
  longer opens the value deletes the entry.

If expo-secure-store is upgraded in happy-app, diff its Android sources
against this file. `ExpoSecureStoreTest` runs a copy of expo's read and write code
against ours in both directions.

**Keystore keys and preferences survive an upgrade only if the new APK has
the same applicationId and is signed with the same certificate as the Play
build.** A different certificate cannot install over it at all, and a
reinstall loses the Keystore key. Release and preview builds must be signed
with the existing EAS/Play signing key; no signing config is checked in
(see "Versions and signing").

The custom server URL is carried over, read-only: `RnServerConfigImporter`
reads `custom-server-url` from happy-app's unencrypted MMKV `server-config`
instance (`files/mmkv`) and never writes the React Native files. No file is
the default server; a value it can't trust (torn, checksum mismatch, not a
URL) asks the person to confirm rather than sending the token to a wrong host.

## Sync

`AppGraph.account` is the signed-in account's `AccountSync` (null when
signed out); it owns everything below and stops before sign-out clears the
store. All network, decryption, decoding and SQLite work runs on
`Dispatchers.IO`; the flows can be collected on the main thread.

**Delta sync** (`SyncEngine`). Settings: pending local changes are uploaded
with the version they were based on, merged over the server copy on
`version-mismatch`, then re-read. Machines and profile: read whole (no delta
endpoint; an empty machine list never wipes known machines). Sessions:
`/v2/sessions?changedSince=` from the stored watermark, paged by cursor; a
full listing on first sync and once a day catches deletions. Messages: see
history below. It runs on sign-in, on every socket connect, and when the app
returns to the foreground.

**Disk never on the main thread** (research/offline-first.md). A screen
waits for the disk with its loader, never with a frozen frame, and never
waits for the network when what it shows is on disk. `DiskThread.check()`
guards every `HappyStore` access and every agent connection file (catalog,
kept resources and conversations, pictures); tests turn on
`DiskThread.strict` (`OfflineFirstJourneyTest`), debug builds log
StrictMode's disk detection. The graph is built off the main thread
(`HappyApplication.graphReady`); MainActivity holds its first frame until
then, which costs nothing measured, since the graph is done before the
first traversal. That thread then starts reading the open home from disk
(`AppGraph.warmHome`), so on a release build the kept rows are in the
first frame (research/cold-start.md, `ColdStartTest`). An agent
connection keeps, beside its catalog, each opened
conversation's newest 100 runs (`KeptConversation`, iOS's
`conversation:<agentId>`), its Surfaces' last read, and bots' and
projects' pictures; a chat shows its kept runs, then asks only
`messages?after=` the newest finished run's last message. The journal
resumes from the kept cursor; only a gap reads the snapshot again.

**Store merges** (`HappyStore`). Writes merge instead of overwrite: each
versioned document (metadata, agentState, daemonState) keeps the higher
version, presence the newer `activeAt`, counters the maximum, so a slow page
cannot undo a live update. A write that changes nothing touches no row and
wakes no observer. `versions` counts changes per area (sessions, session
activity, machines, machine activity, account) and per session (messages,
outbox); `messageChanges(id)` and `outboxChanges(id)` are its per-chat views.
Records are stored decrypted (the sandbox and file-based encryption protect
them at rest, as MMKV does for happy-app); their data keys are stored wrapped.

**How big it gets, and logout.** happy-app keeps no messages on disk at all:
they live in memory for the run (its decrypt cache holds 1000) and are
fetched again on the next start. Here they stay in SQLite so a chat opens
offline and at once, and nothing prunes them: a session's rows go when the
session is deleted (`ON DELETE CASCADE`), and only chats that were opened
are stored, each from its newest page back as far as the reader scrolled
plus the five-page background budget. That is the bound, recorded rather
than enforced; a chat's rows are one contiguous run of seqs, so trimming
the middle would break paging. **No migrations:** the native app hasn't
shipped, so a database from any other schema version is dropped and created
again, and storage keys and preferences are renamed outright, without
fallbacks. The one exception is importing the React Native app's account:
its credential item and its MMKV `server-config` (below).

**Accounts** (`accounts/`, iOS's AccountController and AccountRegistry):
several Happy (relay) accounts and agent connections, switched from Home's
avatar menu. `AccountStore` keeps the registry (no secrets: id = the
account's anon id, server, added order, cached name and avatar, the open
id). The first account keeps the React Native credential item (`Shared`),
so an upgrade stays signed in; the rest have items of their own (`Own`,
keychain service `account`). The first reconcile that finds the shared
item reads React Native's server with `RnServerConfigImporter` (read-only;
an unreadable file marks the account unconfirmed and no request is sent
with its token). Each account has its own database, `account-<id>.db`;
`HappyStore.use` points the one store at the open account's. Switching
keeps every account signed in (`MultipleAccountsTest`).

Logout (`AppGraph.logout`) signs out the open account only:
the `beforeLogout` hooks first, while signed in (the push unregister); then
its database and credentials; the next account by added order opens. With
the last account also go local settings, the What's New marker, the
new-session draft (stored and in memory, `afterLogoutWipe`), picked-image
copies and the image loader's caches, and the UI language goes back to the
device's (it was the account's setting). The server choice stays
(`LogoutWipeTest`).

**Large sessions** (`perf/LargeDataTest`, `perf/ChatDisplayTimingTest`).
The reducer, ChatFeed and HomeListModel derive off the collecting thread
and stay linear. What still runs in ChatList's composition per snapshot was
measured at 5040 rows (JVM, median after warm-up): `groupChatRowsForDisplay`
1.3–2.6 ms, `chatListItems` 0.5–0.8 ms, `WorkGroupExpansion.observed`
0.2 ms. Below the 8 ms line, so it stays on the main thread; the guard fails
only at 50 ms, a quadratic rather than noise.

**Live updates** (`net/SocketIoClient`, `sync/LiveUpdates`). The
`/v1/updates` socket (apiSocket.ts) with `clientType: user-scoped`, the
token, `happyClient` and `appState` read at every connect; `app-state` is
sent on every connect and on foreground changes. Why our own client instead
of socket.io-client-java: Happy uses five packet types of Engine.IO 4 /
Socket.IO 5 over WebSocket; the library brings a second Engine.IO stack,
org.json and its own threading for that. OkHttp's WebSocket is already here,
and the wire format is tested directly (`SocketIoProtocolTest`). Reconnects
use socket.io-client's backoff (1 s to 5 s, jitter 0.5, forever); a
heartbeat watchdog drops links silent past `pingInterval + pingTimeout`. The
server keeps no recovery state, so every connect runs the delta sync and
catches up the open chats. `connectionStatus` (`ConnectionStatus`:
disconnected, connecting, connected, error) is what Home's header shows
(homeConnectionStatus.ts: shown unless connected).

Handled updates: `new-message` (next seq is appended; a gap fetches
`after_seq`; turn start/end messages set thinking), `new-session` (stored
from the update itself), `update-session` (metadata/agentState with their
versions, three-state `projectId`; control hand-off refetches messages),
`delete-session`, `new-machine` (carries its data key), `update-machine`,
`delete-machine`, `update-account` (profile fields, settings with version;
pending local settings stay on top), `new-project`/`update-project` (the
project catalog refetches, `ProjectServices`), `delete-project` (the catalog
and a resync). Artifacts, friends (`relationship-updated`) and feed updates
are ignored until those features exist; KV updates are ignored because KV is
unused by happy-app (nothing imports apiKv.ts). Not copied on purpose:
`update-session`'s account `seq` (here a session's `seq` is its message
counter, which history sync relies on), and the `session-event` ephemeral
(happy-app's browser-tab unread counter). Anything that cannot be applied alone (unknown session
or machine, a `new-session` body that does not decode) asks for the delta
sync instead of guessing.

**Presence** (`sync/Presence`, `account.presence`). `activity` and
`machine-activity` ephemerals and `usage` live in memory only, never in
SQLite. `sessions` / `machines` (`Map<id, SessionPresence | MachinePresence>`)
change only when something shown changes: online/offline, thinking, or an
offline row's last-seen time; heartbeats publish nothing. Stored rows seed
it and the newer `activeAt` wins; the server is the only authority on being
online. Home and Chat read status from here, not from the `active` columns.

**History** (`sync/MessageSync`, `account.messages`). A session's stored
messages are one contiguous seq run (`messages_oldest_seq..messages_seq`).
`messages(sessionId): Flow<List<MessageRecord>>` opens the chat: it fetches
the newest page (`before_seq`), catches up forward, then prefetches up to
five older pages per session per sign-in. `loadOlder(sessionId)` loads one
page on demand and returns whether the run moved back;
`paging(sessionId)` gives `isLoaded`, `hasMoreOlder`, `isLoadingOlder`. A
backward page that does not move the cursor ends history. `preload(sessionId)`
is Home's press-down (`HomeListCallbacks.onPressDown`, sync.ts
`preloadSession`): the newest page only, one session at a time (another
touch drops it), skipped for a chat that is open or already stored, never
retried, and no visit, read or older history. A plan-mode switch in that page
waits for the chat to open (`StoredSource.PRELOAD`/`OPENED`).

**Sending** (`sync/MessageSender`, `account.sender`). `send(sessionId, text,
meta)` builds the user record exactly as sync.ts `sendMessage` does (sentFrom
`android`, delivery meta, `appendSystemPrompt`, the mode fields, displayText;
`meta` is laid over it), seals it with the session key, writes it to the
`outbox` table and returns the localId; it throws `SendException` when
nothing was queued (session not synced, a permission mode the session's CLI
cannot parse). The mode and delivery meta are resolved as messageMeta.ts
does (`MessageMetaResolver`) from the composer mirror, agent defaults and
presence. A per-session loop POSTs everything queued to
`/v3/sessions/:id/messages` with backoff. `send(..., attachments = records)`
queues pre-built plaintext records (attachment `file` events) ahead of the
text, in order, sealed and retried the same way; rows go `QUEUED` → `SENDING` →
`SENT` (stored, waiting for its echo) and are deleted when the echo is
stored. `FAILED` (a 4xx the server will repeat, or still unsent 30 s into
the background) waits for `retry` or `discard`. Rows survive restarts; an
interrupted send is re-queued at start (the server dedupes on localId). The
POST answer never moves the message cursor; it asks for a catch-up. Chat
reads delivery state from `sender.outbox(sessionId)` / `store.outbox`. The
record is checked byte for byte against happy-app's own `sendMessage`
(`tools/testvectors/send.mjs` → `app/src/test/resources/happy-ts-send-vectors.json`).

**Ops** (`account.sessionOps`, `account.machineOps`). ops.ts over
`rpc-call` (params and result sealed with the session's or machine's data
key, 50 s ack timeout) and HTTP. Session: abort, allow/deny with mode,
allowed tools and decision, question answers, kill, archive, delete,
switch, goal action, avatar, bash and files. Happy Agent sessions are asked
only what they advertise (`RigCapabilities.kt`, rig.ts gates). Machine:
spawn (incl. Happy Agent's `happy-agent-spawn`), resume with the data-key
fallback, stop session/daemon, bash, delete, rename, Claude/Codex fork,
duplicate and rewind points, `forkAndSpawn`, side chats. Commands throw
`RpcException`; calls with a result type return the failure in it.
`account.git` is Happy Agent's native Git changes (happyAgentGit.ts).

**Composer** (`sync/SessionComposer`, `account.composer`). Each session's
draft and picks (`ComposerMirror`: storage.ts's mirror fields), stored in
the `composer` table. `setAgentModes(id, mapOf(field to value))` is ops.ts
`sessionSetAgentModes`: applied at once and pushed with `update-metadata`
(kept while in flight, then metadata wins). On a Happy Agent session the
picks and text are one stamped draft written per rigComposer.ts: typing
debounced 250 ms, picks and clears at once, one write in flight, adopt a
remote draft stamped the same or later, restore from disk and flush on
reconnect. `setText`, `clearDraft`, `mirrors` / `mirror(id)`.

### Recreation and process death

The manifest handles orientation, screen size and uiMode, so rotation,
folding and a dark/light switch don't recreate the activity. A font scale
or locale change does, and so does the system after process death.
`StateRestorationTest` covers both: the same graph for a recreation, a new
graph over the same database and keys for process death.

- Kept through both: the open screen (the nav back stack is saved), the
  chat's composer draft (the session composer's mirror is in the
  database), the chat list's scroll position, a compose chat's text (the
  new-session draft is stored) and the session it started
  (`rememberSaveable`), and an open composer or picker.
- Kept through a recreation only: Restore's QR request (a ViewModel), or
  its failure with Retry; a recreation never starts a new request.
- Lost, as in happy-app: pending chats (memory only), open alerts and
  confirmations, an in-flight Resume or Stop spinner, Restore's QR request
  after process death.

## Settings

`AppGraph.settings` (`SettingsRepository`) is the account's settings as
happy-app's `storage.settings` holds them: the stored server copy with
pending changes on top, parsed by `Settings.parse` (settingsParse: every
field of `SettingsSchema` with its default, unknown keys kept in `unknown`;
one field of the wrong type resets all known fields, as zod's `safeParse`
does). Read `settings.settings` (a `StateFlow<Settings>`); change with
`settings.change { it.copy(field = value) }`, which records the changed
top-level keys as pending and asks for a sync. Device-only preferences
(localSettings.ts) are `AppGraph.localSettings.values`, stored as one JSON
document in SharedPreferences.

What's New reads `res/raw/changelog.json`, a byte-for-byte copy of
happy-app's `sources/changelog/changelog.json`, with its images in
`res/drawable-nodpi/changelog_*`. When happy-app's changes, copy it over
(`ChangelogTest` fails until you do); a new image also needs an entry in
`Changelog.images`. `AppGraph.changelog` is the read marker Home's update
banner needs.

### Theme and what the platform draws

The theme setting (`localSettings.themePreference`) is the platform's
night mode too (`ui/theme/AppNightMode.kt`), so nothing platform-drawn
shows the system's theme under the app's (it used to flash white under a
dark app on a light phone):

- On API 31+, `UiModeManager.setApplicationNightMode`, which the system
  keeps for the package: the next start's splash and window are in the
  app's theme before any of our code runs. MainActivity handles uiMode, so
  a change repaints in place.
- MainActivity paints its window in the theme (`paintWindow`), before
  HappyApp's first frame and on every change.
- Every WebView is a `themedWebView`: the app's night mode for
  `prefers-color-scheme`, and the theme's colour until the page draws. The
  browser's WebView is see-through instead (WebView keeps the first
  background it is given) over the theme's colour, which turns white under
  a page that paints no background and asks for no dark one (`BARE_PAGE`).

A new WebView or window goes through these too. `AppNightModeTest` covers
dark on a light phone and light on a dark one. `tools/flashscan` records a
device and reports its brightest frames (`journey.sh`: a cold start and a
chat).

## Build and test

Run agent Android builds, unit tests and device checks on Kirill's Mac Mini
over SSH, syncing the sources first. The commands below run there; CI keeps
its configured Linux runner.

```
cd packages/happy-android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # app unit + Robolectric layout tests
./gradlew :crypto:test             # crypto, incl. vectors from happy-app's TS
./gradlew :analytics:testDebugUnitTest  # analytics, incl. the shared catalog's contract
```

Build types map to happy-app's variants and application ids: `debug` →
`com.slopus.happy.dev`, `preview` → `com.slopus.happy.preview`, `release` →
`com.ex3ndr.happy`. One more never ships: `bench` → `com.slopus.happy.bench`,
the release code debug-signed beside the others, with a fixture account
(`src/bench`). Cold start is measured on it (research/cold-start.md).

**Cold start.** The system doesn't compile a debuggable app on install, so
after `adb install` of the dev build run
`adb shell cmd package compile -m verify -f com.slopus.happy.dev` (cold
start 516 → 302 ms on the Fold). A new content provider or androidx.startup
initializer runs before the first frame and fails `ColdStartTest` until it
is listed there; prefer starting it where it is first needed (Firebase's
provider and ProfileInstaller's initializer are removed for that). Work
nothing on the first screen shows waits for `LocalAfterStart` (push
registration, notification channels), and glass blurs
from the window's second frame (`FirstFrame`). Keep
`HappyApplication.onCreate` to the debug StrictMode it has. The Baseline and
startup profiles (`app/src/main/generated/baselineProfiles`) come from
`benchmark/`'s generator; regenerate them after large UI changes, with only
the target device's serial:

```
ANDROID_SERIAL=<device> ./gradlew :app:generateBaselineProfile
ANDROID_SERIAL=<device> ./gradlew :benchmark:connectedBenchmarkBenchAndroidTest   # StartupBenchmark
```

### Versions and signing

- `versionName` is owned by `app/build.gradle.kts`. `HAPPY_VERSION_NAME` or
  `-Phappy.versionName` overrides it.
- `versionCode` is EAS's remote, auto-incremented build number
  (`eas.json` `appVersionSource: remote`). There is no counter in the repo:
  a store build passes the next number as `HAPPY_VERSION_CODE` or
  `-Phappy.versionCode`, above the last RN upload. Local builds get 1.
- Signing comes from the environment (`HAPPY_RELEASE_KEYSTORE`,
  `_KEYSTORE_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`, and the same with
  `HAPPY_PREVIEW_`) or a gitignored `keystore.properties`
  (`keystore.properties.example` lists the keys). Without them `release`
  builds unsigned and `preview` debug-signed, so `assembleRelease` works
  anywhere, CI included.
- PostHog's public project key comes from `EXPO_PUBLIC_POSTHOG_API_KEY` or
  `-Phappy.postHogKey`, as happy-app's and Happy Desktop's do; nothing is
  checked in. A build without it reads every feature flag as off and sends
  no events. Flags (`config/FeatureFlags.kt`): asked by the `:analytics`
  module alone, `POST /flags/?v=2` with the install id as the distinct id,
  each foreground, only from a build that sends analytics to PostHog and
  only while analytics may go; the answer is held in memory, and a failed
  ask keeps the last one. Events: see "Analytics".
- A signed release or preview build without an explicit versionCode fails in
  `pre<Variant>Build`, before R8, rather than at the Play console.
- Shipping goes through the `release` skill like every other release.
- CI: `.github/workflows/happy-android.yml` runs `assembleDebug
  assembleRelease testDebugUnitTest :crypto:test` on changes under
  `packages/happy-android/` and shared mobile resources. It has no signing secrets.

The JDK toolchain (21) is provisioned by the foojay resolver if the machine
only has a JRE. In the agent sandbox Gradle needs network and local sockets:
run it with full access and keep caches in the workspace, e.g.
`GRADLE_USER_HOME=$PWD/../../.context/gradle-home ./gradlew …`.

Crypto vectors (`crypto/src/test/resources/happy-ts-vectors.json`) and send
vectors (`app/src/test/resources/happy-ts-send-vectors.json`) are preserved
compatibility baselines captured from the former client. Their React Native
generators are retired. Historical source inputs remain in Git; protocol
changes must explicitly update these baselines against current producers.

## Analytics

The `:analytics` module (`analytics/`) sends the events
`docs/analytics-catalog.json` lists for Android (the contract shared with
Happy Desktop and happy-ios; never edit the copy, ask for a change to the
shared one). It knows none of the app's types: the app calls the
`Analytics` facade (`start` once in `AppGraph`, then `record`, `errorShown`,
`failureShown`) with the typed events, and maps its own reasons to the
catalog's sets in `app/…/analytics/` (`AnalyticsReasons`, `ChatAddress`,
`accountsOptedOut`). Deleting the module, that folder and the call sites
removes analytics; `docs/product-analytics.md` lists every line.

No PostHog SDK: it would add the device's name, screen and time zone.
`AnalyticsEvent` is the typed catalog (closed enums only; no text, id, name,
path or message has a field; a model goes as its `ModelFamily`, never its
id), `AnalyticsSchema` the send boundary's allowlist, which drops unknown
events and properties and any event holding a value outside its set;
`AnalyticsCatalogTest` holds both, and the family rule, to the JSON.
Versions are numbers only (`AnalyticsSchema.version` cuts a `-`/`+`
suffix). `AnalyticsClient` adds the common properties and PostHog's own
(`distinct_id`, a random install id, never an account's; `$insert_id`;
`$lib`; `$process_person_profile: false`; `$ip: null`;
`$geoip_disable: true`), keeps events in memory (500, 7 days) and posts
`/batch/` (`PostHog`, timestamps in whole seconds, no redirect followed,
an https host or a loopback one only) every 30 s in the foreground and as
the app goes behind. A failed batch goes again with the same `$insert_id`;
what a process held when it died is lost.

Nothing on the phone but the install id (and the switch) in `analytics`
prefs: the queue, `error_shown`'s throttle and the failure cards seen live
in memory. `Retired` deletes what earlier builds kept
(`noBackupFilesDir/analytics`, the day counts), and `AppGraph` the old
per-account `feature-flags` prefs. `app_crashed` reads only the reason,
importance and the crashed version of the system's last `ApplicationExitInfo`;
a process leaves its version with the system
(`setProcessStateSummary`) only while analytics is on, so a run with
analytics off is never reported, and the trace is never read.

Fewer events and more privacy: an event is only what no other event
answers. Nothing is counted on the phone, and no screen, view, navigation,
picker change, stop, approval or todo is sent; model and effort ride on
`message_sent`. Each event goes once its step worked (or failed, for the
`*_failed`/`_error` ones). The "fires" rules are `AnalyticsRules.kt`:
`error_shown`'s throttle, `chat_failure_shown`'s fresh-and-unseen check,
`agent_connection_lost`'s incidents, `app_opened`'s cold and warm opens.
`message_sent` goes as the person sends (queued only, too), with the mode
then, and never again on a retry; a create that fails is only its
`task_created`/`bot_created`, not also the send's `error_shown`. A failure
card's `chat_failure_shown` and a failed Happy CLI send's `error_shown`
(`Analytics.errorSeen`, with the `SendFailure` its row carries, once per
row and opt-in) go once the card or row is seen (`Modifier.onSeen`: half on screen, the page
resumed, no overlay up, as a `PageDialog` leaves the page resumed). A call
is reported only if analytics was on from its start to its end
(`Analytics.span`).

Only release and preview builds with a key send, never debug, bench, a test
harness, an instrumented run or Robolectric (`AnalyticsTarget`). Consent is
this phone's switch (Data and Storage › Analytics, `AnalyticsSwitch`; a
stored value that can't be read is off) and every Happy account signed in
here allowing it (`accountsOptedOut`: the open account's setting as it is
now, the others from their own databases; settings that can't be read, or
an `analyticsOptOut` that isn't a boolean, are opted out, a missing one is
not). Nothing is recorded until both are read. Analytics is on in one
generation at a time: either switch turned off calls `Analytics.revoke()`
at once, outside every flow, which ends the generation, cancels the
requests on their way, and deletes the queue, the throttle, the cards seen,
the crash mark, the flags and the install id on the client's lane without
waiting for them. Every record, error, exposure, incident, open, flag
answer and send checks the generation it was made in, and consent as it
is then. It stays off until the setting reads as off or is turned back on
(`Analytics.allow()`); on again starts a new install id. While the old
install id can't be deleted, analytics stays off and `allow()` refuses
either switch going back on, which then isn't written down, so a restart
can't bring that id back. PostHog's `/flags` is asked only by the module, with the install id,
under the same consent; `FeatureFlags` holds the answer in memory for the
migration card. If either switch can't be written down, its screen says
so. Each account's switch on the Account screen toggles from its switch
only, not its title, like the app's other switch rows.

To see the payloads, a debug build sends to a local endpoint only:
`adb reverse tcp:8787 tcp:8787` to a listener, then
`adb shell setprop debug.happy.analytics_host http://127.0.0.1:8787` and a
cold start.

## Onboarding and connect

Entry points other screens call (all in `ui/onboarding` and `ui/connect`):

- **Home, no computer linked** (`resolveHomeEmptyState` = link):
  `OnboardingLinkComputer(graph, onSettings = { nav.navigate(OnboardingSettingsRoute) })`.
  **Every computer offline**: `LinkComputerChecklist(graph, computers = choices.map { it.name },
  onTroubleshoot = { nav.navigate(TroubleshootRoute) }, onShowArchived = …)`.
- **Troubleshoot's machine rows**: `onboardingRoutes(graph, nav, onOpenMachine = { id -> … })`
  in HappyApp; pass the machine screen's navigation.
- **Settings › "Scan QR code to authenticate" / "Enter URL manually"**
  (wired in `settingsRoutes`): `val connect = rememberTerminalConnect(graph)`;
  the scan row calls `connect.scan()` and shows `loading = connect.isLoading`;
  the URL row shows `EnterTerminalUrlPrompt(connect, onDismiss = …)` while open.
- **Settings › Account › Link New Device**: `val link = rememberAccountLink(graph)`;
  the row calls `link.scan()`, subtitle `common_scanning` and disabled while
  `link.isLoading`. Both flows show their own alerts while composed.
- **Deep links**: MainActivity offers every launching and new intent to
  `DeepLinks.offer(intent)`; `DeepLinkEffect(nav, signedIn, onOpenSession)`
  in HappyApp opens them once signed in. `onOpenSession` is the chat's.

### Migration card

The Happy CLI home leads with `ui/migration`'s card (iOS ea1a0902f) only
while PostHog's `direct-connection-migration-note` is on for the account
(`AppGraph.migrationNote`), no agent connection is paired, and its × wasn't
pressed. Its screen's Scan QR code is `rememberMigrationScan`, not Add: a
direct code pairs, and a Happy server code first says it isn't direct, then
Link anyway approves it for the open account as Settings' scan does, never
creating an account.

### QR codes

Deliberately not happy-app's (expo-camera's `launchScanner`, which is
Google Code Scanner on Android): we scan in our own screen, so it works
without Play services. Everything goes through the `QrScanner` interface
(one call, decoded text out; `LocalQrScanner`, `rememberQrScanner()`), so
the flows are tested with a fake.

- `CameraQrScanner` starts `QrScannerActivity` for a result
  (`QrScannerActivity.Contract`). A phone without a camera returns
  `Failed` at once, and the flows ask for the link instead.
- The activity asks for CAMERA when it opens (the manifest declares it,
  and `android.hardware.camera` as not required). Refused, the screen says
  so (`modals_camera_permissions_required_to_scan_qr`) with Open Settings;
  returning with it granted starts the camera.
- CameraX (`camera-camera2`, `camera-lifecycle`, `camera-compose`'s
  `CameraXViewfinder`): a preview plus an `ImageAnalysis` (~720p, latest
  frame only) whose `QrAnalyzer` feeds the Y plane to ZXing (`QrDecoder`,
  QR only, inverted codes too). The first decoded text finishes the
  activity, with a confirm haptic.
- `QrScannerScreen`, always dark: Steve's exception to rule 5, no header;
  the camera fills the window under transparent system bars, a floating ✕
  top right (= back), a scrim with a centred square viewfinder, a hint
  under it, and a torch toggle when the camera has a flash. Close and
  system back return `Cancelled`. Add's scan (`ScanRequest`) also has a ⋮
  top left with the other ways in (iOS's `AccountAdding.otherWays`): enter
  a link, Restore Happy CLI account, Happy CLI server; a pick returns
  `ScanResult.Chose`.
- As iOS's ff88dfcd6: the preview and analysis follow the display's
  rotation (a display listener, since the activity handles rotation and a
  180° turn reports no configuration change), and a camera whose nearest
  focus is farther than a 30 mm code filling the viewfinder is zoomed
  until it is in focus, at most 3x (`ScanFocus`, Camera2's minimum focus
  distance and field of view).
- `QrDecoderTest` decodes ZXing-encoded luminance frames; `QrScannerTest`
  covers the result contract, the refused permission and the layout.

The restore screen draws its code with ZXing's encoder (`zxing-core`, no
Android or camera parts), in QRCode.tsx's rounded style; `QrCodeTest`
decodes the drawn pixels back to the link.

### Deep links

`happy://` links route as expo-router routes them for happy-app (the host
is the first path segment; Happy Agent's own hosts and instance-locked links
are not app paths, see "Team servers behind SSO"), and so do `https://app.happy.engineering/<path>`
links. Every app path maps to its Compose route (`parseDeepLink` in
`ui/connect/DeepLinks.kt`): `terminal?<key>` opens the confirm screen,
`/terminal/connect` explains that the web link needs a browser,
`/session/<id>` goes to `onOpenSession`, and `/session/<id>/info|changes|
file?path=<btoa>|message/<mid>`, `/machine/<id>`, `/new`, `/settings/*`,
`/server`, `/restore[/manual]`, `/troubleshoot`, `/changelog` and
`/onboarding/settings` open their screens. Paths with no Android screen
(excluded features, `session/recent`, the files browser) open Home. The
release build adds app.config.js's production intent filter for
`https://app.happy.engineering` (`src/release/AndroidManifest.xml`), with
`autoVerify`. The site's `assetlinks.json` (happy-app's
`public/.well-known/assetlinks.json`) already lists `com.ex3ndr.happy` with
one fingerprint, presumably Play's app-signing key that the React Native app
verifies with, so a Play-distributed build should verify as it does; a build
signed with only the upload key won't. Signed out, only the screens that need
no account (server, restore, troubleshoot, changelog, onboarding settings)
open; other links are dropped rather than pushed onto empty signed-in screens.

### Team servers behind SSO (edge SSO)

A Happy Agent server behind an HTTPS load balancer that enforces SSO is an
`AgentConnection` with `server` (its origin) and `AgentConnectionCredentials.oauth`
instead of a device token. The contract is shared with iOS and desktop; don't
change its wire behaviour on Android alone.

- **Adding one: by QR code only** (§8, Steve's decision; `connection/ServerInvite.kt`).
  A phone never takes a typed or pasted server address: there is no address
  field or menu item. Desktop shows `happy://<instanceId>/server?url=<percent-encoded
  base URL>`, no secret in it; any of the app's scanners reads it
  (`HappyCode.Server`, by shape, so a malformed one is refused as one).
  `ServerInvite.parse` takes the grammar exactly (normalized `https:` base URL,
  nothing else in the link, at most 4,096 characters) and repairs nothing.
  Pasted into "Enter link manually", from the OS, or in a conversation it does
  nothing (it isn't a `HappyUrls` link). A connection already on that
  `instanceId` just opens; otherwise a base URL under a path prefix stops with
  "…can't connect to yet" (the transport is origin-only), and an origin starts
  the sign-in below. After the token exchange, health's `instanceId` must equal
  the code's (`ServerSignInFlow.verify`; a new member's health behind the
  profile gate is checked after the name); a mismatch, or none, drops the
  credential and reads "This code doesn't match the server it points to."
- **Happy Cloud, the one exception** (accounts contract v1;
  `connection/HappyCloud.kt`, `connection/CloudAccount.kt`,
  `ui/connection/CloudConnect.kt`, `CloudScreens.kt`): the accounts service
  is its own origin, `BuildConfig.HAPPY_CLOUD_ACCOUNTS`
  (`https://auth.happy.engineering`; `HAPPY_CLOUD_ACCOUNTS` or
  `-Phappy.cloudAccounts` points a build elsewhere), and servers live under
  one domain, `BuildConfig.HAPPY_CLOUD_BASE` (`HAPPY_CLOUD_BASE` or
  `-Phappy.cloudBase`): the server named `acme` is `https://acme.BASE`.
  Only `debug` and `preview` builds offer it (`HappyCloud.offeredIn`, by
  `BuildConfig.BUILD_TYPE`); `release` and `bench` have no way in at all.
  The account menu's last row, a + reading "Connect to Happy Cloud" (with no
  account yet, the first screen's ⋮ and Add's scanner ⋮, `ScannerWay.Cloud`),
  opens a full-screen welcome (no dialog); its Connect opens the
  **account** sign-in in a Custom Tab: PKCE against the accounts origin's
  `/authorize` and `/token`, `client_id` `happy`, `resource` the accounts
  origin, nothing discovered (the page offers Apple for now). The account
  token is a pass of about an hour with no refresh (token lifetimes v4): held
  in memory only, never stored, never refreshed, and only ever sent to the
  accounts API. Past its hour (two minutes' margin), or on any 401 from the
  accounts API, the account is signed out with nothing retried, and the +
  opens on the welcome saying the hour is up (`CloudAccountState.SignedOut`
  `expired`). Signed in, the + skips the welcome and shows the picker: "Your servers" (`GET /v1/servers`, the ones on
  the phone checked; each titled by its `displayName` over `@name`, with its
  picture: the ThumbHash painted first, then the bytes from its `url`, which
  `CloudAccount.image` fetches with the account token only from the accounts
  origin; no picture, the generated avatar its connection will have), "Create a new server" (a name typed after an `@`,
  checked with `GET /v1/servers/availability` as the person pauses, then
  `POST /v1/servers`) and "Join a server" (name and invite code, `POST
  /v1/servers/join`). Picking, creating or joining one signs in to it with no
  browser: `POST /v1/servers/:id/token` with the account token
  (`CloudAccount.serverToken`, `ServerSignInFlow.startWith`) gives the server's
  access and refresh tokens, its `aud` checked as any; then as the sign-in
  below (checked with the server, a name if new, kept). That server token is
  the long-lived session: refreshed at the accounts origin's `/token` with the
  `refresh_token` grant, `resource` the server, and no account token, so a
  server stays signed in long after the account's hour. Signing in
  again on a cloud server does the same while the account is signed in; signed
  out of it, the server's own browser sign-in opens by itself. Each server is its own connection; one already here
  just opens. The addresses are the app's own, never typed or pasted, so no
  code and no `instanceId` check them.
  Every Happy Cloud screen (welcome, Your servers, Create, Join, and the
  server sign-in, which reads "Connecting to @name…") is full screen on the
  first screen's Grain Gradient (`StartSpec` palettes, onboarding's 28/34
  title, a scene above it) with one primary action at the bottom
  (`CloudScreens.kt`, `CloudFrame`); servers are cards on it.
  People read a cloud server's address as `@name`, like a username, until
  Happy Cloud has its own domain (`HappyCloud.handle`: the picker, create,
  join, the server sign-in screen, the account menu); the URL is used as
  before, only not shown. Connection diagnostics keep the real host.
- **Sign-in** (`connection/ServerSignInFlow.kt`, `ServerAuth.kt`): `GET
  /v0/authentication` lists the methods, then OAuth authorization code + PKCE
  S256 in a Custom Tab (never a WebView), with RFC 8707 `resource` on
  authorize, exchange and refresh. The redirect URI is **`happy://oauth/callback`**
  on every flavor (`ServerSignInFlow.REDIRECT_URI`); the manifest's `happy`
  scheme filter carries it, and MainActivity hands it to the flow before
  `DeepLinks`. `authenticated` with no `userId` asks for a name (`PATCH
  /v0/profile`) before the server is kept. A malformed callback (any app can
  send the redirect URI) is ignored, never thrown.
- **Binding the sign-in** (API.md, Steve-approved): a method whose `tokenUrl`
  or `refreshUrl` isn't on `authorizationUrl`'s origin (parsed scheme, host,
  port) is refused before the browser (`OAuthMethod.oneSite`, "…would send your
  sign-in to a different site…"). The attempt (`PendingOAuth`) keeps the origin
  and the method as found; the credential keeps `refreshUrl`, `client_id`,
  `resource`; nothing is re-read from the server. After the exchange and every
  refresh the access token's JWT `aud` (string or array, signature not
  checked) must name the server: same origin, path `/` with a trailing slash
  added (`ServerAuthClient.audienceIs`); otherwise it is dropped unused ("This
  sign-in is for a different server."). Token requests never follow redirects.
- **One member per connection** (as iOS: origin + `userId`): the `userId` is
  kept with the credential and on the `AgentConnection`. The same member
  signing in again renews their connection; another member gets a new one,
  and the connection they signed in again on is wiped (credentials, entry,
  caches: `AgentSessions` deletes the caches of any connection that goes, open
  or not, and sweeps orphans at start) and theirs opens. The server is asked
  who it is first and the new credential saved next; only then is the list
  replaced in one write and the old member's let go, so a cancelled or failed
  sign-in leaves the old connection whole. Each sign-in has a generation
  (`AgentConnections.grant`): a refresh of an older one that lands after a
  sign-in is dropped and its refusal hands back the new token instead of an
  auth failure; requests sign out only the generation they were made under
  (`signedOut(…, grant)`), checked and written under one hold of the lock.
- **Storage**: credentials are sealed by an AES-256-GCM Android Keystore key
  (non-exportable, no user authentication, StrongBox when the phone has one,
  else the TEE: `AndroidKeyStoreKeys`) in app-private preferences, which
  `data_extraction_rules.xml` / `backup_rules.xml` keep out of cloud backup and
  device transfer (`CredentialStorageTest`). A team server whose key is gone
  (restored or moved) reads as signed out.
- **Tokens**: the refresh token lives with the credentials (Keystore,
  `ExpoSecureStore`); access tokens are in memory only (`AgentConnections.bearer`,
  refreshed 60 s before expiry, one refresh at a time per connection, rotation
  persisted). The refresh token goes only to the `refreshUrl` and `client_id`
  recorded at sign-in. Credentials go only in `Authorization`, on SSE and
  WebSockets too; no OkHttp client here follows redirects.
- **Sign in again** (`SignInRule`): any 3xx but 304, any 401, or a 403 that
  isn't Happy JSON (`application/json` with string `error` and `code`). A
  Happy-JSON 401 first asks `GET /v0/authentication` with the same bearer
  (`AgentClient.recover`); an edge's 401 stands. `AgentConnection.signInRequired`
  stops the account's links at once (`AgentSession`) and home shows "Sign in
  again", which reopens the flow replacing the same connection (and checks
  the `instanceId` it had). Paired agents
  keep 401 = Revoked.
- **Tunnels**: over HTTPS, the in-app browser prefers the WebSocket twin of a
  CONNECT route (`<route>/websocket`, `WebSocketTunnel`) when health reports
  `capabilities.webSocketTunnels`; otherwise CONNECT once, and an edge's refusal
  turns tunnels off for that client with a note (`browser_tunnels_blocked`).
- **No device management.** There are no Android Enterprise managed
  configurations (Steve's decision). Tailcat, the hosted relay and pairing by
  code are switched on the server (`happy.toml`); the app only hides what the
  agent reports as off. Analytics is always the person's own choice. A pairing
  the agent refuses with `unsupported` (or an older daemon's 404) reads "Phone
  pairing is turned off on this agent." (`AgentConnectionException.Reason.Disabled`).
- **Instance-locked links** (§7, `agent/HappyUrls.kt`, `ui/connection/HappyLinks.kt`):
  `HappyUrls` ports happy-agent-client's `happyLinks.ts` grammar case for case
  (`HappyUrlsTest`) plus the external form `happy://<instanceId>/<internal URL
  without happy://>`. Health's `instanceId` is kept on each `AgentConnection`.
  From outside (`DeepLinks`), only an external link opens, and only on the
  connection with that `instanceId` (switching to it first, through
  `DeepLink.OnConnection`, since each account has its own back stack); none
  matching says "This link belongs to a Happy server you're not connected to."
  and never falls back. Internal Happy links and `happy-file://` from outside,
  and malformed ones, open nothing. Inside an artifact a Happy link means that
  connection; `openOutside` never hands a Happy URL to the system. Sharing a
  bundled artifact's page shares its external link, and isn't offered when the
  server has no `instanceId`. Chat doesn't render `happy://` links as links yet.

## Push

What happy-app does with expo-notifications, without Expo:

- **Token.** FCM token → Expo push token, exactly as expo-notifications
  55's getExpoPushTokenAsync: `POST https://exp.host/--/api/v2/push/getExpoPushToken`,
  only `content-type: application/json`, body
  `{type:"fcm",deviceId,development:false,appId,deviceToken,projectId}` in
  that key order (`ExpoPushTokenClient`). `deviceId` is expo's
  InstallationId, read from the same no-backup file (and legacy places), so
  an upgrade from the React Native build keeps its device id. The project
  id is app.config.js's `extra.eas.projectId`. happy-server only knows Expo
  tokens and sends through Expo, so this exchange is not optional.
- **Registration** (`PushRegistrar`, pushRegistration.ts): register with
  `POST /v1/push-tokens`, remember it, drop the previously registered token
  if it changed; all happy-server calls retry like apiPush.ts's `backoff`.
  `PushRegistrationEffect` in HappyApp runs it on sign-in and every return
  to the foreground. It shows the POST_NOTIFICATIONS prompt only while the
  system would still show it, never opens settings by itself, and forgets
  the registration on sign-out. `HappyMessagingService.onNewToken`
  re-registers a rotated FCM token.
- **Showing.** Expo relays a push as an FCM data message (`title`,
  `message`, `body` = the data as JSON, `channelId`); `presentPush` shows it
  on its channel, silent while the app is in the foreground. Channels are
  `_layout.tsx`'s: `default` (max) and `messages` (high, what happy-server
  uses), vibration 0/250/250/250, light #FF231F7C.
- **Tapping** opens MainActivity with `ACTION_OPEN_PUSH` and the session id
  from notificationRouting.ts's rules (a `/session/<id>` url, else
  `sessionId`); `DeepLinks.offer` turns it into `DeepLink.Session`, which
  `DeepLinkEffect` hands to `onOpenSession` (the chat's).
- **Background sends** (sync.ts's watchdog notifications,
  `push/BackgroundSendNotifications.kt`): MessageSender's watchdog fails
  rows unsent 30 s into the background; this observer of the store's
  outbox and `AppGraph.isForeground` schedules "Message not sent" with an
  inexact AlarmManager alarm (`BackgroundSendReceiver`) when the app leaves
  with unsent rows, cancels it on return or once they are sent, and posts
  "Message failed" when rows fail with `MessageSender.BACKGROUND_FAILURE`.
  Both go on the `default` channel and open the app.
- **Settings › Account's push rows** use `rememberPushRegistration(graph)`,
  Settings' `PushRegistration` over the same registrar and permission
  (pushRegistration.ts's getPushPermissionInfo,
  requestPushPermissionOrOpenSettings, getCurrentExpoPushToken,
  syncCurrentPushToken, removePushToken).

**Firebase is optional at build time.** There is no google-services
plugin: `app/build.gradle.kts` reads `app/google-services.json` and
generates the plugin's resources for the client matching each variant's
application id. Without a file or a matching client the app builds and runs
and push reports unsupported (no prompt, nothing registered). Firebase
doesn't start with the process: the manifest removes FirebaseInitProvider,
and `push/FirebaseStart.kt` starts it where push needs it, off the main
thread from registration (after the first frame) and in
`HappyMessagingService.onCreate` for a push that wakes a killed process
(`FirebaseStartTest`). Anything new that touches FirebaseMessaging calls
`FirebaseStart.ensure` first. Pushes arrive only if:

- the file has clients for `com.ex3ndr.happy`, `com.slopus.happy.preview`
  and `com.slopus.happy.dev` (happy-app's has all three);
- the Expo project above has that Firebase project's FCM V1 service
  account key (happy-app's Android pushes already depend on it; a
  different Firebase project needs its key uploaded to Expo);
- the device has Play services (otherwise unsupported, as FCM has no
  token there).

## Purchases

No RevenueCat SDK: Play Billing plus RevenueCat's REST API with the public
Google key (`EXPO_PUBLIC_REVENUE_CAT_GOOGLE` or `-Phappy.revenueCatGoogleKey`;
empty means nothing is sold and nothing calls RevenueCat). The legacy SDK and
its paywall dialog are gone; their old caches (`purchases` preferences, the
SDK's own) stay on disk, unread.

- `AppGraph.subscription` (`Subscription`) is the one purchase-state owner:
  the customer (the install's own anonymous id, kept on the phone; no Happy
  account, sign-in or analytics id ever touches it), `pro`, what is on sale (`offer`:
  the current offering's monthly package only), buy, the launch/foreground
  sweep of unfinished purchases and Restore. `pro` comes from the last
  RevenueCat answer (`ProPass`, cached 24 h), never from the offering, and
  honours any product granting `pro` (older annual or lifetime too).
- A purchase belongs to whoever it was bought for: Play's
  `obfuscatedAccountId` is the customer id itself, so every phone on the
  Google account reads it. At launch and foreground an active subscription
  naming a customer makes it the install's (`adopt`, no restore). Only a
  user's Restore moves one to another customer (`restored`), except the one
  restore a new version makes of a subscription that names no one
  (`migrate`, once, only without `pro`).
- `AppGraph.offers` (`Offers`) is the one offer presenter, drawn by the one
  `OfferHost` in `HappyApp`: voice's welcome and used-up sheets and the relay
  voice's Required sheet (`voice_must_pay`, unreachable while that voice is
  off). One sheet at a time; `ask` answers Start (the welcome's only), Pro
  or Dismissed. Support Happy is a pushed page, not a sheet (`SupportRoute`,
  `SupportScreen`; a Happy account's Support us and an agent connection's
  boba row, which is that page's only Support us): "Pledge <price>/month"
  over Subscribe, always there and greyed out while nothing is on sale,
  then Restore Purchases and Manage subscriptions as quiet links.
- Grants are client-side. The server checks no subscription; its 5-hour
  hard cap on every account's voice is a cost safety net, never sold, only
  said.
- Debug builds treat About's Support row as Pro, as RN does; that grants no
  voice.

See `docs/agent-voice-call.md` at the repository root for the month rule,
grace and identity.

## Voice

`AppGraph.voice` owns one `VoiceEngine`, switched off for now (see the top).
When on, it requests microphone permission
before allocating a server conversation, applies server denial/paywall rules,
and connects the ElevenLabs transport. `AppGraph.subscription` provides real Pro
state and `AppGraph.offers` the sheets (`VoicePaywall`); debug-only Support us
behavior does not grant voice Pro.
Usage and credentials re-authenticate with the account secret when voice uses
a different server. Voice language codes come from `VoiceLanguages`.

`StoreVoiceContext` forwards normalized messages, permission prompts, ready
events and focused-session context. Histories load lazily with a 50-row cap;
events arriving during SDK connection are buffered. Client tools validate
their parameters and use the existing sender/permission RPCs for the bound
account. Logout, failed start and stop invalidate callbacks and close the call.

`vendor/elevenlabs/UPSTREAM.md` records the pinned MIT source archive and the
audio lifecycle patch. LiveKit owns audio focus and device routing; call mute
never changes global microphone mute. Room cleanup completes logically before
stop returns, and LiveKit's audio thread releases OS focus asynchronously.
Verify focus, recording and communication mode on a device after changes.
`testDebugUnitTest` includes the SDK's lifecycle tests as well as app tests.

## New files in diffs

A new file is drawn as the file, as desktop draws a created one: syntax
colour and line numbers, no `+` markers, tint or `@@` bars
(`DiffFileBody.listing`), under a NEW +N header. A Write's card and screen
name the file in their title bar, so NEW +N ends that bar
(`NewFileBadge`) and there is no second header. Whether a file is new comes
from what the caller knows (git status, a `file_diff` or Codex `add`, a
Write) and is passed in. It is never read off the rows: an empty file that
gained lines is all additions too, and git calls it modified.

## Attachments and images

- **Transfer** (`attachments/`): apiAttachments.ts over OkHttp. Local
  storage is PUT/GET back to the server with the bearer token (only when
  the URL is the server's); S3 is a presigned multipart POST (policy
  fields, then `file`) and a presigned GET with no Happy headers. Every
  failure is an `AttachmentDiagnosticError` whose message and diagnostic
  went through attachmentDiagnostics.ts's redaction, so they can be logged.
- **Crypto**: blobs are `encryptBlob` (secretbox, nonce || box) under the
  session's blob key, `deriveKey(dataKey, "Happy Blobs", ["session"])`
  (`SessionBlobKeys`, from the stored wrapped data key).
- **Sending**: the composer's images are normalized at pick time (upright,
  long edge ≤ 3072, JPEG 0.92, `<stem>.jpg`, ≤ 10 MB − 40 so the encrypted
  blob fits), uploaded on send (`prepareAttachmentSend`: flavor and rig
  policy, then upload; a failed image is counted, not fatal), and handed to
  `ChatActions.send(..., attachments = fileEventRecords(uploaded))`, which
  queues sync.ts's `file` session events ahead of the text.
- **Picking**: the add button and the conversation's [+] open the
  attachment sheet (`ui/attach/`), Telegram's ChatAttachAlert ported with
  its numbers (`research/attachment-menu.md`, pinned by `AttachSpecTest`):
  a gallery of recent photos and videos read from MediaStore
  (`attachments/MediaGallery`, so the app asks READ_MEDIA_IMAGES/VIDEO as
  the sheet opens; Android 14's partial access lists what was chosen and
  offers Manage), numbered multi-select, a caption that is the draft, and a
  File tab (Browse through the system picker, the system photo picker as
  files, Paste, and the files sent from here before, `RecentFiles`). Picks
  are copied into the cache on Send (`AttachmentStaging`: photos normalized
  as below, the rest as they are). What a chat offers is `AttachAccepts`:
  a Happy Agent conversation takes photos, videos and files (pictures
  inline, the rest written into the agent's workspace first,
  `conversation/WorkspaceUploads`, as iOS does); a relay session takes
  pictures only, since happy-cli reads only images from `file` events,
  unless a rig v1 policy lists more. No thumbhash on Android, as on
  happy-app native.
- **Showing**: `file` tool rows render `FileMessageView`, which downloads
  and decrypts on demand through `AttachmentTransfers` (50-entry LRU of
  decrypted blobs, one download per ref).

### Conversation media and the viewer

An agent connection's conversation lays pictures out with
`conversation/MediaFlow` (iOS's `MediaFlow` and `MediaLayout`): pictures
flow together, recordings follow each at its own box (≤ 380 × 320, never
enlarged), and a person's message shows at most four photos, the fourth
reading "+N". A recording's tile is its first frame, or its thumbhash
first, under a play circle with its length in a pill. The frame and length come from
`artifacts/VideoProbe` over a `RangedSource` on the tool-call media route
with `Range`, held per screen by `ConversationMediaStore`.

One viewer, `ui/conversation/PictureViewer` (iOS's `PictureViewController`),
serves the conversation and artifacts (`ArtifactViewer` is an adapter). It
pages through every picture and recording of the conversation, oldest
first (`ConversationViewing.entries`). A picture rests at its own size,
fitted to the safe area and never enlarged (`PictureViewing.fitted`).
Which gesture wins is `PictureViewing.decide`: zoomed pans, a whole picture
pages across and is dragged away up or down. A recording plays in its page
(`VideoPage`). The position reads "N of M" for TalkBack only, as iOS has it
for VoiceOver (`message.mediaPosition` in happy-app's catalogs).

A picture opens out of its thumbnail and closes back into it, as
Telegram's PhotoViewer does. A thumbnail that opens the viewer carries
`Modifier.viewerOrigin(key, radius)`, keyed as the viewer keys the item
(a chat tile by its cache key, an artifact file by
`ArtifactMedia.resourceId`). It says where it is on the screen in
`ViewerOrigins.Shared` and draws nothing while it is `hidden`. The viewer
lays the picture out at rest and scales, moves and clips it there
(`PictureViewing.flight`), so it starts from Coil's memory copy of the
thumbnail (`rememberMemoryImage`). It hides the thumbnail only once its
dialog window has focus. It closes into the thumbnail if that is on the
screen, by tap, back or a drag, and otherwise fades. Then it waits for the
thumbnail to draw again (`ViewerOrigins.drawn`) before it goes, so there
is no hole. A recording neither flies nor hides its tile.

A tap on a kept recording's play button plays it as soon as its first
playable range is on the phone (iOS 42121e99e, `VideoOpening`). The
retriever reads the header through the same ranged source the player
reads. Until then the play glyph is a small spinner (`MediaRingState.Starting`:
0.7 of a circle, a fifth of the disc across, turning every 0.8 s), and the
rest of the file reads on behind. A second tap while it spins gives up.
This applies to the chat's tiles and the agent page's grid.

### Conversation turns

Each run of a Happy Agent conversation is a turn, drawn as desktop draws it
(iOS 7f6355041). A tool call is one line in plain words:
`ui/conversation/ToolWords` ports desktop's `toolVerb` / `humanizeToolName`
/ `toolGlyph`, so it reads "Shell ls", "Edit x.ts +3 −1" or "Explored a.ts",
in the present tense while the call runs. `ui/chat/ToolView` is not used
here. Once a run has `endedAt`, `Conversation.derive` adds a
`ConversationRow.TurnEnd` ("Completed in 12s", which also copies the final
answer, so that answer has no copy button of its own). `conversation/TurnFold`
then folds the turn behind a `Trace` row ("View traces · N tools"). Folded,
the turn keeps the person's words, the answer, file edits, media, artifacts
and failures. `Conversation.toggleTurn` opens or folds it, and
`FoldHold` in ConversationScreen keeps the trace row where it was on screen.
Words are in `strings_turns.xml`.

A tap on a tool line opens the call (`ToolCallRoute`, `ToolCallScreen`;
iOS ToolDetailViewController, 1575b41b8). It is titled with the line's
subject, under a header card (kind, tool name, status pill), then what the
call did from its `presentation`: a command in the terminal panel
(`CommandView`), an edit as each file's diff drawn from the hunks as sent
(`ToolPatch` builds a patch for DiffFilesList; each file opens alone with
`file` set), a look around as its steps, a search with its sources. A call
without one is read from its vendor's arguments (`conversation/ToolCalls`:
`ToolKind`, `ToolPlan`, `ToolSubagent`, `ToolMessage`) and otherwise shown
as fields (`ToolValue`: priority keys first, long strings as blocks,
nested past depth 2 as JSON). Then the review, if the call crossed it, and
the raw JSON, folded. The chat's copy may lack the raw data (history read
with `omitToolData`) or have it cut at 32 KB (`ToolData`); `ToolCallModel`
then reads that run once more whole (`ToolCallReader`). Words are in
`strings_tool_detail.xml`. The agent page's "Changes" row opens the
workspace's own Git changes (`WorkspaceChangesRoute`, `WorkspaceGit` over
`/v0/workspaces/:id/git`, `file-revision` and `file`); five files or fewer
open whole.

A person's message shows whole; only a ludicrous paste, past seventy
lines of its own text whatever the screen, folds the same way (`UserFold`
in ProseViews; iOS c52fd2842, 3928f0f21). `Prose.cut` counts the laid-out
lines, so the cut is decided while composing and not after measuring. Code
and tables count their own lines. The bubble shows the lines up to the
seventieth line's foot, then "Show full". If that line is inside code, the
cut falls at seventy lines of text height. A tap on the bubble calls `Conversation.toggleMessage`
and flips `ConversationRow.User.opened`. `FoldHold` keeps the row above the
message in place, so the bubble opens downward.

Code in a Happy Agent chat works as on desktop (3365ef9f, 3e08585d).
ConversationScreen provides `LocalCodeCopy` = `CodeCopy.Icon`, so
MarkdownView's code block shows a quiet 14 copy glyph in a 24 box, 6 in
from its corner, which turns into a check for 1.6 s. The relay chat keeps
its "Copy" pill. `proseSpans` marks inline code with `INLINE_CODE`. A long
press on that code selects the whole span, both in place (`SelectionStart`)
and in the lift's Select (`LiftSelection`).

A held message lifts over the chat (MessageLift). Only the header and the
transcript blur (`liftBackdrop`). The veil stops at the composer's top
(`liftClear` sets `MessageLift.clear`), so the input stays sharp and
undimmed. The lifted message and its menu keep 10 above the composer. The
light veil is white at 0.6, so the chat reads frosted white, not grey; the
dark veil is black at 0.6. A card's shadow (8% black, 12 blur) and the
menu's 4 elevation part white from white without shading the composer.

A conversation that finishes chimes as on desktop (a72f8304, 962201a2).
`AgentSession.follow` asks `CompletionWatch` about each journal event. It
chimes for a `run.finished` of a top-level conversation that home lists,
for its current run, ended within 30 s (so a replay after reconnecting
stays quiet), unless the connection's `happy-desktop.completionSound` is
"never" or the bot is muted or hidden (`happy-desktop.bot.<id>`).
`CompletionChime` renders desktop's two sines (659.25 Hz, then 880 Hz at
0.11 s; 15 ms attack, decay to 0.42 s) as a sonification AudioTrack and
stays silent unless the ringer is normal. The link only runs while the
connection is open and the app is in the foreground, so on the phone
When focused and Always chime alike. Appearance shows the setting.

The composers' primary button is one button that changes its glyph
(`PrimaryGlyph`, iOS `AgentInputPrimaryGlyphMotion`). The glyph going away
shrinks to 0.5 and fades while the new one grows in, over 0.2 s; Reduce
Motion keeps only the fade. The relay chat's fill changes over the same
0.2 s. A stop that fails shakes the button in both chats (Shaker.tsx). The
Happy Agent field's placeholder is iOS's "Type a message ..."
(`session_input_placeholder`).

Composer pictures come and go as on iOS 8eed293c9 (`PictureStripMotion`):
one added grows from 0.2 and fades in, one taken out shrinks to 0.2 and fades
where it was while the rest slide, over 0.4 s on the (0.38, 0.7, 0.125, 1)
curve. Both strips use it (the Happy Agent composer's and `AttachmentStrip`).
A lazy row never redraws an item it is taking out, so `PictureStripFrame`
draws the leaving picture itself, under the row at its last place. The strip
records a picture as leaving during composition, so it shows in the same
frame the row drops it. The picker hands over its own list, which it changes
in place, so the strip keeps a copy to compare against. The last picture
keeps the strip open until it has gone. Pictures already there when the
composer is made arrive without animating.

On a phone held upright, the attach sheet grows out of the + and goes back
into it (`AttachMorph`, iOS `morphIn`/`morphOut` from 8eed293c9 and da11ed4af).
The composer marks its + with `Modifier.attachButton(rememberAttachButton {
glyph })` and passes it to `AttachSheet`. When the morph takes the +, it hides
the button and draws the glyph on the morph, and gives the button back only
once the sheet has gone. The sheet is clipped to a rounded rect that runs from
the button to the sheet: the centre on one spring, the size on another, and
the corners over 0.2 s. The page and the sheet's ground fade in over 0.2 s,
and the glyph fades out over 0.15 s. On the way back the page fades out over
0.12 s, the glyph returns over 0.22 s, and the ground goes last, so the +
alone lands on the button. iOS gives its springs as damping plus duration;
these use the same damping ratio, at the stiffness that settles in that
duration. Tablets, landscape and Reduce Motion slide the sheet up as before.

A Happy Agent picture on its way to the computer wears Telegram's ring in the
bubble (`UploadRing`, iOS 5ac4296c2). The tile is dimmed, with a dark disc
and a white arc for the share written; the arc turns while it fills. Its cross
takes that picture out (`Conversation.removePicture`, iOS `removeAttachment`):
the write in flight stops and the rest goes again under the same id, and a
message left empty is taken back. The share comes from the request body as the
transport writes it. `BodyProgress` in the coroutine context gets each chunk,
and `UploadRanges` finds where each picture's base64 sits in the body, so
`UploadBoard` can hold a share per picture. Before any bytes go, the arc is
short and turning. Once the computer takes the message, every ring fills and
then shrinks away. The photos are movable content: a message of pictures alone
comes back captioned "Attached images.", and moves into a bubble without its
rings starting over.

Presented chat media is kept on the phone for good (`media/`, iOS
ba7b68346, after Telegram's MediaBox). Each agent connection has a
`MediaLibrary` beside its kept catalog (`<connection>.media/` in no-backup
storage), and it goes when the connection does. A file is kept under the
SHA-256 of its ID (`tool/<agentId>/<toolCallId>/<index>`). While it arrives
it is a `.part` file with holes plus a `.part.meta` record of the ranges held,
so a download resumes after a relaunch. `MediaDownloads` reads one file a
range at a time over the media route with `Range`: 1 MiB chunks for a whole
file, and a player's range first (256 KiB). At most two automatic downloads
run at once; a tap or a player goes past them. Three failures in a row, or
one 4xx, mark the file failed until the next tap. `KeptMedia` connects a
conversation to its library: photos and small files read themselves as they
show (`MediaAutoDownload`, Data and Storage), and anything else waits for a
tap on its ring. Tiles draw `DownloadStatus`: the ring (`MediaRing`, the
same component as the upload ring) shows an arrow, progress or retry, and a
recording's ring is its play button. A size badge in the top-left corner
shows a recording's length over "1.2 / 8.4 MB". A recording streams through
the library (`MediaStream`), so what was played is kept. Clear Media
empties the library. `rememberKeptMedia` builds a `KeptMedia` for a chat and
for its agent page, whose shared grid reads and rings the same way. A file
card's chip is `FileStatusChip`: a blue ring with the arrow or progress
until the file is here, then its glyph, with the size or "1.2 / 8.4 MB" in
the detail line; the chip's tap reads or pauses, and the card's tap opens.
An artifact's own files go through the same library under
`artifact/<artifactId>/<version>/<path>` (a numbered version never changes),
with no automatic rules: opening it reads it. Gallery and document tiles
draw `MediaStatus`. Happy accounts keep attachments in a library of their
own (`legacy-media/<publicId>/`, removed on sign-out): plaintext once
secretbox has checked the MAC, and a sent picture is kept at upload, so the
sender never downloads it. A legacy download is one request with progress
from the body; it can't pause.

### Context meter and usage ring

Under an agent connection's composer, `ui/conversation/ContextMeter` draws
desktop's ContextMeter as iOS does (083c30df4). It is a 64 × 4 bar in a
20 dp row under the pill, its end under send (`ComposerViewport`'s
`meter` slot; the one-row composer has none). A tap shows "42% 84k/200k"
for 4 s, and a hold shows it while held. The bar is coloured only near
compaction. `conversation/ContextGauge.derive` reads it from
`ConversationState.context` (the bootstrap's `context`, then each
`agent.context.updated`, applied without deriving rows) against the
window in `ModeCatalog.windows`. Before the first measurement it shows
the selected model's window. There is none while history is read or
before new work is made.

The model chip wears desktop's usage ring while the selected account
runs low (`AccountUsage.warning`: the week before the session, under 25 %
low, under 10 % or blocked critical) and reads the warning out.
`AgentSession.usage` (`AgentUsageSource`) reads `GET /v0/usage` while a
chat shows, and again on `provider.usage.*`, `config.updated` and each
reconnect. It keeps following for 30 s after the last chat goes. Words
are in `strings_context_meter.xml`.

### One-row composer

The chat's composer is one row when the full card with one line would
leave the transcript under 120 dp between the bar's foot and the card
(iOS ac81745ac, `ChatScreenLayout.compactBelow`). That is a phone held
sideways with the keyboard up. It is also one row wherever the card
can't fit at all. The decision comes from the card with one line, never
from the card as it is, so typing and going to one row can't undo it.
It is read where the keyboard rests (`keyboardPadding`), not mid-drag.
The row is [+], the field (two lines, then it scrolls, with the expand
button), the chips and send. The buttons stay at the row's foot as the
field grows. Android keeps the chips in the row rather than behind iOS's
options button: a sideways phone has the width for them.

### Full-screen editor

Past the lines the card shows (eight, or the one row's two, measured at
the field's width without the button), the composer offers Telegram's
expand as iOS does (efea2b139): send's size, centred over send, as far
from the card's top as send is from its foot, and the words wrap clear of
it. In the one row it stands at the field's end. It fades in over 0.1 s.
It opens `ui/conversation/ComposerEditor` over the chat: the same draft,
caret where it was, from the top inset to the keyboard, with the collapse
button 8 in from the top end. Collapse or Back hands the caret back, and
the composer takes focus before the editor fades out so the keyboard
stays up. If the keyboard was put away first, it stays away. It is drawn
in the chat's own window, not a dialog, so the keyboard never drops as
focus moves between the two fields. While it is up, the chat under it is
out of TalkBack's tree. Compose text has no exclusion paths, so every
line keeps clear of the collapse button, not only the first two.

### Pasting a picture

The agent composer's field carries a content receiver
(`Modifier.contentReceiver`), so a copied picture offers Paste in the
field's own text menu and attaches as a waiting picture, as iOS's
`AgentInputTextView` does. A keyboard's inserted image takes the same way.
The picture is what was meant: its name or address, often copied with it
as text, is dropped. Copied text alone pastes as words. Pictures go
through `ImagePicker.receive`, so they get the same room check and
normalization as the photo picker.

### Model and effort chips

The composer's label slot holds two chips, as iOS does (e2238fdc4,
083c30df4): the model (bold) and its effort (`ConversationModelChips`).
Each opens its own list (`ui/conversation/ModelPicker`), in Android's
menu card instead of iOS glass. The list's trailing edge sits on the
chip's, 10 dp above it, and it opens scrolled to the checked line.
`conversation/ModelMenus` builds the model list from `ModeCatalog`'s
providers: one service per provider type under a heading with the
selected account, its readings and a chevron. A hidden account or
model is left out unless it is the selection. A switched-off account is
listed dimmed, and its service opens on an account that works. A
selection that is gone, off or hidden gets a notice. The chevron
stacks that service's accounts over the list in place (same trailing edge
and bottom), each with its week reading and the selected one's windows.
Switching account keeps the model list up; any other pick closes it. A
touch outside, or Back, closes the accounts first.

A pick of another model runs at that model's default effort. The same
model keeps its effort, and an account switch keeps it when the model
runs it (`ModeCatalog.pick`, desktop's
`happyAgentSelectionModelUpdate`). Opening the model list asks
`POST /v0/usage/refresh` for the accounts it lists, then reads three
times 2 s apart (`AgentUsageSource.refresh`). `config.updated` and each
reconnect read `/v0/config` again (`Conversation.rereadCatalog`), so a
model hidden on the computer leaves the list while it is open. Words are
in `strings_model_picker.xml`.

### Image loading

One Coil 3 `ImageLoader` (`ui/components/RemoteImage.kt`) for every
picture that isn't bundled: profile pictures by URL (`Avatar` with an
http(s) `imageUri`), markdown images (`MarkdownImage`), and attachment
thumbnails and file messages (decrypted bytes, keyed by ref). Coil because
it is Compose-first and coroutine-based, sizes decodes to the view,
brings the memory and disk caches expo-image gives happy-app, and plugs
into our OkHttp; Glide is View-first with an annotation processor, and a
hand-rolled loader would re-implement caching and downsampling. The
loader uses its own OkHttp client without Happy headers (these URLs are
third-party). Tests swap it through `LocalImageLoader` with coil-test's
`FakeImageLoaderEngine`.

A picture with a thumbhash shows it from its first frame (iOS 5ebfc1c0b).
`rememberThumbHash` decodes in place as the view is composed, from one
process-wide `ThumbHashCache` (256 kept, least recently used out, a hash
that isn't one kept as nothing). The decoder works its cosines out per
row and column. The picture dissolves in over it in 0.2 s
(`HappyImageLoader.FADE_MS`, iOS `ImageFade`). One from the memory cache,
or any under Reduce Motion, replaces it at once.

### Avatars

Anything without a picture wears happy-ios's shader placeholder
(`ui/components/avatar/`): `AvatarPlaceholder.index(seed)` (FNV-1a then
the Murmur3 finalizer, mod 200) picks one of 200 bundled WebP stills, and
`AvatarShader` carries the same row's parameters for the AGSL port of
happy-ios's Metal shader, so one seed looks the same on both phones. The
stills, their NOTICE and the MIT license of @craftedstudios/shaders are
copied from happy-ios, and `AvatarShaderTable.kt` is generated from its
Swift table, by `node tools/avatars/generate.mjs`; tests pin both
byte-for-byte to happy-ios, so change them there and regenerate. Keep the
NOTICE and license in `assets/avatar-placeholders/`.

Placeholders move only with Settings › Appearance › Animated Avatars on
(device-local, off by default), on Android 13+ (`RuntimeShader`), while
their screen is resumed, animations aren't removed and power save is off;
at most 32 at once on one shared Choreographer clock (`LiveAvatarClock`)
at `AvatarShader.FRAMES_PER_SECOND` (20), each at `AvatarShader.speed`
for its size (2× at 48 dp and under, 1.5× above), as happy-ios. Settings'
picture, its accounts card, settings search and the account menu's button
move only for an account without a picture or thumbhash of its own
(`AvatarPlaceholder.liveSeed`); the menu's rows stay still. Seeds follow
happy-ios: an agent connection is
`agent:<address>`, a bot or task its own id, a project its id. Agent
home's project folders read the wire's `avatar`: `kind: "image"` is
`/v0/projects/:id/avatar` over its thumbhash, `"home"` the home glyph,
anything else the placeholder (happy-ios still looks for a `url` the wire
doesn't carry).

### Mermaid

`ui/components/MermaidView.kt` renders ```` ```mermaid ```` blocks the way
happy-app's native MermaidRenderer does: a WebView loading mermaid@11 from
jsdelivr, its height posted back through a `ReactNativeWebView` JS
interface (200 until reported, capped at 600). Where there is no WebView
(Robolectric, devices without a provider) `LocalMermaidWebView` is false and
MarkdownView's code block shows instead; layout tests see the code block
unless they provide `true`.

## Happy Protocol V2

A Happy Agent connected straight to the phone (an agent connection;
"Add" in the UI, never "computer"). The source of truth is happy-agent's
`API.md`, "Mobile connector" (pairing, credentials, the QR code); iOS's port
is `packages/happy-ios`. The wire keeps its own names
(`happy://direct?`, `/v0/mobile-connector/…`).

- **Pairing crypto** (`crypto/PairingCrypto.kt`): X25519, the
  length-prefixed transcript, HKDF-SHA-256 keys, HMAC confirmations and the
  333-emoji table (`resources/pairing/emoji.txt`, copied from API.md).
  `PairingCryptoTest` pins API.md's vectors and the table's SHA-256.
- **Link, handshake, identity** (`app/…/connection/`):
  `PairingLink` validates the code (a malformed `happy://direct?`
  never falls back to relay approval); `PairingService` commits,
  reveals, returns the emoji and on confirm waits for the agent and
  checks its MAC before anything is kept; `AgentIdentity` reads health
  (protocol 27 or later) and `config.node`; `AgentConnections` keeps each
  connection's credentials Keystore-encrypted, apart from relay credentials.
- **Transport** (`TailcatTransport`): tailcat-kotlin, and a fresh TCP
  stream to `server.tailcat:<port>` per HTTP/1.1 request, framed by
  `HttpResponseParser`. Each request says its `RequestCategory`, which
  picks its client in the connection's `TailcatClients` (iOS's, same names):
  one for `Realtime` (the event stream), one for `Query` (the default) and up
  to eight for `File` (pictures and avatars, attachments, messages with
  images, tool-call media, artifact files, and the in-app browser's
  sockets). Each client is made on first use with a node key of its own,
  fresh on every connect: the agent and the DERP relay tell clients apart by
  node key, and a relay keeps one connection per key. A file goes to the
  file client with the fewest requests in flight; another is made only while
  every one is busy. A query has 35 s, a file 15 min (any one read or write
  still 35 s). A failure resets only the client it happened on, so a broken
  file client never drops the event stream; a stack out of connections
  (`RESOURCE_LIMIT`) is busy, not gone, and is kept. A new call site that
  moves bytes passes `RequestCategory.File` (`TailcatClientsTest` pins the
  existing ones). `HttpsTransport` (an agent with a public URL) has no
  clients: each socket is its own TLS connection tagged with its category,
  so `reset(category)` closes only that category's, with the same
  deadlines; `AgentEndpointTransport` passes the category on. It uses
  tailcat-kotlin's default DERP map (`https://tailcat.dev/derpmap.json`),
  cached in `noBackupFilesDir/tailcat/derpmap.json` (`FileDerpMapCache`):
  with no network and no cached map, connecting fails.
- **tailcat-kotlin** has no published artifact. `tools/tailcat/build.sh`
  builds its pinned commit's JVM jar (the same sources as its Android
  variant) into `vendor/maven`, which `settings.gradle.kts` reads for the
  `io.tailcat` group only; the catalog pins the version. When it is
  published, switch the catalog and delete both. `tools/tailcat/patches`
  holds fixes not yet in tailcat-kotlin, applied on top of the commit
  (the version's `-p<n>`): today tailcat-swift 69a661b's closing-flow
  limits, without which the in-app browser's short requests run the stack
  out of connections. Upstream them and drop the patch.
- **Live check:** `LivePairingTest` pairs with a real Happy Agent
  when `HAPPY_PAIRING_LINK` holds a fresh code, writes the emoji for the
  person confirming in Happy Agent, then reads health and config with the
  new device token over a new tunnel. Remove the test device in Happy Agent
  afterwards.

### In-app browser and links

iOS's `docs/browser-proxy.md` is the contract; `browser/` ports it
(policy, relay, tunnel, `BrowserProxy`, the artifact API pool) and
`ui/browser/` holds the WebView and the link layer.

- **Where links go** (`ui/browser/Links.kt`, `LinkOpener`). HappyApp
  provides one per open account (`ProvideLinks`, which also replaces
  `LocalUriHandler`). With an agent connection open, a tap on a web link
  pushes `BrowserRoute`: the in-app browser through the agent, the local
  host workspace's network; a conversation narrows that to its agent's
  workspace. Other schemes go to the system. On a Happy (relay) account a
  tap does exactly what it did before (the system handler). A long press
  on a link gives a haptic and a bottom sheet: Open in Happy browser
  (through the agent; on a relay account a Custom Tab on the phone's
  network), Open in external browser, Copy link, Share. Text with links
  takes `webLinkGestures` (every MarkdownView: chat in both modes, tool
  plans, artifact and Surface documents, questions, What's New; and the
  link texts of What's New's summaries, Troubleshoot, onboarding and the
  bot face credit; a `LinkAnnotation.Clickable` carries its address as its
  tag); a row that opens a page takes `rememberLinkMenu(url)` as its
  `onLongClick` (About's rows). The gesture is taken in the initial pointer
  pass, so the link's own click, a bubble's copy menu and text selection
  never also fire; a drag past the touch slop lets go and scrolls
  (`LinksTest`, which covers each site).
- **Remote only.** Every WebView request goes through `ProxyController`'s
  override to the loopback `BrowserProxy`, with no bypass rules, applied
  before the first load; a WebView without `PROXY_OVERRIDE` shows
  "unsupported" and loads nothing. There is no direct fallback.
- **Android limits and what we do:**
  - The proxy override is process-wide, not per WebView as WKWebView's.
    While a browser page is open, every WebView of the app (Mermaid's too)
    goes through the proxy. With `MULTI_PROFILE` each page's WebView gets
    a profile of its own (`WebViewProfiles`): its own cookies, storage and
    network context, which answers the 407 with that page's credential
    alone, so the proxy routes by credential and pages can't reach each
    other's origins or workspaces. The profile is deleted with the page
    (iOS's nonpersistent store). Verified on WebView 124: Chromium's proxy
    auth cache is per profile; two WebViews in one profile with different
    credentials send the first one's for both. Without `MULTI_PROFILE`, pages share the
    default profile and one credential, and the proxy routes by target
    (an artifact's synthetic origin to its page, the rest through the
    newest page's workspace).
  - `shouldInterceptRequest` can't see POST bodies or carry WebSockets,
    so nothing is intercepted there: the proxy speaks HTTP CONNECT and
    absolute-form HTTP below WebView, so bodies, WebSockets, SSE, TLS,
    cookies and redirects are the page's own, untouched.
  - Cleartext: `network_security_config` allows http only for the
    synthetic artifact origin, localhost and 127.0.0.1; WebView refuses any
    other plain-http page (`ERR_CLEARTEXT_NOT_PERMITTED`) before the proxy
    sees it. iOS allows them in web content only; Android has no
    WebView-only switch, and a base-config allowance would also open
    cleartext to the app's native clients.
  - The listener binds 127.0.0.1 by address: Android's
    `getLoopbackAddress()` is `::1`, which WebView's `127.0.0.1` rule
    can't reach.
- **Pooling** (`BrowserConnectionPool`, `BrowserResponseBody`): artifact
  `/api/*` requests lease keep-alive connections per page (6 idle, 5 s),
  returned only after an exact, self-delimited answer; everything else
  closes after one answer. `BrowserProxyTest` runs OkHttp through the
  proxy against a byte-level fake daemon; `BrowserWebViewDeviceTest`
  (androidTest, an emulator) does the same with real WebViews: two artifact
  pages in their own profiles at once, the computer's localhost, and the
  cleartext refusal.
- **App mode** (`<meta name="happy-page-mode" content="app">`, the
  contract shared with desktop and iOS, as agents read it in
  happy-agent's docs/DESIGN.md §1.8). `artifacts/ArtifactPageMode` reads the entry's first
  64 KB before any WebView is made (`ArtifactUi.Page.app`,
  `InlinePages.readMode`), so nothing jumps. Inline, such a page is never
  run: its card reads "App" and "Open". Opened, `ArtifactAppPage` is a
  `PageDialog` edge to edge into the cutout, the bars hidden with
  `BEHAVIOR_DEFAULT` (SHOW_TRANSIENT_BARS_BY_SWIPE turns the edge back
  gesture off while they are hidden) and shown again on close; back always
  closes it, as does the × (`AppCloseButton`: 32 at 8 in from the safe
  corner `<meta name="happy-app-close">` names, `top-start` by default and
  start/end flipping right to left, 35% after 3 s, woken by a touch within
  64). Swiped in, the bars go again after 3 s. With `none` there is no ×
  until a pull down from the top 24 shows it
  top-start for 3 s; the system takes a top-edge pull a move or two in, so
  it needs only 8 of drag. `BrowserAppMode` is the page's side: no zoom,
  scroll, pull to reload, selection or long press,
  `data-happy-page-mode="app"`, `data-happy-app-close`, the host sheet at
  document start, `--happy-app-inset-*` (the safe area, plus 48 on the ×'s
  edge), `--happy-app-close-x/y/width/height` (its 48 box in CSS px, 0 for
  `none`), and `window.happyApp.close()`, which posts to a
  `WebMessageListener` allowed only for the page's own synthetic origin and
  main frame (`BrowserAppMode.accepts`).
  Android centres no page, so app implies full width with nothing to do.
  `ArtifactAppDeviceTest` runs a canvas game through the real proxy on an
  emulator. The WebView matches its `SwipeRefreshLayout`: wrapping its
  content, it gave every page `100vh`/`dvh` of 0.

### Vaults

A vault Surface (`type: "vault"`) is a versioned folder tree. The contract
is happy-agent API.md, "Vault Surfaces"; the product is task_221's
vaults-design.md; iOS's port is `packages/happy-ios`. `vaults/` is the wire
and state, `ui/vaults/` the screens. Strings are `strings_vaults.xml` in
every locale, not happy-i18n.

- **Items** (`VaultItem`): the wire's folders (`/folders`,
  `vault.folder.*`) and files (`/files`, `vault.file.*`, plain or
  artifact) are one shape here, told apart by `kind`. `VaultClient` picks
  the route from it, and events say which they are about
  (`VaultEvent.Updated.folder`).
- **Folders** (`VaultListing`, `VaultFolderFeed`): a folder is read whole,
  500 items a page, and sorted on the phone (`VaultSort`: folders first,
  then name with a SECONDARY `Collator`, updated or size), so a change never
  waits on a page. An event that follows the held `version`
  (`previousVersion`) is laid over the item (`VaultItem.changed`). A gap in
  the chain, a restore or a move here reads the item again. An item that
  left is remembered with its version, so an older page can't bring it back.
  `hello` reads everything again. An item the phone's own request returned
  goes to the folders at once (`Vaults.known`). There are no refresh
  controls.
- **Changes** carry `If-Match`, and a `409` with the current `folder` or
  `file` is tried once more against it (`VaultActions.change`).
- **Uploads** (`VaultUploads`): uploads are scoped to the session and run one
  at a time, so they survive leaving the screen. Each is sent in pieces sized
  to take about 3 s (256 KiB–16 MiB, starting at 1 MiB, under Tailcat's 35 s
  write deadline). After a failure or a `409` an upload resumes from the
  daemon's `received`. When the taken name (`409 name_taken`'s `item`)
  belongs to a file of the same kind, the person chooses Replace (a new
  version) or Keep both ("name 2.ext"). A file named "*.artifact" (any
  case) becomes an artifact, and a ".zip" is always a plain file. An
  artifact's new version is a whole ".artifact" file. A refused one shows
  the daemon's own reason on its row, with no retry. Each task keeps one
  `operationId` (for `POST /files/:id/versions`) and one new-file `id` on
  every try, so a lost answer makes no second version or file; a retry after
  a placement was sent asks it again before sending any bytes (`placedAgain`),
  and a `200` with `version: null` is success. A Restore version tap keeps its
  own `operationId` through its `If-Match` retry. Uploads live in memory, so
  they don't resume after the process dies.
- **Apps**: people call an artifact an app, in every string. Its stored name
  keeps the ".artifact" suffix (API calls, and the `.artifact` file a download
  or share writes from `/versions/:n/zip`), but no screen shows it:
  `VaultItem.shownName` and `VaultNames.shown`/`shownPath` drop it everywhere
  a name or path is drawn. An app is told apart by its one icon
  (`AppsOutline`) and its live preview. Rename edits the name without the
  suffix and adds it back (`newName`), and a folder or plain file can't be
  named "*.artifact" (`vaults_name_reserved`, under its own title,
  `vaults_name_refused`). A share (`vaultShare`) sends the `.artifact` file
  titled with the bare name (`EXTRA_TITLE` and the `ClipData` label).
- **Previews** (`VaultPreview.kind`): pictures and video go to
  `PictureViewer`, with video over a `RangedSource`. PDFs go to
  `PdfRenderer`. Text up to 2 MB, and Markdown, go to `FileScreen`.
  HTML apps run live through `BrowserProxy` with
  `Scope.Artifact(vault = …)`: every path is a file of that version
  (`/versions/:n/artifact/*`), and there is no `/api`. Anything else gets
  share, open in another app, or Save to.
- **Retention presets** (`VaultRetentionPreset`) are the same on every
  client: Time Machine (the default), Keep everything, Last 10 versions,
  Custom. A preset sets only the four version fields, and the Trash keeps its
  own duration.
- Tests: `vaults/*Test` (listing, events, uploads against a fake daemon,
  routes, presets) and `ui/vaults/VaultLayoutTest`.

## Autocomplete

`@` file mentions and `/` commands in the chat composer. Logic is in
`autocomplete/` (plain Kotlin, unit-tested against happy-app's own test
cases): `findActiveWord`/`applySuggestion`, `searchCommands` (session
metadata's slash commands and skills, minus `IGNORED_COMMANDS`), and
`FileSearchCache` (`rg --files --follow` over Sync's session ripgrep RPC,
kept 5 minutes). Ranking is `Fuse.kt`, a port of the Fuse.js 7.1 subset
happy-app uses; `FuseTest` holds scores produced by fuse.js itself, so
regenerate them from fuse.js if the options change rather than editing
them by hand. The UI is `ui/autocomplete/`: ChatRoute provides
`LocalSuggestionSource`, ChatScreen passes `ComposerSuggestions` into
ChatComposer's `overlay` slot and the shared `ComposerCursor` into its
`cursor` parameter (the composer reports the selection, places the cursor
after an insert, and offers hardware keys to `cursor.onKey` first: arrows,
Enter/Tab and Escape drive the list while it shows).

Happy Agent chats reuse the same list and cursor for the agent's own slash
commands (desktop d04fbfef, 4078fd44, aa8a2529). The catalog is
`ConversationState.commands`: the bootstrap's and every focused agent
response's `slashCommands`, replaced whole by `agent.slash_commands.updated`,
and kept offline with the conversation. `conversation/SlashCommands.kt` holds
desktop's rules: the list shows only while the whole draft is `/` plus a word
some command begins, commands before skills; a submitted `/name args` with an
offered name runs instead of sending. `ui/conversation/ConversationCommands`
is the `SuggestionSource`, through three hooks the CLI source leaves at their
defaults: `query` (the whole draft, not the word at the cursor), `pick` (a
command runs at once and the draft clears) and `draft` (a skill becomes
`/name ` for its arguments). `Conversation.runCommand` invokes a command with
`POST /slash-commands/:name` and the composer's mode (404 and 409 are
`Problem.CommandGone`/`CommandBusy`); a skill is a user message `/name args`
carrying one `read_skill` tool_call_request, as desktop sends it. The command's
words never go out as a message otherwise.
