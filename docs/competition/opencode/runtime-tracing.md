# OpenCode Runtime Tracing

Reviewed on 2026-03-21.

This is the protocol-level pass that the first writeup was missing.

The goal here was simple: run OpenCode from source, copy auth from the global
install into an isolated temp root, drive a real sample project, and only trust:

- exact request bodies sent to OpenCode
- exact JSON responses from OpenCode endpoints
- raw `/event` SSE logs from OpenCode
- OpenCode source code

For the Happy side of the comparison, this document only trusts Happy code.

## Setup That Was Actually Used

OpenCode source checkout:

- `../happy-adjacent/research/opencode`
- commit `2e0d5d230893dbddcefb35a02f53ff2e7a58e5d0`

Sample project:

- `/Users/kirilldubovitskiy/projects/happy/environments/lab-rat-todo-project`

Isolated runtime root:

- `/tmp/opencode-trace-dev.ptZAVJ`

Auth source and copy:

- source: `~/.local/share/opencode/auth.json`
- copied into:
  `/tmp/opencode-trace-dev.ptZAVJ/share/opencode/auth.json`
- only provider key present in the copied auth file was `openai`

Server command:

```bash
XDG_DATA_HOME=/tmp/opencode-trace-dev.ptZAVJ/share \
XDG_CACHE_HOME=/tmp/opencode-trace-dev.ptZAVJ/cache \
XDG_CONFIG_HOME=/tmp/opencode-trace-dev.ptZAVJ/config \
XDG_STATE_HOME=/tmp/opencode-trace-dev.ptZAVJ/state \
OPENCODE_CONFIG_DIR=/tmp/opencode-trace-dev.ptZAVJ/profile \
OPENCODE_DB=/tmp/opencode-trace-dev.ptZAVJ/share/opencode/opencode.db \
bun run --cwd packages/opencode --conditions=browser src/index.ts \
  serve --hostname 127.0.0.1 --port 4098 --print-logs --log-level DEBUG
```

Important source files behind that setup:

- `../happy-adjacent/research/opencode/packages/opencode/src/auth/index.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/server/server.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/server/routes/experimental.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/session/message-v2.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/session/prompt.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/tool/task.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/permission/index.ts`

## What Counts As “Real” Here

The useful protocol evidence is not one big hidden RPC envelope. It is spread
across four surfaces:

1. The request bodies we send to `POST /session/:id/prompt_async`
2. The persisted message rows from `GET /session/:id/message`
3. The live patch stream from `GET /event`
4. The control-plane responses such as `/path`, `/permission`,
   `/session/:id/children`, `/experimental/worktree`, and
   `/experimental/workspace`

That distinction matters for Happy. OpenCode does **not** have one single
append-only transcript stream that already contains everything the UI needs.
It has:

- stable message rows with typed parts
- live patch events against those rows
- first-class side-channel events for permissions and session state
- separate workspace/worktree routing outside the transcript

## Flow 0: Directory Routing, Worktree, Workspace, “Sandbox”

Before touching prompts, I verified how the server scopes requests.

The key routing input is the header:

```http
x-opencode-directory: /Users/kirilldubovitskiy/projects/happy/environments/lab-rat-todo-project
```

Real `GET /path` response:

```json
{
  "home": "/Users/kirilldubovitskiy",
  "state": "/tmp/opencode-trace-dev.ptZAVJ/state/opencode",
  "config": "/tmp/opencode-trace-dev.ptZAVJ/config/opencode",
  "worktree": "/Users/kirilldubovitskiy/projects/happy",
  "directory": "/Users/kirilldubovitskiy/projects/happy/environments/lab-rat-todo-project"
}
```

Real empty listings for the current project:

```json
GET /experimental/worktree -> []
GET /experimental/workspace -> []
```

What that means:

- project scoping is a request-routing concern, not a transcript concern
- the current project lives under a `worktree` root and a narrower `directory`
- worktrees and workspaces are explicit control-plane resources
- none of this shows up as transcript parts like `type: "sandbox"` or
  `type: "workspace"`

So when OpenCode product language says “sandbox”, the concrete implementation
here is mostly:

- directory scoping
- optional workspace routing
- optional git worktree management

It is **not** the same kind of OS/filesystem/network sandbox policy that Happy
already has code for in `packages/happy-cli/src/sandbox/config.ts`.

## Flow 1: Permission Ask Around `apply_patch`

This was the cleanest real trace because it exercised:

- user prompt creation
- assistant step lifecycle
- reasoning
- tool call
- permission request
- permission reply
- file edit side effects
- final assistant follow-up

