# Agent connection voice calls

The voice button on a Happy Agent connection's home (iOS, Android) starts a
call with a hosted ElevenLabs agent. The audio, the system prompt, the
context the agent reads and its seven client tools all live on the phone. This is separate from the
relay's voice (`docs/voice-architecture.md`) and from GPT-Live on desktop:
there is no shared voice engine, prompt or tool between them.

Code:

- iOS: `packages/happy-ios/Sources/HappyCore/Call/` (state, context, tools,
  grants, allowance) and `Sources/HappyUI/Call/` (SDK, bar, controller).
- Android: `packages/happy-android/app/src/main/kotlin/com/slopus/happy/call/`
  and `ui/call/`.

## Connecting: a public agent ID, for now

Calls connect to a **public** ElevenLabs agent by its ID. No Happy service
mints a conversation token, no relay sign-in is used, and no provider API
key is on the phone.

Why: voice shouldn't hold back the launch while voice authentication gets
built, and it isn't yet clear how much more voice deserves. A token
service can replace the public ID later (`CallGrant.conversationToken` is
already there for it). The client-owned transport, context and tools stay
the same either way.

What this costs:

- **This is not authentication.** Anyone who extracts the ID from an app
  build can start conversations that are billed to the agent's owner.
  Treat the ID as a key you can rotate. If it is abused, make the agent
  private, or rotate to a new public agent and ship a build with the new ID.
- **The usage limit is local** (below). It can be reset by reinstalling
  the app or changing its data, so it protects nothing.

The ID is **never in the repository**: not in code, docs, tests or tracked
config. It is injected at build time:

- iOS: `HAPPY_CALL_AGENT_ID = agent_…` in
  `packages/happy-ios/Config/Call.local.xcconfig` (ignored by git), or
  `HAPPY_CALL_AGENT_ID=agent_…` on the `xcodebuild` command line. It reaches
  `Info.plist` as `HappyCallAgentID` and is read by `CallAgent.hostedAgentId`.
- Android: `HAPPY_CALL_AGENT_ID` in the environment,
  `-Phappy.callAgentId=agent_…`, or `happy.callAgentId=agent_…` in
  `packages/happy-android/local.properties` (ignored). It becomes
  `BuildConfig.CALL_AGENT_ID`.

Without an ID the button stays, and a tap says "Voice isn't set up for this
connection yet" without asking for the microphone.

## The bar over every screen

The call's bar stays at the top whatever the app shows: home, a
conversation, Settings, a sheet, a full-screen viewer, the scanner. It uses
only the app's own windows. There is no overlay permission and no
accessibility service, and the system's windows (permission prompts, Face
ID, biometrics, store confirmations) stay above it.

