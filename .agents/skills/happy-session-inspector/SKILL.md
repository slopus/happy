---
name: happy-session-inspector
description: Pull and decrypt recent sessions for the Happy account logged in on this machine.
---

# Happy session inspector

Run the bundled read-only script from the repository root. It uses the current `~/.happy` login and local session keys; never print credential or encryption-key files.

List the 20 newest non-archived sessions with decrypted metadata and state:

```bash
pnpm --filter happy-agent exec tsx "$PWD/.agents/skills/happy-session-inspector/scripts/inspect-sessions.ts"
```

Decrypt one session's messages by ID or unique prefix:

```bash
pnpm --filter happy-agent exec tsx "$PWD/.agents/skills/happy-session-inspector/scripts/inspect-sessions.ts" --session <id-or-prefix> --messages 100
```
