---
name: share-session
description: Inspect and publish local Codex or Claude Code conversations as complete, read-only Paws snapshots. Use when a user asks to share, publish, export, or create a public link for the current coding-agent session, including its structured attachments, or asks to list, query, replace, renew, or revoke links previously created with Paws Share.
---

# Share Session

Use the `paws-share` CLI as the only transcript parser, uploader, and capability manager. Do not parse provider JSONL, read `~/.paws-share/shares.json`, handle management tokens, or upload attachments yourself.

## Create a public link

1. Inspect the current session:

   ```bash
   paws-share inspect --current --json
   ```

2. Show the user the provider, title, message count, attachment count and bytes, unresolved attachment count, blocking secret count, privacy-warning count, and the 90-day public expiry policy.
3. Stop if the CLI reports an ambiguous session, an unresolved attachment, or a blocking secret. Resolve ambiguity with an explicit `--source` and `--session` path. Never guess which conversation to publish.
4. After the user explicitly requests the public link and accepts the disclosure, publish:

   ```bash
   paws-share share --current --yes --json
   ```

5. Return only `publicUrl`, `expiresAt`, and a short confirmation that the link is a read-only snapshot.

Never add `--allow-sensitive` merely to finish the task. Use it only after reporting the blocking findings and receiving a separate, explicit instruction to publish sensitive content. Do not claim success until the command returns `publicUrl`.

## Use an explicit transcript

When `--current` is ambiguous, run the same inspect-then-share sequence with one provider and one JSONL path:

```bash
paws-share inspect --source codex --session /path/to/session.jsonl --json
paws-share share --source codex --session /path/to/session.jsonl --yes --json
```

Use `--source claude-code` for Claude Code transcripts. Do not expose the local transcript path in the final response.

## Manage links

Use only the CLI so the local capability remains private:

```bash
paws-share list --json
paws-share status <public-id> --json
paws-share renew <public-id> --json
paws-share replace <public-id> --current --yes --json
paws-share revoke <public-id> --json
```

Revocation is terminal for that public link. Losing the local management record is intentionally unrecoverable without an account.
