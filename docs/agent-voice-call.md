# Agent connection voice calls

The voice button on a Happy Agent connection's home (iOS, Android) starts a
call with a hosted ElevenLabs agent. The audio, the system prompt, the
context the agent reads and its four client tools all live on the phone. This is separate from the
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

The ID is **never in code, tests or tracked config** (only this page names
the agents, under "The hosted agent", for whoever sets a build up). It is
injected at build time:

- iOS: `HAPPY_CALL_AGENT_V3_ID = agent_…` in
  `packages/happy-ios/Config/Call.local.xcconfig` (ignored by git),
  `HAPPY_CALL_AGENT_V3_ID=agent_…` on the `xcodebuild` command line, or
  `HAPPY_CALL_AGENT_V3_ID` in the build's environment. It reaches
  `Info.plist` as `HappyCallAgentID` and is read by
  `CallAgent.hostedAgentId`. (`Call.xcconfig` gives it no value of its own,
  which would hide the environment's.)
- Android: `HAPPY_CALL_AGENT_V3_ID` in the environment,
  `-Phappy.callAgentV3Id=agent_…`, or `happy.callAgentV3Id=agent_…` in
  `packages/happy-android/local.properties` (ignored). It becomes
  `BuildConfig.CALL_AGENT_ID`.

The setting is named for the tools the code calls. The App Store build
already shipped was built with `HAPPY_CALL_AGENT_ID` set to v2's agent and
calls v2's tools; this code calls v3's (below). The agent is fixed in each
build at build time and no server chooses it, so the shipped build keeps v2
whatever a later build sets. An old `Call.local.xcconfig` or
`local.properties` that still sets `HAPPY_CALL_AGENT_ID` or
`happy.callAgentId` to v2 is ignored by this code, so the build says voice
isn't set up rather than shipping a call whose tools the agent doesn't have.

Without an ID the button stays, and a tap says "Voice isn't set up for this
connection yet" without asking for the microphone, and nothing reaches
ElevenLabs. (Asked for a token, ElevenLabs answers an empty ID with 400
`invalid_agent_id`, none with 422, an unknown one with 404
`agent_not_found`, and any real agent, v2's too, with a token: only the
setting's name keeps v2 out.)

So a store build can't ship that way: every iOS Preview and Release build
and every Android `preview` and `release` build fails without an
`agent_…` ID. iOS checks the built `Info.plist` (the Happy target's last
build phase, "Require the voice agent"), Android `pre<Variant>Build`. A
build that ships nowhere sets `HAPPY_RELEASE_WITHOUT_CALL_AGENT=1` instead
and is warned; Android's CI does, for its `assembleRelease`. Debug builds
and tests never need the ID.

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
`navigate` to `happy://conversation/<ref>`, makes it the latest; the fifth
one back drops out and is let go. That `navigate` replaces a conversation
that is on top of the stack and
pushes over anything else (home, Settings), so a call that opens A, B and C
leaves one conversation over what was under the first, never a pile. Settings, home, a sheet or the scanner in front change nothing: the four
stay. `listConversations`, `readConversation` and `message` never add one.
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
of the call's own. The agent reads it whole once, in the first context, as
indented lines in the style Happy Agent's own tools list bots, tasks and
projects to its agents (`- name — details`):

```text
Conversations in the app, in the sidebar's order:
- Architect — bot, ref s1
- Release notes — task, ref s2
  - Fix cache race — subtask, ref s3
- App — project
  - Root chat — conversation, ref s4
  - Feature — workspace
    - Feature chat — conversation, ref s5
```

A project or a worktree is a line without a reference. Within 12 KB and
100 conversations; the rest are counted on its last line ("… and 40 more;
listConversations finds them by title."). One too deep for the lines goes with
what it sits under on a single line, cut to fit: `(under A > B > …)`.

**References are order keys.** A reference is `s` and a decimal
fractional order key, the kind happy-agent orders its tasks, subtasks,
projects and Surfaces by (`orderKeyBetween`, ported as `OrderKey` on both
phones). Compared as plain text, references sort in the sidebar's order:
`s4` < `s49` < `s5`. Every conversation the sidebar lists when the call
starts gets one at once, in its order, as short as the list allows: `s1`
to `s9` for up to nine conversations, else the fewest digits that hold
them, counted up from `s11` (or `s101`, …) and skipping any that ends in 0,
which no key does. A conversation that comes later gets a key above that
of the conversation before it in the sidebar and just below the next key
handed out (`orderKeyJustBefore`, as happy-agent places new work right
after a fixed row), so it sorts into its place without any other
reference changing: between `s4` and `s5` it is `s49`, the next there
`s48`, after the last `s9` it is `s91`, before the first `s1` it is
`s09`. Arrivals in one place, as new tasks at the top of the tasks, stay
at one more digit for eight of them, three more for the next 98. New work `message` starts has no place in the sidebar
yet: its reference is the key after every other, given in the answer.

A reference stays the conversation's for the whole call, through renames
and moves, and is never handed to another conversation. It reaches the
conversation while the sidebar lists it: one that went away (deleted,
archived, left) reaches nothing, and reaches it again, under the same
reference, if it comes back. A move keeps the reference, so a moved
conversation no longer sorts into its place; its update says where it sits
instead (`after`, below).

**What changes in the directory** reaches the agent as it happens, as one
silent update of just what changed, never the whole directory again
(`CallContext.directoryUpdate`):

```text
{"added":[{"after":"s1","kind":"task","ref":"s6","title":"Draft the release notes"},{"kind":"subtask","parents":["Release notes"],"ref":"s39","title":"Benchmark the cache"}],"event":"directory","removed":["s5"],"renamed":[{"ref":"s3","title":"Fix the cache race"}]}
```

That is, over the directory above: the task `message` started (`s6`, the
key after every other) now first among the tasks, a subtask that came
between `s3` and `s4`, Feature chat gone and Fix cache race renamed. Fix
cache race moved after Benchmark the cache would then read
`{"after":"s39","parents":["Release notes"],"ref":"s3"}` in `moved`.

- `added`: a conversation the sidebar lists that the agent's directory
  doesn't have (new work, a subtask, a project's conversation, or one that
  came back, under its old reference), with its `ref`, `title`, `kind` and
  `parents` (the titles it sits under, left out when none). Sorted by its
  reference it sits in its place; only when it doesn't (new work the call
  started before the sidebar had it, or one placed beside a moved one) it
  says `after`: the reference of the conversation it follows in the
  sidebar, `null` for the first.
- `removed`: the references of what went away.
- `renamed`: a conversation's new `title`.
- `moved`: a conversation that sits elsewhere now, by another order among
  the rest or under another parent: `after` and its `parents`, and its
  `kind` if that changed with it. What kept its order among the rest (the
  longest run of it) didn't move, so moving one conversation names that one.

Each list is in the sidebar's order (`removed` in the order the agent had
them). `removed`, `renamed` and `moved` are only of conversations the
agent has the reference of (from the first context, `listConversations`, a
tool's answer or an update); `added` is every new one. An update tells at
most 20 changes within 4 KB, `added` first, then `removed`, `renamed` and
`moved`; the rest are counted in `"more"`, for `listConversations` to
find. Changes settle for a second from the first one before they go
(`DirectorySettle`, `Limits.settle`), so a burst is one update: the "New
Task" compose makes and the name the computer gives it 0.4 s later go as
one `added` under its name. A status, an activity time or anything else
the directory doesn't show sends nothing. The phone watches the sidebar's
rows for this (iOS `SessionCallTargets.watchDirectory`, home's and the
spaces sidebar's; Android `AgentSession.feed`); new work `message` started
is `added` once the sidebar lists it, under the reference its answer gave,
usually with `after`, since that key was chosen before the sidebar placed
it.

A conversation the agent has no reference for yet (one past the first
context's 100, or past an update's 20) comes with its `ref` in the first
update about it, usually the `focus` when the person opens it; once the
agent has a conversation's reference, updates name it by title alone
again.

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
They carry its reference too (`"ref":"s3"`) when that leaves it unclear
(another conversation has the same title under the same parents, or it has
no name of its own yet: "New Task", "New Bot", "Untitled"), or the agent
has no reference for it yet. No message IDs, block indexes or the
computer's IDs reach the agent.

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
nothing. A piece longer than 8 KB (about 1,000 words) goes cut after a
whole word, ending `… (cut, N more words)`, with `"truncated":true`.
Android has no run on a row: there a turn's rows come together with its
end after them, so its words are of that run, and words with a step after
them (a tool call, a picture, more words, a failure, the end) are complete.

Nothing else (besides the directory's changes, above): no tool calls or
results, no working, run, status or needs-input changes, no messages of the
person's, and no prompt asking the agent to speak. A conversation's state is read on demand
(`readConversation`). Every update is silent: none starts a turn.

The first time the call sees a visited conversation, what is there already
counts as known and nothing is sent: history is never replayed. A reply
still being written at that moment is new, and goes whole once it is
complete. One that dropped out of the four and is visited again starts
over the same way.

**The focus.** `{"event":"focus","focusRevision":3,"title":"Fix cache race","parents":["Release notes"]}`,
or `"title":null` for home, Settings or anything else that isn't a
conversation: the screen in front changed. No history comes with it.

**The first context** (`initialConversationContext`) is plain text, no
JSON, in five parts separated by blank lines:

```text
Now: 2026-11-06T09:15:00+01:00 (the person's local time)
focusRevision: 0

On screen: Fix cache race — subtask, ref s3, under Release notes
Working: yes. Needs the person: no.
Last message from the person: 5 minutes ago (2026-11-06T09:10:00+01:00)
Last reply: 3 minutes ago (2026-11-06T09:12:00+01:00)
Model: Claude Opus 4.5, effort high
Models it can switch to:
- Claude Opus 4.5 — id claude-opus-4-5, efforts low, medium, high, max
- Claude Sonnet 4.5 — id claude-sonnet-4-5, efforts low, medium, high
Last turns, oldest first:
1. The person: Why does the cache race?
   Agent: Two writers share the lock …
2. Ada Lovelace: Fix it
   Ended in an error: …
Waiting for an answer, from the person:
   And add a test

Conversations in the app, in the sidebar's order:
- …

New work (message's to; listed nowhere until its first message makes it):
- new-task — a new task, the message its first
- new-bot — a new bot, the message its first
A name after a colon names it: new-bot:Release helper.

Destinations (navigate's to):
- happy://home — the home list
- happy://back — one screen back; refused at home
- happy://conversation/<ref> — that conversation on screen, such as happy://conversation/s1
```

"On screen" is the conversation in front with its reference (or `On
screen: no conversation (home, Settings or another screen).`), and what
`readConversation` reads of it, as lines, the models it can switch to
among them (the ones `message`'s `model` and `effort` take); nothing in the
context repeats the directory, and the tools' list is the prompt's alone.
The destinations are the only places `navigate` goes, listed as the new-work
refs are; nothing else in the app has a `happy://` address of the call's. A turn says who
wrote it on a team, its non-plain end (`Ended: steering`, `Ended in an
error: …`), and a text past its limit (8 KB for the agent's words, 2 KB for
the person's) cut after a whole word, ending `… (cut, N more words)`;
"Older turns aren't shown." when there are more.

**History** (`readConversation`, JSON): the conversation's `title` and
`parents`, `working`, `needsInput`, when the person last wrote there
(`lastUserMessage`, the newest message of theirs in what was read) and when
the agent last answered (`lastAgentReply`, the end of the newest run with
words), its `workspace` (the project and worktree headings it sits under,
`App / Feature`; a bot or task has a workspace of its own and none is
given, and the computer gives the phone no folder paths), its `model`
(`{id,name,effort}`, what its next message goes with), then the last five
turns, five in all. Never its reference, kind or status: the directory has
those. Each turn is the person's message that started it and the agent's
last words (the turn's copy text, never its commentary between steps, tool
output or words still streaming), or as much of that pair as there is: a
turn steered or stopped before an answer has only the person's message, one
with no message of the person's only the agent's words, one an error ended
its `error`. The person's latest message, when no finished turn answers it
yet, is the fifth, labelled `pendingUserMessage`, so then four finished
turns come with it. The agent's words are cut at 8 KB, about 1,000 words
(two pages), and the person's at 2 KB, each after a whole word, ending
`… (cut, N more words)`, with `"truncated":true` on the turn. The whole is
within 56 KB as it goes on the wire, counted with each character as escaped
in the call SDK's own JSON (`escapedSize`; a data channel message is at most
64 KB): the oldest turns give way, `olderTurns` says more exist, and the
newest stays whole. Five turns of 1,000 words of prose (about 6 KB each) all
fit. It also lists
the `models` the conversation can switch to (`[{id,name,efforts}]`, at most
30: the composer's model picker's, each shown account's switched-on models
less those it hides).

**Times** are a pair, `{"ago":"5 minutes ago","at":"2026-11-06T09:15:00+01:00"}`:
how long ago, as said aloud (`just now`, `a minute ago`, `N minutes ago`,
`an hour ago`, `N hours ago`, `yesterday`, `N days ago`), and when on the
phone's clock, with its offset, to the minute. `listConversations` gives each row
the sidebar's own time (`lastActivity`, when the row says it last did
something; the exact pair needs the transcript, so it is
`readConversation`'s), and `now` on the same clock.

`queued` is not a receipt. A message the call sent that later fails to
reach the computer shows as `pendingUserMessage.delivery: "failed"` on the
next `readConversation`, and in the chat as any failed message does.
No update announces it.

**Sizes:** the first context is capped at 32 KB of UTF-8 (the older turns
give way first, then the directory's tail, then the earlier calls' recap
below, and the newest turn only after that). Five turns of 1,000 words of prose (about 30 KB) fit; five replies
at their 8 KB limit don't, and then the older turns give way, the newest
stays whole and `readConversation` has the rest. Context that arrives before
the call is live waits, up to 32 KB. Past that it is let go whole rather
than cut, and replaced by one resync (`CallContext.resync`): a
`directory` event of what the sidebar changed since the first context
(within its own 4 KB), a `focus` event with the current `focusRevision`,
its `ref` and `"resync":true`, the errors the call told of, and each piece
it told, as told, the most recent first, those within 16 KB with the
directory's (`omitted` counts any that didn't fit). The first context is
the prompt's variable and is never lost, so the resync doesn't repeat the
directory. Per call, words are bounded by 8 KB per piece of the
four visited conversations, but not in total: a long call over busy
conversations still grows the agent's context. ElevenLabs documents no
size limit on a client tool's result or a contextual update (only the 64 KB
it cuts a tool's full payload to on its way to the client); each goes as one
LiveKit data channel message, which both SDKs take up to 64 KB (LiveKit
recommends 15 KB), so the read's 56 KB is the largest.
Debug builds count every update and tool result by size
(`CallProbe.sent`, `live.json`), so real calls can be measured.

## Earlier calls, cues and the end of a call

**Call history, on the phone only.** Each agent connection keeps what was
said aloud in its recent calls (`CallHistory` on both): the person's final
transcripts, the agent's words as corrected after an interruption (what was
actually heard), and how each call ended. It never keeps the first context,
contextual updates, tool calls, tool results or cues, and the agent's
greeting is skipped. It is a rolling list of the latest 30 slots, each a
person line, an agent line or an ending, each with its time; an ending
counts as a slot. A call nobody said anything in leaves nothing behind when
it ends plainly (the person's End, the agent's `end_call`, the app going to
the background); any other ending is kept. It is written after every slot.
iOS keeps it in the connection's own folder as `private/call-history.json`
(`OfflineCallHistoryStore`, complete file protection, excluded from
backup); Android beside the connection's cache, under `noBackupFilesDir`
(`AgentSessions.keptFile`). Removing the connection removes it. It is never
logged and goes nowhere but into the next call's first context.

**The recap.** The first context of the next call starts its conversation
part with the list, oldest first, times as said aloud:

```text
Previous voice conversation (earlier calls, oldest first):
- 3 minutes ago, the person: Remember the word pineapple.
- 3 minutes ago, you: Got it, pineapple.
- 2 minutes ago: the call dropped (connection lost)
```

Endings read as the recap says them (`CallEnding.said`): `the person ended
the call`, `you ended the call`, `the call restarted, carried over`, `the
call dropped (connection lost)`, `the call reached its one-hour limit and
ended`, `the call ended: the person's voice time ran out`, `the call ended
after a long silence`, `the call was cut off: the phone took the audio
(another call, or the audio route went)` and `the call ended when the app
left the screen`. The recap has its own budget of 8 KB within the first
context's 32 KB, each line cut at 1 KB, the oldest lines first to go
(`Older lines aren't shown.` says so). When the first context is still too
big, the older turns give way first, then the directory's tail, then the
recap's older lines (down to 512 bytes), and the newest turn last. The
prompt says to carry on naturally and never repeat an action just because
the recap shows it.

**Cues: the agent speaks first.** For a few moments the agent must speak
without the person saying anything. A contextual update can't do it: the
agent reads it and stays silent, and so it does after `user_activity`
(both tried live on v3, which has `turn_timeout` -1). A user message
does: the app sends `[app] ` and a JSON of facts (`CallConnection.cue`:
iOS `conversation.sendMessage`, Android `sendUserMessage`), and the agent
answers within about two seconds. The prompt says such a message is the
app's, never the person's, and how to answer each event in its own words;
the app sends no wording. A cue is never a history slot (history takes only
transcripts and the agent's words) and doesn't count as the person
speaking. `CallCues` decides when, every second, never while either side
is speaking:

| Event | When | The call then |
| --- | --- | --- |
| `{"event":"silence","endsIn":"about 2 minutes"}` | 180 s with nobody speaking | ends at 290 s unless the person speaks |
| `{"event":"call_ending","reason":"call_limit","in":"about 5 minutes","restart":true}` | 5 min before the one-call limit | ends 10 s before ElevenLabs' 3,600 s |
| `{"event":"call_ending","reason":"time_used","in":"about 2 minutes","restart":false}` | 2 min before the free 20 min run out, 5 min before the paid 5 h | ends when the time is used |

- Silence is the app's. ElevenLabs ends a call after 300 s of silence
  (`silence_end_call_timeout`, which the hosted agent must have at 300 s,
  ElevenLabs' most), and its clock restarts when the agent finishes
  speaking (measured on v3: a cue at 60 s, answered, moved its end from
  123 s to 187 s) and while the person's voice is heard. The app's clock
  restarts at the same moments: when the agent finishes, when the person's
  voice activity says they speak, and when their words are heard, so it
  always ends the call 10 s first. Voice, not only words: with a patient
  turn a long monologue has no transcript until it ends, and a clock fed
  only by transcripts warned at the person's first breath (a real call:
  the warning came 127 s into one turn). The agent's answer to the warning
  doesn't put the end off; the person speaking does. Muted time counts:
  ElevenLabs hears silence then too, so muted voice activity doesn't.
- When the person speaks after a warning, the warning is over: the agent
  gets the contextual update `{"event":"silence_over"}`, once per warning,
  sent with the other updates and never as a cue, so it doesn't answer it
  over the person. The prompt says not to bring the warning up again.
- At the one-call limit the agent offers a fresh call with this
  conversation carried over (`restart` is true when more than 60 s of voice
  time would be left past the limit). Voice time running out offers none.
- The agent never ends the call on a cue; the app does.

**Restart.** When the person agrees, the agent navigates to
`happy://call/restart` (no new tool: it is one more line of `navigate`'s
destinations in the first context, not in the tool's description). The app
answers `{"ok":true,"restarting":true,...}`, waits for the agent to finish
its few words (at most 12 s, or 4 s if it says nothing), ends the call with
a `restarted` slot and starts a new one at once; the new call's first
context has the recap. With too little time left it refuses and the call
ends as cued.

**A call that ends unasked.** A dropped connection, the one-call limit,
used-up voice time, silence or an error plays a short "call dropped"
sound, with no speech, and leaves an ending slot. The person's End, the
agent's `end_call` (its goodbye was heard), a restart, a phone
interruption and the app leaving the foreground play none.

- iOS: `CallDropSound`, a two-note falling tone, the app's completion
  chime turned down, played as a system sound
  (`AudioServicesPlaySystemSound`), which needs no audio session while the
  call's is torn down and is silent with the silent switch on.
- Android: `CallDropSound`, the system's call-drop tone
  (`ToneGenerator.TONE_CDMA_CALLDROP_LITE` on the system stream, 0.9 s),
  only when the ringer mode is normal.

The ended bar offers nothing to resume: it shows how the call ended, as
before.

## The hosted agent

Use a new, versioned agent. Leave the relay's agent (`sendMessageToSession`,
`processPermissionRequest`) as it is.

Two agents, one per tool contract. Builds take the ID from the build
setting above, never from the repo.

**"Happy Agent v2public"** (`agent_1301m6gbcnwtfsvvwsyzvjjjxdqn`) is what
the App Store build already shipped calls. It is **frozen**: never edit it
or its tools. Its four client tools (`sendMessage`, `listSessions`,
`getSessionContext`, `openSession`) were restored to the configuration that
build was submitted against, and its `tool_ids` are those four alone:

| Tool | ID |
| --- | --- |
| listSessions | `tool_1701m6ggnc2pf21rxphd5g201e5h` |
| getSessionContext | `tool_6501m6ggnh3afqgtx048kjn9mkcw` |
| openSession | `tool_3101m6ggnqjeepx920r2a7z972a5` |
| sendMessage | `tool_8201m6ggny4mef9b9y7m65ex4t4z` |

**"Happy Agent v3public"** (`agent_4801m6sgvwc9ffmvdz4x8evst1se`) is what
this code calls. It is a copy of v2 (the same dashboard prompt, LLM
`glm-52` and overrides: prompt and language on, `tool_ids` off), with
exactly these client tools, each its own workspace tool used by this agent
alone, and the system tools `end_call`, `language_detection` and
`skip_turn`:

| Tool | ID |
| --- | --- |
| listConversations | `tool_3801m6shq18nf7r9yrqaqdhcpd98` |
| readConversation | `tool_4701m6shq1k0ezv8nvenvjjrtwys` |
| message | `tool_8401m6shq22yekcaw8watrp77b2t` |
| navigate | `tool_7501m6shq2dcfp4tgqp8te1cth4x` |

`listConversations` is v2's `listSessions` with `ref` for `targetRef`;
`readConversation` is `getSessionContext`; `message` is `sendMessage` and
the retired `newWork` in one, with no `focusRevision` and `to` optional;
`navigate` is `openSession`, `goBack` and `goHome` in one. The tools v2
briefly had besides its four (`newWork`, `goBack`, `goHome`:
`tool_3001m6rcrfv2fkya66v4pkj9f55d`, `tool_1501m6rcrg9pex190mnpp2r3xm3j`,
`tool_1901m6rcrggffd3bkcxdhhtywbm3`) are attached to nothing. This code
answers every v2 name with `Unknown tool.`

A tool is edited in place (`PATCH /v1/convai/tools/{id}`, the
`convai_write` scope) and the change reaches every build that calls its
agent at once, so a change of contract is a new agent and a new build
setting, never an edit of the one a shipped build calls. A new tool is
created (`POST /v1/convai/tools`) and attached through the agent's
`conversation_config.agent.prompt.tool_ids`, which lists them all. As of
2026-11-06 v3's descriptions and parameters are the ones below, word for
word.

### Settings

- Authentication: off (public), for the reasons above.
- Overrides: **System prompt** on (Security → Overrides), and Language on
  if a language is ever chosen (both are on). The app sends the prompt below
  as the agent's prompt override on every call (`CallPrompt`), with the one
  dynamic variable; it sends no first message. ElevenLabs refuses a
  conversation whose override the agent doesn't allow.
- Dynamic variable: `initialConversationContext` (a string): the first
  context as plain text, above. It is limited to 32 KB.
- Silence: `silence_end_call_timeout` 300 s, ElevenLabs' most. The app
  warns at 180 s and ends the call at 290 s itself (`CallCues`).
- Client tools: the four below, each with "Wait for response" on and
  a response timeout of 10 s. The phone answers within 8 s and says
  `uncertain` if a send is still in doubt at that point.
- System tools: `end_call`, `language_detection` and `skip_turn`. Don't add tools for permissions or
  questions. Those stay in the app. The agent hanging up with it ends the
  call as the person tapping End does: no bar is left and nothing says it
  failed. Both SDKs answer `end_call` by ending the session themselves, with
  the person's reason (`DisconnectionReason.user`, `DisconnectionDetails.User`);
  Android also notes the tool's response, since the agent leaving the room
  can be heard first. Every other end the app didn't ask for (a dropped
  room, an error) still says the call ended with a problem.

### System prompt

The phones send this prompt themselves, as the agent's prompt override
(`CallPrompt.system` on iOS, `CallPrompt.SYSTEM` on Android, the same
words; unit tests on both fail if this block and the code differ). The
dashboard's own prompt, v2's copied into v3, is never what this code runs
on: it is still the relay's voice prompt (it names `messageClaudeCode` and
`processPermissionRequest`, which neither agent has), with its first message
"Hi, Happy here". Leave v2's as it is.

```text
You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more.

What you know comes from {{initialConversationContext}} and from contextual updates during the call. The initial context is plain text, given once at the start: the time and focusRevision, what you and the person said in earlier calls, the conversation on screen with its last turns and the models it can switch to, the conversations the person sees in the app as indented lines, each with its ref, the refs that start new work, and the destinations navigate takes. Updates are JSON objects with an "event": directory (the app's conversations changed since: added ones with their ref, title, kind and parents, removed refs, renamed ones with their new title, moved ones with where they sit now; more counts changes left out, which listConversations finds), focus (the conversation on screen, or a null title for home, Settings or anything else), assistant_text (a complete piece of a conversation's agent's words, whole; finishedTurn when it ended its turn) and session_error. A ref stays its conversation's for the whole call, and is an order key: sorted as text, refs give the app's order, so s49 sits between s4 and s5; one with "after" sits right after that ref instead. Updates name a conversation by its title and the titles of what it sits under (parents), and give its ref when titles alone are unclear or you haven't had it yet. You hear new replies only from the four conversations the person most recently visited. Use refs (such as s3 or s49) in tools, never titles. Titles like "New Task" are work that hasn't been named yet.

Tools:
- listConversations: find conversations, ones started since the call began too, with when each last did something; query is a case-insensitive substring of the title.
- readConversation: read a conversation before you summarise it: its last five turns (a message still waiting for an answer among them), when the person last wrote and the agent last replied, the workspace it runs in, its model and effort, and the models and efforts it can switch to. On a team, several people may write in one conversation: userBy and by say who wrote each message, "the person" being the one on this call.
- message: send words to a conversation's agent, or start new work with them. to is the conversation's ref, new-task or new-bot; leave it out for the conversation on screen.
- navigate: change the screen. to is one of the context's destinations: happy://home, happy://back, or happy://conversation/ followed by a ref, such as happy://conversation/s3. happy://call/restart restarts the call instead (see Cues).

Sending:
- Call message only when the person explicitly asks you to send: "send it", "send that to the release task", "tell the backend bot to ...". Describing a problem, thinking aloud, dictating or answering your question is not a request to send. If you aren't sure they want it sent, ask, and send only after a yes.
- Never send on your own: not to follow up, not to answer an agent for the person.
- Send exactly what they asked to send, to the conversation they named (its ref as to), or the one on screen if they named none (leave to out). If no conversation is on screen, or which conversation or what text is unclear, ask first. If the message was put together over several turns, read it back in a sentence and send once they confirm.
- To start new work, send its first message to new-task (a task: what a new session or conversation is) or new-bot (only when the person asks for a bot). When the person names it, add a colon and the name: new-bot:Release helper. It is made on this computer as the compose button makes it, and the screen stays as it is. The result's ref is its ref from then on, and a directory update adds it under that ref once the app lists it; show it only if the person asks to see it.
- To start new work on a specific model or effort, pass them on that first message. Without them it starts on the app's default, which the result names.
- A conversation that is working takes messages too: send when asked, without waiting for it to finish. Only one waiting for the person (needsInput) can't take one.
- Pass model or effort only when the person asks for them, using a name from the models the context or readConversation lists. They change with a message: there is no switch on its own. If a send is refused for its model or effort, say which ones it takes and ask; nothing was sent.
- "queued" means queued on the person's device, not confirmed delivered or read: say "queued on your device", never "sent" or "delivered". Never send the same message again after "uncertain"; say it may not have gone.

Earlier calls:
- The initial context's "Previous voice conversation" is what you and the person said aloud in recent calls, oldest first, with how long ago and where a call was cut off. Use it to carry on naturally. Never repeat an action (a message or a navigate) just because it appears there.

Cues:
- A message that starts with [app] is from the Happy app, never the person: don't answer it as theirs and don't read it out. It is JSON with an "event"; answer it aloud at once, briefly and in your own words:
  - silence: no one has spoken for a while, and the call ends in endsIn unless the person speaks. Say the call will end soon because it's quiet, and that next time you can pick up where you left off. Don't end the call yourself: the app ends it unless the person speaks.
  - call_ending: the call ends in "in". reason call_limit: one call can't run longer; time_used: the person's voice time is nearly used up. With restart true, offer to restart the call with this conversation carried over, and navigate to happy://call/restart only once the person says yes. With restart false, just say the call is ending soon and why; offer no restart. Either way, don't end the call yourself.
- The update silence_over means someone spoke after a silence warning: the call is no longer ending. Don't bring the warning up again; if asked, say the call goes on.

Rules:
- Only say something happened if its tool said so. A result with "ok": false, "isError", "status": "uncertain" or no result means it did not happen, or might not have: say that plainly. Never claim success after an error.
- Change the screen (navigate) only when the person asks to.
- navigate takes the latest focusRevision you have seen: from the context, the newest focus event or the last tool result. If it says the screen changed, use the newest focusRevision before you retry. message takes none.
- Updates need no answer of their own. Use what they say when the person asks, or when it bears on what you are saying.
- Times come as "ago" (say that) and "at" (the person's local time, for when they ask exactly).
- You cannot approve permissions or answer an agent's questions. When a conversation needs input, tell the person to answer it in the app.
- Don't read code, paths or long logs aloud. Summarise them.
```

First message: optional (for example "Hi, Happy here."). Language: auto.

### Client tools

v3's, as uploaded (ElevenLabs adds an empty `"description"` to each
`parameters` object, left out here). Names, descriptions and parameters
must stay exactly as they are here: they are `CallTool` on iOS and Android,
and unit tests on both (`theDocsHoldTheseToolsExactly`) fail if this page
and the code differ.

