# codex-pty

`codex-pty` runs the Codex CLI inside a PTY and emits a best-effort transcript derived from the VT100 screen.

It is intended to be run by Happy CLI (`happy codex-pty`), but can also be used standalone in JSONL mode.

## Prereqs

- `codex` installed and authenticated

## Modes

### Interactive (TTY)

When stdin and stdout are TTYs, `codex-pty` behaves like the normal Codex TUI (raw mode + passthrough).

### JSONL (non-TTY)

When stdin or stdout are not TTY, `codex-pty` switches to JSONL mode.

Input (stdin JSONL):

- `{ "type": "input", "text": "..." }`

- `{ "type": "raw", "bytes": [27] }`
- `{ "type": "shutdown" }`

Output (stdout JSONL):

- `{ "type": "transcript", "text": "..." }`

## Flags

- `--pty-cols <u16>` (default: 120)
- `--pty-rows <u16>` (default: 40)

## Notes

- Transcript extraction is heuristic; it may miss or duplicate content depending on Codex UI changes.