### 1. Session creation

I created the session with an explicit edit permission rule that forces asks:

```json
POST /session
{
  "title": "trace permission ask",
  "permission": [
    {
      "permission": "edit",
      "pattern": "*",
      "action": "ask"
    }
  ]
}
```

### 2. Prompt body sent

```json
POST /session/{sessionID}/prompt_async
{
  "agent": "build",
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5.4-mini"
  },
  "parts": [
    {
      "type": "text",
      "text": "Create a new file named TRACE_PERMISSION.md in the current directory with exactly one line: rat permission trace. Then reply with one short sentence."
    }
  ]
}
```

### 3. User message persisted

```json
{
  "info": {
    "role": "user",
    "id": "msg_d0f8263b50016s8bKlZ36Te52c",
    "sessionID": "ses_2f07d9c71ffeikGiLoOKqF2Evb"
  },
  "parts": [
    {
      "type": "text",
      "text": "Create a new file named TRACE_PERMISSION.md in the current directory with exactly one line: rat permission trace. Then reply with one short sentence."
    }
  ]
}
```

### 4. Live permission event

Real SSE event:

```json
{
  "type": "permission.asked",
  "properties": {
    "id": "per_d0f826ef60011FReJ16cM2d0MK",
    "sessionID": "ses_2f07d9c71ffeikGiLoOKqF2Evb",
    "permission": "edit",
    "patterns": [
      "environments/lab-rat-todo-project/TRACE_PERMISSION.md"
    ],
    "always": ["*"],
    "tool": {
      "messageID": "msg_d0f8263b9001UcnDrNrnbyYeyT",
      "callID": "call_uJj6gIQfIPpSoBV9oOWBT7cF"
    },
    "metadata": {
      "filepath": "environments/lab-rat-todo-project/TRACE_PERMISSION.md",
      "files": [
        {
          "relativePath": "environments/lab-rat-todo-project/TRACE_PERMISSION.md",
          "type": "add",
          "after": "rat permission trace\n",
          "additions": 1,
          "deletions": 0
        }
      ]
    }
  }
}
```

This is important. OpenCode permission is not just “tool X wants approval”.
The request carries:

- the permission kind
- exact path patterns
- a stable request id
- linkage back to the tool call
- a ready-to-render diff payload

### 5. Assistant message around the tool call

Persisted assistant message after approval:

```json
{
  "info": {
    "role": "assistant",
    "finish": "tool-calls",
    "id": "msg_d0f8263b9001UcnDrNrnbyYeyT"
  },
  "parts": [
    { "type": "step-start", "snapshot": "dfd3f0873ec51c2ddbf0b6b79acc154e5ab15c5d" },
    {
      "type": "reasoning",
      "text": "**Creating a file**\n\nI need to create a file...",
      "metadata": {
        "openai": {
          "itemId": "rs_...",
          "reasoningEncryptedContent": "gAAAAA..."
        }
      }
    },
    {
      "type": "tool",
      "callID": "call_uJj6gIQfIPpSoBV9oOWBT7cF",
      "tool": "apply_patch",
      "state": {
        "status": "completed",
        "input": {
          "patchText": "*** Begin Patch\n*** Add File: TRACE_PERMISSION.md\n+rat permission trace\n*** End Patch"
        },
        "output": "Success. Updated the following files:\nA environments/lab-rat-todo-project/TRACE_PERMISSION.md"
      }
    },
    { "type": "step-finish", "reason": "tool-calls" }
  ]
}
```

Then OpenCode emitted a second assistant message with the final visible text:

```json
{
  "info": {
    "role": "assistant",
    "finish": "stop"
  },
  "parts": [
    { "type": "step-start" },
    { "type": "text", "text": "Done." },
    { "type": "step-finish", "reason": "stop" }
  ]
}
```

### 6. The live event sequence actually seen

The raw SSE stream showed this order:

1. `session.created`
2. `message.updated` for the user message
3. `message.part.updated` for the user `text` part
4. `session.status` -> `busy`
5. `message.updated` for the assistant message shell
6. `message.part.updated` -> `step-start`
7. `message.part.updated` -> `reasoning`
8. many `message.part.delta` chunks streaming the reasoning text
9. `message.part.updated` -> tool part with `status: "pending"`
10. `permission.asked`
11. `permission.replied`
12. `file.edited`
13. `file.watcher.updated`
14. `message.part.updated` -> tool part `status: "running"`
15. `message.part.updated` -> tool part `status: "completed"`
16. `message.part.updated` -> `step-finish`
17. second assistant message with final `text`
18. `session.status` -> `idle`