```json
{
  "type": "client",
  "name": "listConversations",
  "description": "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their ref, title, kind, status, parents and when each last did something. Use it to find conversations started or renamed since the call began. query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor.",
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
  "name": "readConversation",
  "description": "Read one conversation before you summarise it: whether it is working or needs the person, its last five turns, when the person last wrote and the agent last replied, its workspace, its model and effort and the ones it can switch to. On a team, who wrote each message. It doesn't open the conversation or change the screen.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "A conversation ref (s1, s2, ...) from the context or listConversations. Never a title."
      }
    },
    "required": [
      "ref"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "message",
  "description": "Send the person's words to a conversation's agent, or start new work with them as its first message. Call it only when the person has explicitly asked you to send (\"send it\", \"send that to ...\", \"tell the backend bot to ...\"), never because you think they would want it sent. A working agent takes it too. It doesn't change the screen. \"queued\" means queued on the person's device, not confirmed delivered; after \"uncertain\", never send it again.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "to": {
        "type": "string",
        "description": "Where to send: a conversation ref (s1, s2, ...) from the context or listConversations; new-task or new-bot to start new work, optionally named after a colon (new-bot:Release helper); omit for the conversation on screen."
      },
      "text": {
        "type": "string",
        "description": "The person's message, exactly as they asked to send it. At most 8 KiB of UTF-8."
      },
      "model": {
        "type": "string",
        "description": "Only when the person asked for a model: a name or id from the models in the context or readConversation. It stays for the conversation's next messages."
      },
      "effort": {
        "type": "string",
        "description": "Only when the person asked for an effort: one of that model's efforts, as the context or readConversation lists them."
      }
    },
    "required": [
      "text"
    ]
  }
}
```