- iOS: the bar is in a window of its own (`CallBarWindow`, one level above
  the app's) that never becomes key and takes touches only inside the bar.
  `CallPresentations` keeps the app's presented screens clear of it: a
  full-screen one gets the overlap added to its top safe area, and a sheet
  card's tallest detent is shortened so the card starts below the bar. Both
  are given back exactly when the bar goes, the screen is dismissed or the
  orientation changes. A presentation hides the bar's window from
  VoiceOver, so the presented screen's container carries `CallBarEcho`: one
  element at the bar's place, saying what the bar says, with mute and end
  as actions. UIKit's own controllers (alerts, share sheets, pickers) are
  left as UIKit made them, under the bar.
- Android: `CallFrame` wraps the app's navigation.
  - Edge-to-edge dialogs: every one of the app's (`PageDialog` or
    `WindowDialog` with `decorFitsSystemWindows = false`: the picture viewer,
    the attach sheet, the question form) covers the window and carries the
    same bar in its own `CallFrame` (`WindowCallFrame`). The covered bar
    under it is cleared from the semantics tree, so TalkBack reads the call
    once.
  - Dims without covering: a centred card (`AlertDialog`, prompts) leaves
    the bar under its dim, where a tap dismisses the card. So do the
    `ModalBottomSheet`s (the link menu, the voice paywall), whose few rows
    keep them well below the bar. A sheet's window would set its own status
    bar icons, dark over the bar in the light theme; `SheetStatusIcons()` in
    the sheet keeps them light while the bar shows.
  - The QR scanner is an activity of its own. It counts as the app being in
    the foreground, so the call isn't hung up, and it shows the bar too.
  - Mute and End take touches in 48 dp squares (Android's least) around
    glyphs placed as Telegram's 44 pt slots place them. The bar is never
    shorter than 48 dp, so with no status bar above it (landscape,
    immersive) the squares still fit inside the window.

## Free time, counted on the device

Each device gets 20 minutes of connected call time in any rolling 30 days
(`CallAllowance` on iOS, `CallAllowance.kt` on Android). One local ledger
covers every connection on the device and survives sign-out.

- A call counts from the moment it connects until it ends, including time
  spent muted. Connecting and failed calls count nothing.
- A live call writes its span down every 10 seconds. A call the app never
  saw end (because the app was killed) still counts up to its last write,
  and it is never counted twice.
- A span that crosses the window's edge counts only the part inside the
  window. A span that ends after "now" because the clock was moved back
  counts in full, so moving the clock back gives no time back.
- With no time left, a tap ends at once with "Free voice time used: 20 min
  per 30 days" and never asks for the microphone. A live call ends when its
  time runs out and shows the same words.
- There is no cap on the number of calls and no other cap.

With the subscription (RevenueCat's `pro` entitlement, from any product
that grants it) the limit is 5 hours a month instead, counted by the same
ledger. The ledger keeps calls for at least 62 days and never forgets one
from inside the running paid month. Both limits are local. The server checks
no subscription; it only caps every account's Happy-managed voice at 5 hours
per 30 days as a cost safety net.

Voice in Happy (relay) sessions is switched off in both apps: a session's
chat has no voice button and nothing reaches ElevenLabs from it (Android
`VoiceEngine(enabled = false)`; iOS `LegacyVoice`, which debug runs can turn
back on with `HAPPY_RELAY_VOICE=1`). Voice is the agent connection's call.

### The subscription

Both apps sell it without RevenueCat's SDK, through RevenueCat's REST API
(v1, the public Google or Apple key) for what is on sale and who has `pro`:
Android with Play Billing (`payments/Subscription.kt`), iOS with StoreKit 2
(`HappyCore/Subscription/Subscription.swift`). The rules below are both
apps'.

- **On sale** is the current offering's monthly package (`$rc_monthly`),
  only if the store says it is a one-month auto-renewing subscription. Its
  price is the store's. No key, no product or no answer: nothing is sold.
- **Whose purchase.** The customer is the install's own anonymous id
  (`$RCAnonymousID:` and 32 hex digits), kept on the phone. It is not the
  Happy account, never sent to Happy's server, and never the PostHog
  distinct id; signing in or out, or switching accounts, changes nothing. A
  purchase carries its customer readably, for good: Play's
  `obfuscatedAccountId` is the id itself, StoreKit's `appAccountToken` is
  its 32 hex digits as a UUID. So a renewal or a purchase that completes
  late is posted for whoever bought it, and one that names no customer is
  left alone.
- **Every phone on the store account.** At launch and foreground, an active
  subscription the Apple ID or Google account holds that names a customer
  makes that customer the install's own (adoption): no restore, no receipt,
  nothing moved in RevenueCat, so phones never pull a subscription from
  each other.
- **Restore** is the user's tap only, and moves a purchase to the restoring
  customer from then on. One exception: the first time RevenueCat answers
  after the phone-only version is installed, a subscription that names no
  customer (bought by happy-app or by an earlier native version, whose ids
  were SHA-256 hashes) is posted once as a restore, if the install hasn't
  `pro`.
- **Pro** is the last RevenueCat answer, cached for 24 hours by RevenueCat's
  own clock, never read from the offering.
- **The month.** Month n runs from the entitlement's latest purchase date
  plus n calendar months (UTC) to plus n+1: Jan 31, Feb 28, Mar 31. In
  the store's grace period the month that was running carries on with no end,
  adding no hours. Grace is read from the subscription
  (`grace_period_expires_date`), not the entitlement.

### Voice's welcome and paywall

iOS draws both as one full-height sheet (`CallSheetViewController`) in the
first screen's style (`StartViewController`): its Grain Gradient behind,
its text colours and pill. The podcast mic plays on top (Lottie,
`podcast-mic.json`; source and licence unverified, see
`Animations/PROVENANCE.md`), then "Talk to your agents" and what voice
does, one icon and a few words a line: "Ask how your work is going",
"Open and send by voice", "20 free minutes" (a gift). At the bottom, where
a subscription is on offer: "Support Happy for $20/month"
(`CallOffer.price`), "5 hours of real-time voice included", "Happy is open
source. Subscribing to voice pays for its development.", the "Subscribe"
pill, then "Start Voice Session" with
voice's three bars, quieter, under it. A ✕ on top, or a swipe down, closes
it and starts nothing. No RevenueCat or other vendor UI, and no navigation
bar.

**The welcome** is the upsell: it comes once, on the first tap of the
voice button while a subscription is on sale. "Start Voice Session" closes
it and starts the free call, which asks for the microphone then, never
before. Shown, it is seen, however it was closed: from then on the button
just calls (`CallIntro`, `call.intro.seen` in the device's defaults, beside
its free time). With nothing on sale (until the store products exist) there is
no welcome and the first tap calls; a subscriber has nothing on sale
either.

**The paywall** is the same screen once the free time is used: a tap with
none left (before the microphone is asked for), or a live call reaching the
end of it. The red bar goes and the sheet takes its place; the voice button
shows it again. "Start Voice Session" is greyed out, and under "20 free
minutes", in the app's warning colour (`Palette.warningText`, as the
offline header's), "Your free voice time is used. More comes back on Dec
3." (`CallAllowance.freeAgain`:
"at 5:19 PM" today, "on Thu at 5:19 PM" this week, "on Dec 3" after; "as
older calls pass 30 days" when no time ever comes back, as with a clock put
back). What is on offer (`CallOffer` on iOS, `Offer` on Android):