The file really was created on disk:

```text
TRACE_PERMISSION.md: rat permission trace
```

## Flow 2: Media Input Failure Path

The failure case is useful because it shows what OpenCode stores before the
provider rejects the request.

### 1. Prompt body sent

```json
{
  "agent": "build",
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5.4-mini"
  },
  "parts": [
    {
      "type": "text",
      "text": "Describe the attached image in one short sentence. Do not use any tools."
    },
    {
      "type": "file",
      "mime": "image/png",
      "filename": "tiny.png",
      "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII="
    }
  ]
}
```

### 2. User message persisted

```json
{
  "info": { "role": "user" },
  "parts": [
    {
      "type": "text",
      "text": "Describe the attached image in one short sentence. Do not use any tools."
    },
    {
      "type": "file",
      "mime": "image/png",
      "filename": "tiny.png",
      "url": "data:image/png;base64,iVBORw0K..."
    }
  ]
}
```

### 3. Assistant error persisted

```json
{
  "info": {
    "role": "assistant",
    "error": {
      "name": "APIError",
      "data": {
        "message": "The image data you provided does not represent a valid image. Please check your input and try again.",
        "statusCode": 400,
        "isRetryable": false,
        "metadata": {
          "url": "https://api.openai.com/v1/responses"
        }
      }
    }
  },
  "parts": []
}
```

The live stream also emitted `session.error`.

This is a good example of OpenCode being honest: it stores the user-side file
part exactly as sent, and the failure becomes assistant/session error state
instead of getting normalized away.

## Flow 3: Media Input Success Path

The successful media path looked different because the input URL was a local
`file://...` URL, which OpenCode resolved itself.

### 1. Prompt body sent

```json
{
  "agent": "build",
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5.4-mini"
  },
  "parts": [
    {
      "type": "text",
      "text": "Describe the attached image in one short sentence. Do not use any tools."
    },
    {
      "type": "file",
      "mime": "image/png",
      "filename": "logo.png",
      "url": "file:///Users/kirilldubovitskiy/projects/happy/logo.png"
    }
  ]
}
```

### 2. User message persisted after OpenCode normalized it

```json
{
  "info": { "role": "user" },
  "parts": [
    {
      "type": "text",
      "text": "Describe the attached image in one short sentence. Do not use any tools."
    },
    {
      "type": "text",
      "synthetic": true,
      "text": "Called the Read tool with the following input: {\"filePath\":\"/Users/kirilldubovitskiy/projects/happy/logo.png\"}"
    },
    {
      "type": "file",
      "mime": "image/png",
      "filename": "logo.png",
      "url": "data:image/png;base64,iVBORw0K..."
    }
  ]
}
```

That is a real behavior from `session/prompt.ts`: OpenCode injects a synthetic
text part describing the read, then stores the media itself as a `file` part.

### 3. Assistant response persisted

```json
{
  "info": {
    "role": "assistant",
    "finish": "stop"
  },
  "parts": [
    { "type": "step-start" },
    {
      "type": "reasoning",
      "text": "",
      "metadata": {
        "openai": {
          "itemId": "rs_...",
          "reasoningEncryptedContent": "gAAAAA..."
        }
      }
    },
    {
      "type": "text",
      "text": "A cute cartoon otter is lounging in water while using a laptop."
    },
    { "type": "step-finish", "reason": "stop" }
  ]
}
```

### 4. What the live stream proves

The `/event` log showed:

- `message.part.updated` for the synthetic read text
- `message.part.updated` for the `file` part
- reasoning creation
- streamed `message.part.delta` chunks for the assistant text
- `session.status` returning to `idle`

So the real media story is:

- user-facing prompt part: `type: "file"`
- internal transcript expansion: synthetic `text` plus concrete `file`
- assistant-side answer: ordinary text output

## Flow 4: Subtask / Child Session / Permission Constraining

This was the most important trace for side-by-side comparison with Happy.

### 1. Prompt body sent

```json
{
  "agent": "build",
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5.4-mini"
  },
  "parts": [
    {
      "type": "text",
      "text": "Find the main files in this tiny project and report back briefly."
    },
    {
      "type": "agent",
      "name": "explore"
    }
  ]
}
```

### 2. User message persisted

OpenCode did **not** store just the raw `agent` part. It rewrote the user
message into:

