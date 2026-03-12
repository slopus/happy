# Dev CLI Remote Rebuild Protocol

## The Problem

We develop happy-cli on WSL (eric-desktop / wsl-debian), but we're *using* the stock happy CLI to run Claude sessions. We can't rebuild and restart the dev CLI from within a Claude session because:

1. The session is running inside the CLI we'd be restarting
2. The `CLAUDECODE=1` env var poisons any daemon started from within a Claude session

## The Solution

Use **truenas-scale-debian-vm** (the mission-control host) to SSH into WSL and perform rebuilds + daemon restarts. The SSH session has a clean environment — no CLAUDECODE contamination. This box already has mission-control with all SSH keys, and can reach both WSL directly and the Windows host via PowerShell SSH.

## Machines Involved

- **wsl-debian** (10.23.7.50) — where the code lives, where the dev CLI runs
- **truenas-scale-debian-vm** (10.23.4.44) — the remote operator, mission-control home base
  - Mission-control: `/bulk-storage/repos/mission-control/`
  - SSH keys: `/bulk-storage/repos/mission-control/.keys/`
  - Has Claude Code + Happy installed
- **eric-desktop Windows** (10.23.4.100) — the Windows host running WSL, reachable via PowerShell SSH if needed

## SSH Access

```bash
# From truenas-scale-debian-vm — into WSL directly:
KEY=/bulk-storage/repos/mission-control/.keys/wsl-debian.key
ssh -i $KEY eric@10.23.7.50

# From truenas-scale-debian-vm — into Windows (PowerShell, for nuclear options):
KEY=/bulk-storage/repos/mission-control/.keys/truenas-scale-debian-vm.key
ssh -i $KEY eric@10.23.4.100
```

## Pre-flight: Sync the SSH Key

The `wsl-debian.key` was created on WSL (Mar 11) and may not be in the Debian VM's copy of mission-control yet. One-time sync:

```bash
# From WSL:
rsync -av ~/mission-control/.keys/wsl-debian.key* root@10.23.4.44:/bulk-storage/repos/mission-control/.keys/
```

## Workflow

### Phase 1: Code Changes (this chat, on WSL)

Eric works with Claude on happy-cli code changes in a normal session using the stock `happy` CLI. All edits happen in `/home/eric/happy-dev/packages/happy-cli/`.

When changes are ready to test, Eric (or Claude) writes a handoff file:

```
/home/eric/happy-dev/.dev-handoff/rebuild-request.md
```

### Phase 2: Rebuild (from truenas-scale-debian-vm, via SSH)

A Claude session on the Debian VM (or a script) picks up the request and SSHes into WSL:

```bash
NVM='export NVM_DIR=\$HOME/.nvm && source \$NVM_DIR/nvm.sh'
ssh -i $KEY eric@10.23.7.50 "bash -c '$NVM && cd /home/eric/happy-dev && bash packages/happy-cli/scripts/rebuild-dev.sh'"
```

**Important:** nvm isn't in PATH for non-interactive SSH. All remote commands must source nvm first.

This rebuilds the CLI and restarts the systemd daemon (clean env, no CLAUDECODE).

### Phase 3: Test (new chat on dev CLI)

Eric opens a new chat using `happy-dev` (the dev CLI). This runs the freshly built code. He tests whatever was changed, notes results.

### Phase 4: Report Back

Test results go into:

```
/home/eric/happy-dev/.dev-handoff/test-results.md
```

Eric switches back to the original stock-CLI chat and continues development.

## Handoff File Format

### rebuild-request.md

```markdown
---
status: pending | in-progress | done | failed
requested: 2026-03-12T14:30:00Z
completed: null
---

## What Changed
- Brief description of code changes

## What to Test
- Specific things to verify in a test chat

## Build Notes
- Any special instructions (e.g., "run yarn install first", "need new env var")
```

### test-results.md

```markdown
---
status: pending | done
tested: 2026-03-12T14:35:00Z
build_succeeded: true | false
---

## Build Output
<paste or summary of rebuild-dev.sh output>

## Test Results
- What worked
- What broke
- Error messages / logs

## Daemon Status
<output of: systemctl --user status happy-dev-daemon.service>
```

## Quick Reference Commands

```bash
# Setup (put these at the top of your session or script):
KEY=/bulk-storage/repos/mission-control/.keys/wsl-debian.key
NVM='export NVM_DIR=$HOME/.nvm && source $NVM_DIR/nvm.sh'

# Full rebuild + restart cycle:
ssh -i $KEY eric@10.23.7.50 "bash -c '$NVM && cd /home/eric/happy-dev && bash packages/happy-cli/scripts/rebuild-dev.sh'"

# Just check daemon status:
ssh -i $KEY eric@10.23.7.50 'systemctl --user status happy-dev-daemon.service'

# Read daemon logs:
ssh -i $KEY eric@10.23.7.50 'ls -t ~/.happy-dev/logs/*.log | head -1 | xargs tail -50'

# Read handoff request:
scp -i $KEY eric@10.23.7.50:/home/eric/happy-dev/.dev-handoff/rebuild-request.md ./

# Push test results back:
scp -i $KEY ./test-results.md eric@10.23.7.50:/home/eric/happy-dev/.dev-handoff/
```

## Systemd Gotcha

The `systemctl --user` commands require the user's systemd instance to be running. Over SSH this needs lingering enabled:

```bash
# One-time setup on WSL (run as eric):
loginctl enable-linger eric
```

Without this, `systemctl --user` won't work over SSH because the user manager won't be running.

## Alternative: No Systemd

If systemd is flaky in WSL, skip the service and just run the daemon directly via tmux:

```bash
ssh -i $KEY eric@10.23.7.50 'tmux new-session -d -s happy-dev-daemon "cd /home/eric/happy-dev && ./packages/happy-cli/bin/happy.mjs daemon start" 2>/dev/null; tmux ls'
```

To restart:
```bash
ssh -i $KEY eric@10.23.7.50 'tmux send-keys -t happy-dev-daemon C-c; sleep 2; tmux send-keys -t happy-dev-daemon "cd /home/eric/happy-dev && ./packages/happy-cli/bin/happy.mjs daemon start" Enter'
```

## What We Don't Get

- **Can't test the exact build we're editing in real-time.** There's always a rebuild step in between.
- **Two chat windows needed.** Stock CLI for development, dev CLI for testing.
- **Git state must be clean-ish.** The rebuild runs against whatever's on disk, not a specific commit.

## What We Do Get

- **Safe daemon restarts.** No CLAUDECODE poison, no broken sessions.
- **Rapid iteration.** Code change → SSH rebuild → new test chat. No manual steps beyond switching windows.
- **Full dev environment.** Test chat runs on the same machine with the same env vars, same server, same everything.
- **Audit trail.** Handoff files document what was changed and what was tested.