- `unavailable`: no subscription, no price and no buy button, and no
  welcome. Only the used-up sheet shows: "Start Voice Session" is its main
  pill, greyed out, and the ✕ closes the sheet.
- `onSale(price)`: the store's price, Subscribe and "Restore
  Purchases".
- `subscribed`: no second Subscribe; the 5 hours a month, and once they are
  used, when the next month's begin.
- `preview(price:)`, debug builds only and only when launched with
  `HAPPY_CALL_OFFER=preview` (test screens; `HAPPY_CALL_OFFER_PRICE`
  changes the price drawn): the subscription as above, noted "Test preview.
  Nothing is charged." "Subscribe" says "Preview only: … Nothing was bought
  or charged, and your voice time hasn't changed." No product, charge,
  entitlement or change to the free time.

Android draws the same sheet (`ui/call/CallSheet.kt`): a full-height
`ModalBottomSheet` with the first screen's `GrainGradient`, the same
podcast mic (`res/raw/call_podcast_mic.json`, the same bytes), rows, words,
buttons and warning. One presenter (`payments/Offers.kt`, drawn by
`OfferHost`) shows every sheet that sells the subscription, one at a time:
voice's `Welcome` and `Used`, `Required` when the relay's voice says
`voice_must_pay` (buying retries it once; unreachable while the relay's
voice is off), and `Support` from Settings'
Support us row and the agent's boba row ("Pledge <price>/month", 5 hours of
voice a month, no Start). `CallIntro` keeps `call.intro.seen` in the
`call-usage` preferences beside the free time. The relay's 5-hour hard cap
is never sold: it only says so. The legacy RevenueCat SDK and its paywall
are removed.
On a tablet the sidebar's foot has the voice button too, left of the
compose pill, and a conversation a call opens shows in the main panel
rather than over the shell.

Test runs drive both without a call or a microphone (debug builds,
`CallController.applyTestEnvironment`): `HAPPY_CALL_INTRO=due` shows the
welcome again (`seen`: never), `HAPPY_CALL_USED=1` spends the free time,
and `HAPPY_CALL_STEPS=tap,subscribe,session,close,dismiss,…` presses the
voice button, the sheet's buttons and an alert's one step every 3 s,
logging each (`[call-steps]`). Android takes the same as launch extras
(`happy.call.intro`, `happy.call.used`, `happy.call.offer` with the price,
`happy.call.steps` of `tap`, `session` and `close`; log tag `call-steps`).

What it doesn't have yet:

- The monthly store products and RevenueCat's current offering for them,
  set up and checked with a real purchase (left to the user).
- A server that counts the paid allowance: today only the device counts,
  which a user could reset.

The old relay endpoint's quota had two bugs: no rolling window and a
100-conversation page cap. These were fixed in source on 2026-10-21 (commits
`541a22d03` for the rolling window and `1a643badd` for pagination). Whether
the fix is deployed has not been checked. None of that endpoint is used here.

## What the call puts in the agent's context

The LLM reads everything the call has added, and every addition stays.
From the phone's side contextual updates only append: there is no way to
replace or remove an earlier one. So the call says little, and only what is
new.

**The conversations it hears from.** The call keeps the last four
conversations the person visited during the call, the one on screen
included (`CallContext.followed`). Opening a conversation, by hand or with
`openSession`, makes it the latest; the fifth one back drops out and is let
go. `openSession` replaces a conversation that is on top of the stack and
pushes over anything else (home, Settings), so a call that opens A, B and C
leaves one conversation over what was under the first, never a pile. Settings, home, a sheet or the scanner in front change nothing: the four
stay. `listSessions`, `getSessionContext` and `sendMessage` never add one.
The phone keeps exactly those four conversations read for the call, and no
others.

**The directory: what the person sees.** The call's directory is the
sidebar's: every bot, task, subtask (at any depth) and project or worktree
conversation the person sees in the app, in the sidebar's order and
nesting, and nothing it hides (a hidden bot, an archived task or subtask,
a task the person left). iOS reads it from the same rows home draws
(`SidebarRows`, then the spaces sidebar's for anything not there yet;
`CallTarget.list`); a conversation is a bot or a task by its row's
`targetKind`, a subtask when it sits under another conversation, else a
project's conversation. Android reads home's rows the same way
(`AgentFeed`, `CallTarget.from`): a project's or worktree's folder is a
heading, Surfaces, Artifacts and todos are skipped. Each is named by the sidebar's own label, whatever
it is: "New Task", "New Bot" or "Untitled" too. The tools reach any of
them, by reference, whether or not the person opened it; there is no list
of the call's own. The agent reads it as indented lines:

