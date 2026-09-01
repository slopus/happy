# Paws Share

Publish complete Codex and Claude Code conversations as read-only Paws snapshots without a Paws account.

```bash
npx @wangjs-jacky/paws-share inspect --current --json
npx @wangjs-jacky/paws-share share --current --yes --json
```

The CLI uploads only a validated snapshot and resolved structured attachments. It stores a per-link management capability in `${PAWS_SHARE_HOME:-~/.paws-share}/shares.json` with owner-only permissions; the public URL and command output never contain that capability.

Manage links locally:

```bash
paws-share list --json
paws-share renew <public-id> --json
paws-share revoke <public-id> --json
paws-share install-skill --target all --json
```

Use `--source codex|claude-code --session /path/to/session.jsonl` when current-directory discovery is ambiguous. Public snapshots expire after 90 days unless renewed.
