<!-- retro:managed:start -->
## Retro-Discovered Patterns

- Happy CLI remote→local mode switch: do NOT pass `signal: opts.abort` (AbortSignal) when switching from remote back to local mode. Let the local process finish and fully clean up before starting the remote process — don't use opts.abort to force-kill it.

**Why:** Aborting the local Claude Code process mid-cleanup leaves the terminal in a corrupted state: two cursor positions, garbled keystrokes that never recover until the entire happy+Claude Code combo is restarted. Root-caused in session 3cd3dc8a when a Mac Terminal (not iTerm2/Warp) reliably reproduced it. The fix is to sequence the transitions — let local complete cleanup then start remote.

**How to apply:** In `claudeLocalLauncher.ts` and mode-switch logic, remove AbortSignal handoff between local→remote transitions. Wait for full process cleanup before spawning the successor.

<!-- retro:managed:end -->