```text
Conversation directory:
Architect [bot; ref=s1]
Release notes [task; ref=s2]
  Fix cache race [subtask; ref=s3]
App [project]
  Root chat [conversation; ref=s4]
  Feature [workspace]
    Feature chat [conversation; ref=s5]
```

A project or a worktree is a heading without a reference. A reference
(`s1`, `s2`, …) stays the conversation's for the whole call, through
renames and moves. It reaches the conversation while the sidebar lists it:
one that went away (deleted, archived, left) reaches nothing and is no
longer heard from, and reaches it again, under the same reference, if it
comes back. The lines are where titles meet references: nothing else in
the context pairs them (`listSessions` aside, which is a directory query).

**How the directory changes.** A change to the sidebar (something came,
went, moved or was renamed; a status alone is none) is due one second
after the first such change (`CallContext.Limits.settle`,
`DirectorySettle` on both); later changes never put that off. Then the sidebar is
read again, as it is then, and if that isn't what the agent last had, it
goes whole:

- `{"event":"directory","text":"Conversation directory:\n…"}`: the
  directory, as above, within 12 KB and 100 conversations; the rest are
  counted on its last line ("… and 40 more; listSessions finds them by
  title.").
- `{"event":"directory_entries","text":"More of the conversation directory:\n…"}`:
  any that the snapshot couldn't show and that are new or changed since the
  last one, each with the lines it sits under (one too deep for a page goes
  with what it sits under on a single line, cut to fit: `(under A > B > …)`),
  in as many events of up to 4 KB as they take. Two go with the snapshot;
  the rest follow two per update (`CallContext.moreDirectory`), sent by the
  call's one `DirectoryDrain`, each once the one before has reached the
  provider and only while the call is connected, so no update nears the
  32 KB wait. Every size here counts the JSON that carries it (a quote,
  backslash or slash two bytes, a control character up to six), and
  titles carry no control characters. If waiting context
  overflows anyway, the resync owes again every change since the first
  snapshot that its directory can't show, and those follow the same way.
  None is lost to a size. What was cut and hasn't changed isn't sent again.

So work that came and went within the second says nothing, and work
deleted, archived or left says nothing more from the moment the sidebar
drops it, before the second is out (a late reply from it included); new work that
got its name in it goes by that name; new work that never got one goes as
"New Task" and, named later, goes again under the same reference. Before
any update about a conversation the agent doesn't have as it is now (new
work the person opens before the second is out, a rename before its next
words), the conversation's own lines go first, in a `directory_entries`
in the same update.

**What a visited conversation says**, as contextual updates (JSON, one per
line, keys sorted):

- `{"event":"assistant_text","title":"Fix cache race","parents":["Release notes"],"text":"…","finishedTurn":true}`:
  a piece of the agent's words, whole, once it is complete. Never while it
  streams: no partial words, no deltas, no timer. `finishedTurn` when its
  run has ended and these were its last words; absent for words the agent
  went on from mid-run.
- `{"event":"session_error","title":…,"parents":[…],"reason":"…"}`: a turn
  that an error ended (`reason` up to 1 KB). A turn the person stopped is no
  error.

