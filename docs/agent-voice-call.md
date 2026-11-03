# Agent connection voice calls

The voice button on a Happy Agent connection's home (iOS, Android) starts a
call with a hosted ElevenLabs agent. The audio, the context the agent reads
and its five client tools all live on the phone. This is separate from the
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
replace or remove an earlier one.

- The initial `initialConversationContext`, capped at 32 KB.
- Contextual updates, one per change and not coalesced: `focus` and
  `resync` carry a conversation's body (up to 20 messages of up to 4 KB each,
  so up to about 80 KB, with no 32 KB cap). The others are `directory`,
  `user_message`, `assistant_text`, `run_started`, `run_finished`,
  `needs_input` and `message_removed`, for the conversations the call
  follows.
- While a followed agent is still writing, `assistant_text` with
  `final: false` goes out at most every 0.5 s. Each one repeats the whole
  text so far, so one long reply can add the same words dozens of times.
- Tool results: `getSessionContext` is up to 20 messages × 4 KB.
- Prompts (`sendUserMessage`: finished, couldn't send, needs the person),
  each of which also starts an LLM turn.

So the cost of a call grows with how long it runs and how busy the
conversations it follows are, with no upper limit. Capping each payload
would bound each piece, not the call. Bounding the call needs a real
budget: for example, a total number of context bytes per call, after which
the call stops following conversations and tells the person so. That
behaviour isn't decided yet. Debug builds count every update, prompt and
tool result by size (`CallProbe.sent`, `live.json`), so real calls can be
measured before choosing.

## The hosted agent

Use a new, versioned agent. Leave the relay's agent (`sendMessageToSession`,
`processPermissionRequest`) as it is.

### Settings

- Authentication: off (public), for the reasons above.
- Overrides: none needed. The app sends no prompt, first message or
  language, only the one dynamic variable.
- Dynamic variable: `initialConversationContext` (a string). It holds a JSON
  snapshot of the directory, the conversation on screen, and
  `focusRevision`. It is limited to 32 KB.
- Client tools: exactly the five below, each with "Wait for response" on and
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
directory, focus, user_message, assistant_text, run_started, run_finished,
needs_input, message_removed, resync. Conversations are named by
"targetRef" (s1, s2, ...). Use those refs in tools, never titles.

Tools:
- listSessions: find conversations (by words in their name).
- getSessionContext: read a conversation's latest messages before you
  summarise it.
- openSession: show a conversation on the person's screen.
- setSessionWatch: follow or stop following a conversation, so you hear when
  it finishes.
- sendMessage: send the person's words to a conversation's agent.

Rules:
- Only say something happened if its tool said so. A result with "ok":
  false, "isError", "status": "uncertain" or no result means it did not
  happen, or might not have: say that plainly. Never claim success after an
  error.
- sendMessage: send exactly what the person asked to send. If which
  conversation or what text is unclear, ask first. "queued" means it is on
  the phone and on its way, not that the agent has read it. Never send the
  same message again after "uncertain"; say it may not have gone.
- openSession and sendMessage take the focusRevision you last saw. If a
  tool says the screen changed, read the focus again before you retry.
- You cannot approve permissions or answer an agent's questions. When a
  conversation needs input, tell the person to answer it in the app.
- Don't read code, paths or long logs aloud. Summarise them.
```

First message: optional (for example "Hi, Happy here."). Language: auto.

### Client tools

Paste each object into the dashboard's client-tool JSON editor, or send them
through the agents API. Parameter names and types must stay exactly as they
are here. The phone's copies are `CallTool.parameters` (iOS) and
`CallTool` (Android).

```json
{
  "type": "client",
  "name": "listSessions",
  "description": "List the person's conversations (tasks, bots, chats) with their targetRef, title, kind and status. Page with nextCursor.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Words in the conversation's name, or empty for all." },
      "cursor": { "type": "string", "description": "The nextCursor of the previous page." }
    },
    "required": []
  }
}
```

```json
{
  "type": "client",
  "name": "getSessionContext",
  "description": "Read one conversation: status, whether it is working or needs the person, and its latest messages.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": { "type": "string", "description": "A targetRef from the context or listSessions." }
    },
    "required": ["targetRef"]
  }
}
```

```json
{
  "type": "client",
  "name": "openSession",
  "description": "Show a conversation on the person's screen.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": { "type": "string", "description": "The conversation to show on screen." },
      "focusRevision": { "type": "integer", "description": "The context's focusRevision this request was made under." }
    },
    "required": ["targetRef", "focusRevision"]
  }
}
```

```json
{
  "type": "client",
  "name": "setSessionWatch",
  "description": "Follow a conversation (hear its replies and when it finishes) or stop following it. At most 7 at once.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": { "type": "string", "description": "The conversation to follow, or stop following." },
      "enabled": { "type": "boolean", "description": "true to follow, false to stop." }
    },
    "required": ["targetRef", "enabled"]
  }
}
```

```json
{
  "type": "client",
  "name": "sendMessage",
  "description": "Send the person's message to a conversation's agent. Returns queued, uncertain, or an error with the reason.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "properties": {
      "targetRef": { "type": "string", "description": "The conversation to send to." },
      "text": { "type": "string", "description": "The person's message, exactly as they asked to send it." },
      "focusRevision": { "type": "integer", "description": "The context's focusRevision this request was made under." }
    },
    "required": ["targetRef", "text", "focusRevision"]
  }
}
```

What the phone answers (JSON in the tool result):

| Tool | Success | Refusal (`isError`) |
| --- | --- | --- |
| listSessions | `{"sessions":[{targetRef,title,kind,status}],"nextCursor"?}` | arguments not an object |
| getSessionContext | `{targetRef,title,kind,status,working,needsInput,writable,hasDraft,olderMessages,messages:[{id,role,text,final,at?,delivery?}]}` | `{"ok":false,"reason":…}` |
| openSession | `{"opened":true,"targetRef":…}` | stale focus, no such conversation, didn't open |
| setSessionWatch | `{"watching":[targetRef…]}` | more than 7 |
| sendMessage | `{"status":"queued","targetRef":…}` | `{"status":"uncertain",…}` after 8 s; stale focus; can't take a message; waits for the person; too long; call ended |

An unknown tool name is refused (`Unknown tool.`) and nothing runs.
Arguments are checked against the schema: `focusRevision` must be a JSON
integer (a string, fraction, boolean or null is a stale refusal) and
`enabled` a JSON boolean (anything else is refused and changes no watch).

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