```json
{
  "info": { "role": "user" },
  "parts": [
    {
      "type": "text",
      "text": "Find the main files in this tiny project and report back briefly."
    },
    {
      "type": "agent",
      "name": "explore"
    },
    {
      "type": "text",
      "synthetic": true,
      "text": " Use the above message and context to generate a prompt and call the task tool with subagent: explore"
    }
  ]
}
```

Again, this is a real `session/prompt.ts` behavior, not a guess.

### 3. Parent assistant message and `task` tool part

```json
{
  "info": {
    "role": "assistant",
    "finish": "tool-calls",
    "id": "msg_d0f855de2001b0RbgA3JGA5lzk"
  },
  "parts": [
    { "type": "step-start" },
    {
      "type": "reasoning",
      "text": "**Generating a task prompt**\n\nI need to call the task tool with the subagent explore..."
    },
    {
      "type": "tool",
      "callID": "call_OqUEr7ccnf3zEb2rgLYDp5uR",
      "tool": "task",
      "state": {
        "status": "completed",
        "input": {
          "description": "Find main project files",
          "prompt": "Inspect the repository and identify the main files in this tiny project. Focus on the key entry points, config files, and any top-level files that define how the project runs. Return a brief list of the most important files with one short note each about what they appear to do. Keep it concise and do not modify anything.",
          "subagent_type": "explore"
        },
        "output": "task_id: ses_2f07a8dd6ffeRc23sIIgM4ZpMT (for resuming to continue this task if needed)\n\n<task_result>\nMain files:\n\n- `.../index.html` ...\n- `.../app.js` ...\n- `.../styles.css` ...\n- `.../README.md` ...\n\nNo build/config files are present; it looks like a simple frontend-only static app.\n</task_result>",
        "metadata": {
          "sessionId": "ses_2f07a8dd6ffeRc23sIIgM4ZpMT",
          "model": {
            "modelID": "gpt-5.4-mini",
            "providerID": "openai"
          }
        }
      }
    },
    { "type": "step-finish", "reason": "tool-calls" }
  ]
}
```

Two key points:

- the parent transcript stores the `task` tool invocation and result
- resumability is by child session id, returned as `task_id`

### 4. Child session actually created

Real `GET /session/{parentID}/children` response:

```json
[
  {
    "id": "ses_2f07a8dd6ffeRc23sIIgM4ZpMT",
    "parentID": "ses_2f07aa25affeqiZHSnBiN8pSyG",
    "title": "Find main project files (@explore subagent)",
    "directory": "/Users/kirilldubovitskiy/projects/happy/environments/lab-rat-todo-project",
    "permission": [
      { "permission": "todowrite", "pattern": "*", "action": "deny" },
      { "permission": "todoread", "pattern": "*", "action": "deny" },
      { "permission": "task", "pattern": "*", "action": "deny" }
    ]
  }
]
```

This is the cleanest proof that OpenCode subagents are child sessions with
their own identity and their own permission rules.

### 5. Live stream across parent and child

The raw `/event` stream showed:

1. parent user message created
2. parent assistant `step-start`
3. parent reasoning deltas
4. parent `tool` part for `task` becomes `pending`
5. `session.created` for the child session
6. parent `tool` part becomes `running`
7. child user message appears in the child session
8. child assistant message starts
9. child reasoning deltas stream
10. child session reaches `idle`
11. parent `tool` part becomes `completed`

So OpenCode is not faking subagents inside one flat message lane. It uses:

- parent session transcript
- child session transcript
- parent tool metadata linking to the child session id

## Side By Side With Happy’s Current Code

This section uses only Happy code, not Happy runtime traces.

| Topic | OpenCode, proven by logs/code | Happy, proven by code |
|---|---|---|
| Outer envelope | message rows already have top-level `info` plus ordered typed `parts` | `packages/happy-wire/src/messages.ts` still wraps the newer format as `role: "session"` with inner `content: sessionEnvelope` |
| Event discriminant | parts use top-level `type` like `text`, `reasoning`, `tool`, `file`, `agent`, `subtask`, `step-start` | `packages/happy-wire/src/sessionProtocol.ts` still nests event type under `ev.t` |
| Permissions | live `permission.asked` and `permission.replied` events carry tool linkage and diff metadata | `packages/happy-app/sources/sync/reducer/reducer.ts` still reconstructs permission state by merging transcript-ish messages with encrypted `agentState` |
| Subagents | real child sessions with `parentID`; `task_id` is resumable child session id | `packages/happy-wire/src/sessionProtocol.ts` only has optional `subagent` on envelopes, not child-session identity plus transcript-level linkage |
| Media | user `file` part plus synthetic helper `text`; successful local files become concrete `data:` URLs | `packages/happy-wire/src/sessionProtocol.ts` only has one `file` event shape; plan doc proposes direct `photo` / `video` / `file` variants |
| Sandbox / isolation | routing is by directory/workspace and optional worktrees; “sandbox” is mostly worktree/workspace language | `packages/happy-cli/src/sandbox/config.ts` already has concrete filesystem allow/deny rules plus network modes |
| Client complexity | OpenCode reducers merge live patches into already-typed message rows | `packages/happy-app/sources/sync/typesRaw.ts` and `packages/happy-app/sources/sync/reducer/reducer.ts` still carry legacy families plus complex reconstruction logic |

