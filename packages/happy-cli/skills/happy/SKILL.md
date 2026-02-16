---
name: happy
description: Attach this Claude Code session to happy for mobile viewing
allowed-tools:
  - Bash(happy* attach *)
  - Bash(slaphappy attach *)
---

Attach the current Claude Code session to happy for mobile viewing and real-time sync.

The session ID for this session is: ${CLAUDE_SESSION_ID}

Determine the correct CLI binary name: check if the environment variable `HAPPY_CLI_BIN` is set. If set, use that value. Otherwise, default to `happy`.

Run the attach command with the session ID:

```
<CLI_BIN> attach ${CLAUDE_SESSION_ID}
```

Replace `<CLI_BIN>` with the resolved binary name (e.g. `happy`, `happy-debug`, or `slaphappy`).

After running, display the output to the user. If successful, inform the user that:
1. Their session history is now viewable on their phone via the happy app
2. New messages will sync automatically via the Stop hook
3. Messages sent from the phone are saved to happy-server (v1: not injected into Claude Code)
