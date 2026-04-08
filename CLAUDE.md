<!-- retro:managed:start -->
## Retro-Discovered Patterns

- Happy CLI remote→local mode switch must wait for full cleanup before starting local mode — do NOT use `signal opts.abort` to race the transition. The bug: when switching from remote back to local mode too quickly, two Claude Code processes could both write to the terminal's TTY, causing garbled input with two visible cursors. The fix was to let the local subprocess finish and cleanup completely before starting the remote subprocess. Confirmed fixed in session 3cd3dc8a.

**Why:** Race condition between two processes sharing the same TTY caused permanently garbled keyboard input until the happy process was restarted. Reproduced most reliably in macOS Terminal (less in iTerm2/Warp due to different PTY handling).

**How to apply:** When modifying the remote↔local mode switching logic in `packages/happy-cli/src/modules/`, never use abort signals to preemptively kill the local subprocess — always await its natural shutdown before spawning the next mode.

<!-- retro:managed:end -->