The main conclusion is blunt:

- OpenCode has the cleaner transcript shape
- Happy has the stronger real sandbox config
- Happy’s current reducer complexity is the strongest argument against keeping
  multiple plaintext payload families alive

## What This Means For `provider-envelope-redesign.md`

Current planning context from `docs/plans/provider-envelope-redesign.md` still
looks right:

- the p6 envelope redesign work is in the dirty worktree, not committed branch
  history
- that work already proved useful cleanup moves:
  `type` at top level, no outer `role: "session"`, `parentId`/`agentId`,
  transcript permissions, direct media variants
- the current proposal in that plan doc is still the plan of record
- OpenCode raw protocol shape remains the strongest outside reference to
  evaluate before locking a new steady-state Happy schema
- Claude’s older transcript-like format is still a plausible fallback if the
  simplest stable model turns out to be closer to that history

OpenCode does **not** argue for copying ACP wrapper behavior. It argues for
copying the raw transcript shape:

- stable message rows
- typed parts
- explicit permission objects
- explicit child-session identity
- clear separation between transcript state and live patch transport

## The Hard Part For Happy: Encrypted Storage

This is where OpenCode and Happy diverge most.

OpenCode can happily keep canonical message rows and patch parts over time
because its storage layer sees plaintext session state.

Happy stores opaque encrypted blobs. That means copying OpenCode literally
forces a storage decision.

### Option A: Append-only canonical transcript events

Store already-normalized encrypted records that are durable on their own.

Example mental model:

```json
{ "kind": "agent-event", "type": "tool-start", ... }
{ "kind": "agent-event", "type": "permission-request", ... }
{ "kind": "agent-event", "type": "tool-end", ... }
```

Pros:

- keeps storage immutable
- refetch is simple
- matches Happy’s current transport assumptions
- avoids replaying raw deltas to rebuild a usable transcript

Cons:

- not a literal copy of OpenCode’s patching model
- either start/end events stay separate forever, or the client must derive
  “latest state” views for UI convenience

### Option B: Patch canonical encrypted message rows

Keep stable encrypted message ids, but rewrite the encrypted payload when parts
gain new state so refetch returns the newest canonical snapshot.

Example mental model:

```json
{
  "messageId": "msg_123",
  "parts": [
    { "type": "tool", "state": { "status": "pending" } }
  ]
}
```

Later rewritten as:

```json
{
  "messageId": "msg_123",
  "parts": [
    {
      "type": "tool",
      "state": {
        "status": "completed",
        "input": { ... },
        "output": "..."
      }
    }
  ]
}
```

Pros:

- closest to OpenCode’s server-side model
- refetch gives the latest canonical state directly
- fewer client-side reconstruction problems

Cons:

- encrypted message rows become mutable
- sync/versioning gets more delicate
- you lose pure append-only history unless you also keep a shadow event log

### Option C: Append raw patch events and reconstruct on the client

Store the raw stream and rebuild message state client-side.

Example mental model:

```json
{ "type": "message.updated", ... }
{ "type": "message.part.updated", ... }
{ "type": "message.part.delta", ... }
{ "type": "permission.asked", ... }
```

Pros:

- closest to the live OpenCode stream
- fully immutable if every patch is appended

Cons:

- this is exactly the direction most likely to recreate Happy’s current reducer
  pain
- refetch requires replay/materialization
- encrypted storage plus legacy format support makes this the highest-complexity
  option

### Recommendation

If Happy borrows from OpenCode, it should probably steal the **shape** but not
the entire persistence strategy.

The strongest options are:

1. append-only **canonical** events
2. patchable **canonical** message snapshots

The weakest option is:

- raw patch-stream reconstruction as the primary durable format

That would preserve too much of the complexity we are trying to get rid of.
