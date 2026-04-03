# Loop Introspection

How to inspect what the loop agents (Claude odd, Codex even) are doing.

## Loop logs (stdout)

`loop/logs/iteration-XX-YYYYMMDD-HHMMSS.log` — raw terminal output per iteration.

## Claude conversation history

JSONL files in `~/.claude/projects/-Users-kirilldubovitskiy-projects-happy--dev-worktree-happy-sync-refactor/`.

- List recent: `ls -lt ~/.claude/projects/-Users-kirilldubovitskiy-projects-happy--dev-worktree-happy-sync-refactor/*.jsonl | head -5`
- Read directly — each line is a JSON event with `type`, `sessionId`, tool calls, etc.
- Correlate to loop iteration: `rg 'Agent Loop Prompt' ~/.claude/projects/-Users-kirilldubovitskiy-projects-happy--dev-worktree-happy-sync-refactor/*.jsonl -l` finds sessions that ran the loop prompt.

## Codex conversation history

JSONL files in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

- List recent: `ls -lt ~/.codex/sessions/2026/03/$(date +%d)/ | head -5`
- Correlate: `rg 'Agent Loop Prompt' ~/.codex/sessions/2026/03/$(date +%d)/*.jsonl -l`

## Live inspection (running iteration)

- Stream stdout: `tail -f loop/logs/iteration-*.log` (latest file)
- Watch Claude JSONL grow: `ls -lt ~/.claude/projects/-Users-kirilldubovitskiy-projects-happy--dev-worktree-happy-sync-refactor/*.jsonl | head -1` then `tail -f <that file>`
- Watch Codex JSONL grow: `ls -lt ~/.codex/sessions/2026/03/$(date +%d)/ | head -1` then `tail -f <that file>`

## Quick triage

- Current task: `loop/state.md` → "Current Task" + "Blocked / Investigated"
- Failures: `grep -l 'FAIL\|Error\|timed out' loop/logs/iteration-*-$(date +%Y%m%d)*.log`
- Is it alive: `ps aux | grep -E 'loop/run|dangerously-skip-permissions|codex exec' | grep -v grep`
