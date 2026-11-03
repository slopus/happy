# Agent connection voice calls

The voice button on a Happy Agent connection's home (iOS, Android) starts a
call with a hosted ElevenLabs agent. The audio, the context the agent reads
and its four client tools all live on the phone. This is separate from the
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
  - RevenueCat's paywall, full-screen on a phone and laid out by RevenueCat,
    keeps its own window: `DialogBelowCallBar` moves that window below the
    bar while a call shows and drops its dim. Touches outside it reach the
    bar, and the paywall gets the whole screen back when the call ends. This
    needs Android 10; on 8 and 9 the paywall covers the bar.
  - Dims without covering: a centred card (`AlertDialog`, prompts) leaves
    the bar under its dim, where a tap dismisses the card. So does the link
    menu's `ModalBottomSheet`, whose few rows keep it well below the bar.
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

Paid voice for agent connections is not decided yet. Until it is, nothing
lifts the limit: no relay `pro` entitlement and no anonymous purchase
identity.

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
go. Settings, home, a sheet or the scanner in front change nothing: the four
stay. `listSessions`, `getSessionContext` and `sendMessage` never add one.
The phone keeps exactly those four conversations read for the call, and no
others.

**What a visited conversation says**, as contextual updates (JSON, one per
line, keys sorted):

- `{"event":"assistant_text","target":"s3","messageId":…,"delta":"…","final":false}`:
  the agent's words since the last update of that message, at most every
  0.5 s per conversation while it writes, and the rest at once when its run
  is over. There is no timer: a change after the half second carries what
  piled up. `final` is true once the message is complete; a message whose
  last words already went says so once, with an empty `delta`.
- `{"event":"assistant_text_reset","target":…,"messageId":…,"text":"…"}`:
  a message that was rewritten rather than added to (its words no longer
  start with what was sent). The whole message goes once, and deltas
  continue from it.
- `{"event":"session_error","target":…,"reason":"…"}`: a turn that an error
  ended (`reason` up to 1 KB). A turn the person stopped is no error.

Nothing else: no tool calls or results, no working, run, status or
needs-input changes, no messages of the person's, and no prompt asking the
agent to speak. A conversation's state is read on demand
(`getSessionContext`).

The first time the call sees a visited conversation, what is there already
counts as known and nothing is sent: history is never replayed. A reply
still being written at that moment is new, and goes from its start. One
that dropped out of the four and is visited again starts over the same way.
Each message streams at most 4 KB in total; past that it stops, with
`"truncated":true` once.

**Other updates:**

- `{"event":"focus","focusRevision":3,"targetRef":"s2"|null,"title":…}`: the
  screen in front changed. No history comes with it.
- `{"event":"directory","changed":[rows],"removed":[refs]}`: a conversation
  came, went or was renamed. A status change alone says nothing. A removed
  ref can't be used again this call.

**History** (the first snapshot's focus and `getSessionContext`): the last
two finished turns that answered or failed, each the person's message that
started it and the agent's final answer (the turn's copy text, never its
commentary or tool output), plus the person's latest message when no
finished turn answers it yet, labelled `pendingUserMessage`. Each text is
cut at 4 KB.

`queued` is not a receipt. A message the call sent that later fails to
reach the computer shows as `pendingUserMessage.delivery: "failed"` on the
next `getSessionContext`, and in the chat as any failed message does.
No update announces it.

