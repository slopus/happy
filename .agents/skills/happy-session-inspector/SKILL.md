---
name: happy-session-inspector
description: Inspect the currently linked Happy account, decrypt recent Happy sessions and state, and search decrypted message payloads for harness-specific tool calls. Use for mobile sync archaeology and debugging what encrypted session content reaches the mobile app.
---

# Happy session inspector

Use the bundled read-only TypeScript script to inspect the Happy account linked on this machine. It talks to the normal Happy API, resolves each session's end-to-end encryption key locally, and decrypts metadata, agent state, and messages without modifying server state.

## Safety boundary

- Only inspect the account the local credential belongs to.
- Never print or copy `agent.key`, `access.key`, bearer tokens, account secrets, record encryption keys, or encrypted key bundles.
- Output is redacted by default. Use `--raw` only when the user explicitly asks to see exact decrypted payloads, and keep unrelated conversation content out of summaries.
- This is a read-only debugging skill. Do not send messages, stop sessions, archive sessions, or mutate account state.
- Keep captured output in `.context/` when it is too large for direct inspection. Do not commit captured session data.

## Authentication and key coverage

Start with the existing `~/.happy/access.key` and `~/.happy/sessions.json`. Modern CLI credentials authenticate API reads, while `sessions.json` contains the per-session keys retained for sessions created on this machine. This is enough to inspect locally covered sessions and does not require a QR login.

There are three encryption cases:

- Legacy `access.key` credentials contain the shared account secret and can decrypt legacy records plus unwrap modern account records.
- Modern `access.key` credentials contain a content public key and machine key. They can create sessions but cannot unwrap arbitrary session keys from other devices.
- `sessions.json` retains modern per-session keys locally for resume and inspection. Entries are pruned by the CLI after 14 days.

The separate `~/.happy/agent.key` contains the account secret and provides account-wide coverage, including sessions created elsewhere. Only offer to link it after the inspector reports unavailable sessions that are actually needed for the task. Linking is an explicit user-approved step from the repository root:

```bash
pnpm --filter happy-agent exec tsx src/index.ts auth login
```

The user must approve the displayed QR code in the mobile app. Never start this flow merely because `agent.key` is absent, and never try to derive, copy, or recover the account secret from another credential store.

`HAPPY_HOME_DIR` and `HAPPY_SERVER_URL` select a different local Happy profile or server when the user explicitly asks for one. `--credentials <path>` may select an existing account-linked credential file.

## Run the inspector

From the repository root, set the script path once:

```bash
INSPECTOR="$PWD/.agents/skills/happy-session-inspector/scripts/inspect-sessions.ts"
```

List the 20 newest non-archived sessions with decrypted metadata and current agent state:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR"
```

List only currently active sessions:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR" --active
```

Inspect one session by full ID or unambiguous prefix, including its 50 newest decrypted messages:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR" --session <id-or-prefix>
```

Change the session/message bounds:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR" --limit 20 --messages 150
```

Search recent sessions for specific tool-call payloads:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR" \
  --tools run_workflow,interrupt_agent,send_agent_message
```

Add `--raw` only when exact decrypted payload values are required for debugging:

```bash
pnpm --filter happy-agent exec tsx "$INSPECTOR" \
  --tools run_workflow,interrupt_agent,send_agent_message \
  --raw
```

Use `--include-archived` only when archived history is in scope. An explicit `--session` lookup may inspect an archived session without that flag.

## Archaeology workflow

1. Start with the default recent non-archived inventory.
2. Narrow with `--tools` or `--session`; do not dump every message from every session.
3. Compare exact decrypted envelopes with `packages/happy-app/sources/sync/typesRaw.ts`, then trace the normalized tool name through `packages/happy-app/sources/components/tools/knownTools.tsx` and `packages/happy-app/sources/utils/toolDisplay.ts`.
4. Separate producer and consumer issues. Keep canonical Happy Agent tool names and payload shapes intact. Product-specific titles, descriptions, and result semantics normally belong in Happy Agent's Happy sync mapper; recognition, presentation, and resilient fallback behavior belong in the mobile app.
5. Report payload shapes, counts, lifecycle mismatches, and UI consequences. Avoid reproducing unrelated message text.