```json
{
  "type": "client",
  "name": "navigate",
  "description": "Change what is on the person's screen, as tapping would. Only when the person asks. to is one of the destinations listed in the context: happy://home (the home list), happy://back (one screen back, refused at home), or happy://conversation/<ref> (show that conversation).",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "to": {
        "type": "string",
        "description": "A destination URL from the context's destinations, e.g. happy://home, happy://back or happy://conversation/s3."
      },
      "focusRevision": {
        "type": "integer",
        "description": "The latest focusRevision you have seen, from the context, the newest focus event or the last tool result. Copy it exactly; never guess or increment it."
      }
    },
    "required": [
      "to",
      "focusRevision"
    ]
  }
}
```

What the phone answers (JSON in the tool result):

| Tool | Success | Refusal (`isError`) |
| --- | --- | --- |
| listConversations | `{"conversations":[{ref,title,kind,status,parents?,workspace?,lastActivity?:{ago,at}}],"now","nextCursor"?}`; `kind` is `bot`, `task`, `subtask` or `conversation` | query or cursor not a string, a cursor it didn't give |
| readConversation | `{title,parents,working,needsInput,turns:[{user?,userBy?,assistant?,ended,error?,truncated?}],olderTurns,pendingUserMessage?:{text,by?,delivery?,truncated?}}`, also `lastUserMessage?:{ago,at,by?}`, `lastAgentReply?`, `workspace?`, `model?:{id,name,effort}`, `models?:[{id,name,efforts}]` | no such conversation (or not listed now), can't be read now, a new-work ref |
| message | `{"status":"queued","ref":…,"delivery":"on the person's device, not confirmed delivered or read"}`, with `model` and `effort` when it switched them, and the `title` when `to` was left out; to `new-task` or `new-bot` also `"started":"task"\|"bot"`, the `title`, the new work's own `ref`, and always the `model` and `effort` it starts on | `{"status":"uncertain",…}` after 8 s; no conversation on screen and no `to`; no such conversation; can't take a message; waits for the person; empty; over 8 KiB; call ended; a model or effort it doesn't offer, with the `models` it does (nothing is sent) |
| navigate to `happy://conversation/<ref>` | `{"opened":true,"ref":…,"focusRevision":…}`, the revision the next step takes | stale focus, no such conversation, a new-work ref, didn't open |
| navigate to `happy://back` | `{"home":…,"focusRevision":…,"title":…\|null,"parents"?,"ref"?}`: where it landed | stale focus; at home, nothing to go back to; an alert is open |
| navigate to `happy://home` | `{"home":true,"focusRevision":…,"title":null}` | an alert is open (iOS) |
| navigate anywhere else | never | `{"ok":false,"reason":"\"…\" isn't a destination. to is one of: …","destinations":["happy://home","happy://back","happy://conversation/<ref>"]}` |