**Sizes:** the first snapshot is capped at 32 KB (the older turn gives way,
then the directory's tail). Context that arrives before the call is live
waits, up to 32 KB. Past that it is let go whole rather than cut, since a
lost delta would leave a message with a hole in it, and replaced by one
resync (`CallContext.resync`, at most 16 KB): a `focus` event with the
current `focusRevision` and `"resync":true`, the errors the call told of,
and each message it streamed as an `assistant_text_reset` with its words so
far, the most recent first (`omitted` counts any that didn't fit). Per call, streamed words are bounded by
4 KB per message of the four visited conversations, but not in total: a
long call over busy conversations still grows the agent's context.
Debug builds count every update and tool result by size
(`CallProbe.sent`, `live.json`), so real calls can be measured.

## The hosted agent

Use a new, versioned agent. Leave the relay's agent (`sendMessageToSession`,
`processPermissionRequest`) as it is.

### Settings

- Authentication: off (public), for the reasons above.
- Overrides: none needed. The app sends no prompt, first message or
  language, only the one dynamic variable.
- Dynamic variable: `initialConversationContext` (a string). It holds a JSON
  snapshot of the directory, the conversation on screen with its last two
  turns, and `focusRevision`. It is limited to 32 KB.
- Client tools: exactly the four below, each with "Wait for response" on and
  a response timeout of 10 s or more. The phone answers within 8 s and says
  `uncertain` if a send is still in doubt at that point.
- System tools: `end_call` is fine. Don't add tools for permissions or
  questions. Those stay in the app.

### System prompt

```text
You are Happy, a voice companion for the person's coding agents on their
computer. You speak briefly and plainly: one or two sentences unless asked
for more.

What you know comes from {{initialConversationContext}} (JSON) and from
contextual updates during the call, each a JSON object with an "event":
focus, directory, assistant_text (new words of a conversation's agent, as a
delta), assistant_text_reset (a rewritten message, whole) and session_error.
You hear new replies only from the four conversations the person most
recently visited. Conversations are named by "targetRef" (s1, s2, ...). Use
those refs in tools, never titles.

Tools:
- listSessions: find conversations; query is a case-insensitive substring of
  the title.
- getSessionContext: read a conversation (its last two finished turns and
  any message still waiting for an answer) before you summarise it.
- openSession: show a conversation on the person's screen.
- sendMessage: send the person's words to a conversation's agent.

Rules:
- Only say something happened if its tool said so. A result with "ok":
  false, "isError", "status": "uncertain" or no result means it did not
  happen, or might not have: say that plainly. Never claim success after an
  error.
- sendMessage: send exactly what the person asked to send. If which
  conversation or what text is unclear, ask first. "queued" means queued on
  the person's device, not confirmed delivered or read: tell them "queued on
  your device", never "sent" or "delivered". Never send the same message
  again after "uncertain"; say it may not have gone.
- openSession and sendMessage take the latest focusRevision you have seen,
  from the context or the newest focus event. If a tool says the screen
  changed, use the newest focusRevision before you retry.
- Updates need no answer of their own. Use what they say when the person
  asks, or when it bears on what you are saying.
- You cannot approve permissions or answer an agent's questions. When a
  conversation needs input, tell the person to answer it in the app.
- Don't read code, paths or long logs aloud. Summarise them.
```

First message: optional (for example "Hi, Happy here."). Language: auto.

### Client tools

Paste each object into the dashboard's client-tool JSON editor, or send them
through the agents API. Names, descriptions and parameters must stay exactly
as they are here: they are `CallTool.summary` and `CallTool.parameters` on
iOS and `CallTool` on Android, and an Android unit test
(`CallContextTest.theDocsHoldTheseToolsExactly`) fails if this page and the
code differ.

```json
{
  "type": "client",
  "name": "listSessions",
  "description": "List the person's conversations (tasks, bots and chats) with their targetRef, title, kind and status. query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor.",
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
  "description": "Read one conversation: whether it is working or needs the person, its last two finished turns (the person's message and the agent's final answer), and the person's latest message if nothing has answered it yet. It doesn't open the conversation or change what you hear from.",
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
  "description": "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again.",
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

What the phone answers (JSON in the tool result):

| Tool | Success | Refusal (`isError`) |
| --- | --- | --- |
| listSessions | `{"sessions":[{targetRef,title,kind,status,project?}],"nextCursor"?}` | query or cursor not a string, a cursor it didn't give |
| getSessionContext | `{targetRef,title,kind,status,working,needsInput,turns:[{user?,assistant?,ended,error?,truncated?}],olderTurns,pendingUserMessage?:{text,delivery?,truncated?}}` | no such conversation, can't be read now |
| openSession | `{"opened":true,"targetRef":…,"focusRevision":…}`, the revision the next step takes | stale focus, no such conversation, didn't open |
| sendMessage | `{"status":"queued","targetRef":…,"delivery":"on the person's device, not confirmed delivered or read"}` | `{"status":"uncertain",…}` after 8 s; stale focus; can't take a message; waits for the person; empty; over 8 KiB; call ended |

Refusals are `{"ok":false,"reason":…}`. An unknown tool name (the old
`setSessionWatch` included) is refused with `Unknown tool.` and nothing runs.
Arguments are checked against the schema: `focusRevision` must be a JSON
integer (a string, fraction, boolean or null is a stale refusal), `text` and
`targetRef` strings. `sendMessage` leaves the conversation's draft alone,
doesn't open it, and doesn't make the call hear from it. A send that got no
answer in time is `uncertain`; the same words to the same conversation again
go under the same message ID, so the conversation takes them once.

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
(enough for `listSessions` to page), three turns in every conversation (the
last with commentary before its answer), and a reply streamed in pieces to
each message sent. For Release notes it sends a failure that ends the turn
instead. Every contextual update and tool call goes into `live.json` with its
text, size and time.

Android: `CallLiveDeviceCheck` on an emulator, with the ID passed to the
build as `HAPPY_CALL_AGENT_ID`. The person's turns are typed
(`-e prompts "first|second"`), so no microphone is used.