Updates name a conversation by its `title` and the titles of what it sits
under (`parents`, outermost first, headings included), never by an ID.
Only when that leaves it unclear (another conversation has the same title
under the same parents, or it has no name of its own yet: "New Task", "New
Bot", "Untitled") does it carry its reference too (`"ref":"s3"`). No
message IDs, block indexes or the computer's IDs reach the agent.

A piece is the agent's words between two of its steps: the words before a
tool call, or after the last one (on iOS a `ChatItem` of role `.agent`;
thinking and pictures between text blocks don't split it). The wire marks no
block as finished, so the app goes by the run the words are of
(`ChatItem.turn`), never by a pause:

- they are complete once the agent did something after them in that run
  (a tool call, more words after one, the run's end or failure), so words
  before a tool call go mid-run, without waiting for the turn;
- or once their run is not the newest: a `run.boundary` that starts the
  next run at once, with the conversation still working, completes the
  last run's words even before its end shows;
- or once the conversation stops working (`run.finished`).

The person's own message (queued, pending or taken), another agent
reporting in, a question, or anything else that is not the agent's own
next step in that run completes nothing. The agent's last words in its
newest run while it still works never go, however long it pauses. Each
piece goes once: a status change, a refresh or the same state again sends
nothing. A piece longer than 4 KB goes cut there, with `"truncated":true`.
Android has no run on a row: there a turn's rows come together with its
end after them, so its words are of that run, and words with a step after
them (a tool call, a picture, more words, a failure, the end) are complete.

Nothing else: no tool calls or results, no working, run, status or
needs-input changes, no messages of the person's, and no prompt asking the
agent to speak. A conversation's state is read on demand
(`getSessionContext`). Every update is silent: none starts a turn.

The first time the call sees a visited conversation, what is there already
counts as known and nothing is sent: history is never replayed. A reply
still being written at that moment is new, and goes whole once it is
complete. One that dropped out of the four and is visited again starts
over the same way.

**The focus.** `{"event":"focus","focusRevision":3,"title":"Fix cache race","parents":["Release notes"]}`,
or `"title":null` for home, Settings or anything else that isn't a
conversation: the screen in front changed. No history comes with it.

**History** (the first snapshot's `focus` and `getSessionContext`): the
conversation's `title` and `parents` (and in the first snapshot its `ref`
when unclear, as above), `working`, `needsInput`, when the person last wrote
there (`lastUserMessage`, the newest message of theirs in what was read) and
when the agent last answered (`lastAgentReply`, the end of the newest run
with words), its `workspace` (the project and worktree headings it sits
under, `App / Feature`; a bot or task has a workspace of its own and none is
given, and the computer gives the phone no folder paths), its `model`
(`{id,name,effort}`, what its next message goes with), then the last five turns,
five in all. Never its reference, kind or status: the directory has those.
Each turn is the person's message that started it and the agent's last
words (the turn's copy text, never its commentary between steps, tool
output or words still streaming), or as much of that pair as there is: a
turn steered or stopped before an answer has only the person's message, one
with no message of the person's only the agent's words, one an error ended
its `error`. The person's latest message, when no finished turn answers it
yet, is the fifth, labelled `pendingUserMessage`, so then four finished
turns come with it. Each text is cut at 4 KB, and the whole within 32 KB
(the oldest turns give way, `olderTurns` says more exist).
`getSessionContext` also lists the `models` the conversation can switch to
(`[{id,name,efforts}]`, at most 30: the composer's model picker's, each
shown account's switched-on models less those it hides).

**Times** are a pair, `{"ago":"5 minutes ago","at":"2026-11-06T09:15:00+01:00"}`:
how long ago, as said aloud (`just now`, `a minute ago`, `N minutes ago`,
`an hour ago`, `N hours ago`, `yesterday`, `N days ago`), and when on the
phone's clock, with its offset, to the minute. `listSessions` gives each row
the sidebar's own time (`lastActivity`, when the row says it last did
something; the exact pair needs the transcript, so it is
`getSessionContext`'s), and `now` on the same clock.

`queued` is not a receipt. A message the call sent that later fails to
reach the computer shows as `pendingUserMessage.delivery: "failed"` on the
next `getSessionContext`, and in the chat as any failed message does.
No update announces it.

**Sizes:** the first snapshot is capped at 32 KB (the older turn gives way,
then the directory's tail; the conversation on screen is always among its
lines). Context that arrives before the call is live
waits, up to 32 KB. Past that it is let go whole rather than cut,
and replaced by one resync (`CallContext.resync`): the directory as it is
(12 KB at most), then a `focus` event with the current `focusRevision` and
`"resync":true`, the errors the call told of, and each piece it told, as
told, the most recent first, those within 16 KB (`omitted` counts any that
didn't fit). Per call, words are bounded by 4 KB per piece of the
four visited conversations, but not in total: a long call over busy
conversations still grows the agent's context.
Debug builds count every update and tool result by size
(`CallProbe.sent`, `live.json`), so real calls can be measured.

## The hosted agent

Use a new, versioned agent. Leave the relay's agent (`sendMessageToSession`,
`processPermissionRequest`) as it is.

### Settings

- Authentication: off (public), for the reasons above.
- Overrides: **System prompt** on (Security → Overrides), and Language on
  if a language is ever chosen. The app sends the prompt below as the
  agent's prompt override on every call (`CallPrompt`), with the one dynamic
  variable; it sends no first message. ElevenLabs refuses a conversation
  whose override the agent doesn't allow, so this is switched on before a
  build that sends the prompt ships.
- Dynamic variable: `initialConversationContext` (a string). It holds a JSON
  snapshot (`schema` 2): the directory as text, the conversation on
  screen with its last five turns, and `focusRevision`. It is limited to
  32 KB.
- Client tools: exactly the seven below, each with "Wait for response" on and
  a response timeout of 10 s or more. The phone answers within 8 s and says
  `uncertain` if a send is still in doubt at that point.
- System tools: `end_call` is fine. Don't add tools for permissions or
  questions. Those stay in the app.

### System prompt

The phones send this prompt themselves, as the agent's prompt override
(`CallPrompt.system` on iOS, `CallPrompt.SYSTEM` on Android, the same
words; unit tests on both fail if this block and the code differ). The
dashboard's own prompt is then only what older builds run on: set it to the
same text, so an old build that is offered the new tools hears the same
rules (it answers `newWork`, `goBack` and `goHome` with `Unknown tool.`).

```text
You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more.

What you know comes from {{initialConversationContext}} (JSON) and from contextual updates during the call, each a JSON object with an "event": directory (the conversations the person sees in the app, as indented lines, each with its ref), directory_entries (more of them), focus (the conversation on screen, or a null title for home, Settings or anything else), assistant_text (a complete piece of a conversation's agent's words, whole; finishedTurn when it ended its turn) and session_error. Updates name a conversation by its title and the titles of what it sits under (parents); find its ref in the directory lines, or use the ref an update gives when titles alone are unclear. You hear new replies only from the four conversations the person most recently visited. Use refs (s1, s2, ...) in tools, never titles. Titles like "New Task" are work that hasn't been named yet.

Tools:
- listSessions: find conversations, with when each last did something; query is a case-insensitive substring of the title.
- getSessionContext: read a conversation before you summarise it: its last five turns (a message still waiting for an answer among them), when the person last wrote and the agent last replied, the workspace it runs in, its model and effort, and the models and efforts it can switch to. On a team, several people may write in one conversation: userBy and by say who wrote each message, "the person" being the one on this call.
- openSession: show a conversation on the person's screen.
- newWork: start a new task or a new bot, as the compose button does, without opening it: the screen stays as it is. A new session or conversation is a task unless the person asks for a bot. It is made on the computer by its first message; open it with openSession only if the person asks to see it.
- goBack: go back one screen. goHome: go to the home screen.
- sendMessage: send words to a conversation's agent.

Sending:
- Call sendMessage only when the person explicitly asks you to send: "send it", "send that to the release task", "tell the backend bot to ...". Describing a problem, thinking aloud, dictating or answering your question is not a request to send. If you aren't sure they want it sent, ask, and send only after a yes.
- Never send on your own: not to follow up, not to answer an agent for the person, not right after newWork.
- Send exactly what they asked to send, to the conversation they named, or the one on screen if they named none. If which conversation or what text is unclear, ask first. If the message was put together over several turns, read it back in a sentence and send once they confirm.
- To start new work with a message, call newWork, then sendMessage to the targetRef it returns once the person asks you to send.
- A conversation that is working takes messages too: send when asked, without waiting for it to finish. Only one waiting for the person (needsInput) can't take one.
- Pass model or effort only when the person asks to change them, using a name from getSessionContext's models. They change with a message: there is no switch on its own. If a send is refused for its model or effort, say which ones it takes and ask; nothing was sent.
- "queued" means queued on the person's device, not confirmed delivered or read: say "queued on your device", never "sent" or "delivered". Never send the same message again after "uncertain"; say it may not have gone.

Rules:
- Only say something happened if its tool said so. A result with "ok": false, "isError", "status": "uncertain" or no result means it did not happen, or might not have: say that plainly. Never claim success after an error.
- Change the screen (openSession, goBack, goHome) only when the person asks to.
- openSession, goBack and sendMessage take the latest focusRevision you have seen: from the context, the newest focus event or the last tool result. If a tool says the screen changed, use the newest focusRevision before you retry.
- Updates need no answer of their own. Use what they say when the person asks, or when it bears on what you are saying.
- Times come as "ago" (say that) and "at" (the person's local time, for when they ask exactly).
- You cannot approve permissions or answer an agent's questions. When a conversation needs input, tell the person to answer it in the app.
- Don't read code, paths or long logs aloud. Summarise them.
```

First message: optional (for example "Hi, Happy here."). Language: auto.

### Client tools

Paste each object into the dashboard's client-tool JSON editor, or send them
through the agents API. Names, descriptions and parameters must stay exactly
as they are here: they are `CallTool` on iOS and Android, and an Android unit
test (`CallContextTest.theDocsHoldTheseToolsExactly`) fails if this page and
the code differ.

```json
{
  "type": "client",
  "name": "listSessions",
  "description": "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their targetRef, title, kind, status and parents (the titles of what each sits under). query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "A case-insensitive substring of the title; omit for all."
      },
      "cursor": {
        "type": "string",
        "description": "The nextCursor of the previous page; omit for the first."
      }
    },
    "required": []
  }
}
```

```json
{
  "type": "client",
  "name": "getSessionContext",
  "description": "Read one conversation: whether it is working or needs the person, and its last five turns, each the person's message and the agent's last words, or as much of the pair as there is; the person's latest message, if nothing has answered it yet, is the fifth (pendingUserMessage). On a team, who wrote each message (userBy, by). It doesn't open the conversation or change what you hear from.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": {
        "type": "string",
        "description": "A targetRef from the context or listSessions."
      }
    },
    "required": [
      "targetRef"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "openSession",
  "description": "Show a conversation on the person's screen. Like any conversation they open, it joins the four most recently visited, whose new replies you hear.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": {
        "type": "string",
        "description": "A targetRef from the context or listSessions."
      },
      "focusRevision": {
        "type": "integer",
        "description": "The latest focusRevision you have seen."
      }
    },
    "required": [
      "targetRef",
      "focusRevision"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "sendMessage",
  "description": "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). Call it only when the person has explicitly asked you to send it (\"send it\", \"send that to …\"), never because you think they would want it sent. A working agent takes it too, as the app's composer sends it. model and effort switch the conversation first, only when the person asked for that. It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": {
        "type": "string",
        "description": "A targetRef from the context or listSessions."
      },
      "text": {
        "type": "string",
        "description": "The person's message, exactly as they asked to send it."
      },
      "focusRevision": {
        "type": "integer",
        "description": "The latest focusRevision you have seen."
      },
      "model": {
        "type": "string",
        "description": "Only when the person asked for another model: its name or id, as getSessionContext lists them. It stays for the conversation's next messages."
      },
      "effort": {
        "type": "string",
        "description": "Only when the person asked for another effort: one of the model's efforts, as getSessionContext lists them."
      }
    },
    "required": [
      "targetRef",
      "text",
      "focusRevision"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "newWork",
  "description": "Start new work as the app's compose button does, without opening it or changing the screen: a task (what a new session or conversation is) or a bot, made on the computer by its first message. Nothing is sent: send that message with sendMessage to the targetRef this returns, only when the person asks you to send it. Until then it isn't listed; openSession shows it if the person asks to see it.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "task",
          "bot"
        ],
        "description": "task, unless the person asked for a bot."
      },
      "name": {
        "type": "string",
        "description": "The name the person gave it; omit for its first message to name it."
      }
    },
    "required": [
      "kind"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "goBack",
  "description": "Go back one screen, as the back button does: close what is open over the app, or leave the screen on top for the one under it. Refused at home, where there is nothing to go back to.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "focusRevision": {
        "type": "integer",
        "description": "The latest focusRevision you have seen."
      }
    },
    "required": [
      "focusRevision"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "goHome",
  "description": "Go to the home screen, the list of the person's bots, tasks and projects, closing every screen over it.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

What the phone answers (JSON in the tool result):

| Tool | Success | Refusal (`isError`) |
| --- | --- | --- |
| listSessions | `{"sessions":[{targetRef,title,kind,status,parents?}],"nextCursor"?}`; `kind` is `bot`, `task`, `subtask` or `conversation` | query or cursor not a string, a cursor it didn't give |
| getSessionContext | `{title,parents,working,needsInput,turns:[{user?,userBy?,assistant?,ended,error?,truncated?}],olderTurns,pendingUserMessage?:{text,by?,delivery?,truncated?}}` | no such conversation (or not listed now), can't be read now |
| openSession | `{"opened":true,"targetRef":…,"focusRevision":…}`, the revision the next step takes | stale focus, no such conversation, didn't open |
| listSessions (rows) | each row also `workspace?` and `lastActivity?:{ago,at}`, and the page `now` | |
| getSessionContext (more) | also `lastUserMessage?:{ago,at,by?}`, `lastAgentReply?`, `workspace?`, `model?:{id,name,effort}`, `models?:[{id,name,efforts}]` | |
| sendMessage | `{"status":"queued","targetRef":…,"delivery":"on the person's device, not confirmed delivered or read"}`, with `model` and `effort` when it switched them | `{"status":"uncertain",…}` after 8 s; stale focus; can't take a message; waits for the person; empty; over 8 KiB; call ended; a model or effort it doesn't offer, with the `models` it does (nothing is sent) |
| newWork | `{"started":true,"targetRef":…,"kind":"task"\|"bot","title":…,"sent":false}`; the screen and focus stay as they were | kind not `task` or `bot`; call ended |
| goBack | `{"home":…,"focusRevision":…,"title":…\|null,"parents"?,"targetRef"?}`: where it landed | stale focus; at home, nothing to go back to; an alert is open |
| goHome | `{"home":true,"focusRevision":…,"title":null}` | an alert is open (iOS) |

Refusals are `{"ok":false,"reason":…}`. An unknown tool name (the old
`setSessionWatch` included) is refused with `Unknown tool.` and nothing runs.
Arguments are checked against the schema: `focusRevision` must be a JSON
integer (a string, fraction, boolean or null is a stale refusal), `text` and
`targetRef` strings. `sendMessage` leaves the conversation's draft alone,
doesn't open it, and doesn't make the call hear from it. A conversation that
is working takes it as the composer's send does (the agent steers or takes
it next); only one waiting for the person (a question or a review) refuses
it, because there the composer's words would answer the question.

`model` and `effort` are matched as said aloud (any case, letters and digits
only: "gpt 5.2 codex" is `gpt-5.2-codex`), by id or name, and a name part
that fits one model alone ("sonnet") will do. They switch the conversation
the way the composer's pickers do (iOS `ModelCatalog.select`, Android
`ModeCatalog.pick`, then `Conversation.setMode`): another model on the first
shown account that offers it, at the effort asked for or the model's own
default, and its screen's chips show it at once. The switch stays for the
conversation's next messages, as a pick does.

**New work** (`newWork`) is compose's own (iOS `NewTask`, Android
`NewTask`), chosen as a task or a bot and named, started off screen: no
screen opens and the focus stays where it was. Its conversation is the
call's (on Android the connection's one of its agent, held by the call).
Nothing is made and nothing sent: its first message, sent with
`sendMessage` to the `targetRef` `newWork` gave, makes it on the computer
the way the composer's first send does, and the sidebar lists it from then
on under the same reference. Compose's own unsent work is left alone.
`openSession` shows it only when the person asks: before its first message
on compose's own screen, which takes it over (iOS) or shares its
conversation (Android). Compose opened by hand is reached too, by the ref a
`focus` gives. "A new session" is a task. Left unsent, it ends with the
call and never existed anywhere but the phone; a first message on its way
when the call ends is still made and delivered.

**Who wrote it.** On a team's computer several people may write in one
conversation. The computer records the member who wrote each of the
person's messages (`metadata.userId`, happy-agent 154d9b570) and names them
through `GET /v0/users`. Reads say who: `userBy` on a turn, `by` on
`pendingUserMessage` and on `lastUserMessage`. The one on the call is "the
person"; a member the computer doesn't name is "a teammate". Outside a team
nothing has an author and none of these appear. The phone asks for each
member's name once per call, in the read itself.

**Back and home** are the system's: `goBack` closes what is presented over
the app (iOS: a sheet's own stack goes back first; an alert is never
answered for the person) or pops the screen on top, and `goHome` closes
everything and pops to home's root (on a tablet, the sidebar with the
empty main panel). Both answer once the move is done, with the screen they
left as the new focus. The call's bar is a window of its own (iOS) or wraps
the navigation (Android), so it stays usable over every screen they lead
to. A send that got no
answer in time is `uncertain`; the same words to the same conversation again
go under the same message ID, so the conversation takes them once.

On Android the call reads and sends through the connection's one
conversation of each agent (`AgentSession.conversations`,
`HeldConversations`), the same instance its screen and home's preview hold:
made once by whichever comes first (`makeConversation`, with the
connection's keeper, references and read, and the process's typesetter), it
reads while any holder wants it, and is closed once the last lets go, after
any send still in hand. A send by voice shows on the open screen at once.
The call never marks a conversation read; only a screen that shows it does.

## Checking a real call

iOS, on a simulator, against the harness's fixture computer: real provider
and client tools, but nothing reaches a real task. This mirrors desktop's
live voice check (spoken prompts from `say`, with no microphone in use):

1. Build `HappyChatHarness` (Debug) for the simulator with the ID injected.
2. Write prompts with `say -o p.aiff "…"` and
   `afconvert -f WAVE -d LEF32@48000 -c 1 p.aiff prompt-1.wav`, numbered in
   order, into a directory in the app's container.
3. `xcrun simctl privacy <device> grant microphone <bundle>`, then launch with
   `SIMCTL_CHILD_HAPPY_CALL_TAP=1 SIMCTL_CHILD_HAPPY_CALL_DELAY=3` and the
   arguments `-screen split -agent -callLive <directory>`.

`CallLiveCheck` puts LiveKit in manual rendering mode, so no microphone is
ever opened. It plays each prompt once the agent has answered the previous
one, and writes `live.json` (transcript, tool calls, the context sent),
`input.wav` and `output.wav` to the app's Documents. Keep these runs short:
each one is a billed conversation.

With `-callLive`, the fixture computer has 60 extra "Fixture task N" rows
(enough for `listSessions` to page), a subtask under Ship the cache
("Measure the hit rate"), three turns in every conversation (the last with
commentary before its answer), and a reply streamed in pieces to each
message sent. For Release notes it sends a failure that ends the turn
instead. Ship the cache's first answer makes new work: a "New Task" that
is named "Benchmark the cache" 0.4 s later, so the directory's settling
shows (the agent should only ever hear the name). Every contextual update and tool call goes into `live.json` with its
text, size and time.

Android: `CallLiveDeviceCheck` on an emulator, with the ID passed to the
build as `HAPPY_CALL_AGENT_ID`. The person's turns are typed
(`-e prompts "first|second"`), so no microphone is used.
`aConversationsNewWordsReachTheCall` drives a conversation's new words
into a live call with no LLM step: three pieces of a reply as deltas with
one `final`, four more visits that drop it from the last four, nothing sent
while it is out, no replay when it is visited again and its next words
after that. It checks the agent said nothing unasked, then types one
question about what was said. It writes `incoming.txt` (each update's text
and size, tool calls, the transcript).

iOS opens: `-screen split -agent -callOpens` runs the call's
`SessionCallTargets.open` over home, three conversations and back, then
from Settings, and logs each stack it leaves (`[call] stack`), with no
provider.