Refusals are `{"ok":false,"reason":…}`. An unknown tool name (v2's four,
the retired `newWork`, `goBack` and `goHome`, the old `setSessionWatch`) is
refused with `Unknown tool.` and nothing runs. Arguments are checked against
the schema: `focusRevision` must be a JSON integer (a string, fraction,
boolean or null is a stale refusal), `text`, `to` and `ref` strings.
`navigate`'s `to` is matched in any case, a trailing slash allowed;
`happy://home` goes home whatever `focusRevision` says, since home is the
same from any screen, while `happy://back` and a conversation are refused
once the screen has changed since the agent's `focusRevision`.

`message` takes no `focusRevision`: it names where it goes, so the screen
moving doesn't redirect it. With `to` left out (or blank) it goes to the
conversation on screen when the tool runs, as the app has it then
(`CallTargets.focused`), and the answer names it (`title`); with no
conversation on screen (home, Settings, a sheet) it is refused with "No
conversation is on screen. Ask which one, then send with its ref as to."
It leaves the conversation's draft alone,
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

**New work** starts with one `message` to `new-task` or `new-bot`
(any case; `new-bot:Release helper` names it, the name compose's panel
takes, else the computer names it from its first message). The first
context lists both; `readConversation` and `navigate` refuse them, since
nothing exists yet. It is compose's own (iOS `NewTask`, Android
`NewTask`), started off screen: no screen opens and the focus stays where
it was. The phone makes its conversation, checks `model` and `effort`
against the computer's models as for any send, sets them on it the way
compose's pickers would before a first send (or leaves compose's default,
`ModelPreferences.startMode`), and sends the message, which makes the task
or bot on the computer the way the composer's first send does. On a model
or effort it doesn't offer or a refused send, nothing is
sent and nothing stays. The answer is the new work's own `ref`, the
one the sidebar lists it under once made; until then it is read and sent
to by it all the same, and `navigate` shows it once the computer has
it. Where it goes is where compose puts it from any screen: a top-level
task or bot on the call's computer, in no project, beside nothing. The
call is bound to the one connection its voice button was pressed on, so
with several computers there is nothing to choose: it is that one.
Compose's own unsent work is left alone. The same words to the same
new-work reference again, their answer unheard, reach the same new work
under the same message ID. Compose opened by hand is reached too, by the
ref a `focus` gives.

