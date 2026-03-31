<!-- retro:managed:start -->
## Retro-Discovered Patterns

- In Happy CLI's Socket.IO client, always use `socket.timeout(10000).emitWithAck(...)` — NEVER bare `socket.emitWithAck(...)` without a timeout.

**Why:** When the socket disconnects, bare `emitWithAck` returns a promise that never resolves, hanging the `backoff()` retry loop indefinitely. This caused the CLI to silently stop syncing state after a network interruption without ever reconnecting. The server already used this pattern correctly; the CLI was missing it in 4 places (`updateMetadata`, `updateAgentState` in apiSession.ts; `updateMachineMetadata`, `updateDaemonState` in apiMachine.ts).
**How to apply:** Any new `emitWithAck` call in the CLI must include `.timeout(10000)` to allow the backoff retry loop to catch the error and retry.
- When Happy CLI switches from remote mode back to local mode, the handoff must be sequential — let local finish and cleanup completely before starting remote, with no abort signal interruption.

**Why:** Using an abort signal to interrupt local mode while starting remote creates a race condition that leaves two active cursors and a garbled terminal input state. The user described typed characters jumping to the middle of the input, producing nonsensical messages to the LLM. This was only reproducible in Mac Terminal (not iTerm2/Warp which handle PTY state differently).
**How to apply:** In the CLI mode-switch code, ensure local process is fully terminated and cleaned up before initiating remote connection. Do not use `opts.abort` or signal-based cancellation across the handoff.

<!-- retro:managed:end -->