**Models and efforts, and where they live.** What new work starts on is
the person's model preferences on that computer (`happy-desktop.model.*`
user settings, shared by every device on it): the default model, the
default effort, the account picked last, and each model's effort and speed
as last used per account. Efforts are a model's own, so they differ by
model and by the account (provider) serving it; the call lists them per
model as the pickers do. Starting work, by voice too, records what it
started on as compose does (`sessionStarted`), so the next new session
follows it unless Settings say to start on the default.

**Who wrote it.** On a team's computer several people may write in one
conversation. The computer records the member who wrote each of the
person's messages (`metadata.userId`, happy-agent 154d9b570) and names them
through `GET /v0/users`. Reads say who: `userBy` on a turn, `by` on
`pendingUserMessage` and on `lastUserMessage`. The one on the call is "the
person"; a member the computer doesn't name is "a teammate". Outside a team
nothing has an author and none of these appear. The phone asks for each
member's name once per call, in the read itself.

**Back and home** are the system's: `happy://back` closes what is presented over
the app (iOS: a sheet's own stack goes back first; an alert is never
answered for the person) or pops the screen on top, and `happy://home` closes
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

## Voice touch: the call's moves, pressed as a finger would

When a tool moves the screen, the control a person would tap shows the tap
before the move happens. The control is never triggered: the light and the
press are drawn, then the call does the move itself (`VoiceTouch` on both
platforms).

| Tool | What is pressed |
|------|-----------------|
| navigate to `happy://conversation/<ref>` | the conversation's row on home's list (iPhone's home in front, the iPad's or tablet's sidebar) |
| navigate to `happy://back` | the top screen's back button; on iOS, a sheet's own back button, else its close (leading end) |
| navigate to `happy://home` | the same back button, or a sheet's close |
| message to `new-task`/`new-bot` | home's compose (iPhone's toolbar, the iPad's sidebar foot; Android's compose button) |

The light is the call bar's listening colours (#4338CA into #7C3AED),
faint over the control's own shape (its card's corners, the glass button's
circle, the FAB's 16 dp corners), and one band of them that crosses it
once, as a working row's title shimmers (`Shimmer`'s ramp: three widths,
the band its middle fifth). On a row it lies over the fill and under the
words. The press is the platform's: the row's highlight and iOS 26 glass's
swell (1.12) on iOS; the ripple, through the control's interaction source,
on Android.

Timing, from when the light starts: ramp in 150 ms, the band across by
550 ms, pressed at 600 ms, the move at 750 ms, then the light fades over
250 ms and the press lets go at 900 ms. A row not wholly on screen is first
scrolled to the middle of the list: on iOS a glide of 0.3 to 0.6 s by
distance; on Android `animateScrollToItem` (about 0.35 s). The light starts
once the list stands still. With Reduce Motion (iOS) or animations off
(Android's animator duration scale at 0), the row is moved at once, no band
sweeps and nothing swells: the light shows still and the platform
highlight presses. A move takes 0.8 to 2 s in all, well inside the 10 s
tool timeout. A message to a conversation that exists isn't delayed.

Nothing is drawn where the person can't see that control: a row while a
conversation covers home on a phone, compose away from home, a sheet
without a close of its own (iOS), or the tablet main panel's root, whose
back is the sidebar's toggle. The move still happens.

To see it: iOS `-screen split -agent -voiceTouch` (add `-reduceMotion`)
runs compose, a row far down, back, a row on screen, home and a sheet's
close, logging each (`[voice-touch]`). Android `VoiceTouchDeviceShots`
does the same over home's real list (`-e dark true` for dark).

## Checking a real call

iOS, on a simulator, against the harness's fixture computer: real provider
and client tools, but nothing reaches a real task. This mirrors desktop's
live voice check (spoken prompts from `say`, with no microphone in use):

1. Build `HappyChatHarness` (Debug) for the simulator with v3's ID injected
   (`HAPPY_CALL_AGENT_V3_ID`).
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
(enough for `listConversations` to page), a subtask under Ship the cache
("Measure the hit rate"), three turns in every conversation (the last with
commentary before its answer), and a reply streamed in pieces to each
message sent. For Release notes it sends a failure that ends the turn
instead. Ship the cache's first answer makes new work: a "New Task" that
is named "Benchmark the cache" 0.4 s later (the agent hears of it, by
that name, in one `directory` update). Every contextual update and tool call goes into `live.json` with its
text, size and time.

Android: `CallLiveDeviceCheck` on an emulator, with the ID passed to the
build as `HAPPY_CALL_AGENT_V3_ID`. The person's turns are typed
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
