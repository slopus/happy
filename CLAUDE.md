<!-- retro:managed:start -->
## Retro-Discovered Patterns

- Happy CLI auto-resume (resuming a previous Claude Code session automatically on startup) was NOT intended for the CLI — it was meant only for the mobile app's 'resume inactive session' feature. If the CLI auto-resumes a prior session when started in a folder, that is a bug.

**Why:** Christian explicitly clarified in session 91d576fa: 'the auto resume was meant for the mobile app. That you can resume an inactive session. Not for the command line.'

**How to apply:** When implementing session-resume logic in happy-cli, only trigger auto-resume when explicitly requested via `--resume` flag or when the mobile app sends a resume RPC. Never auto-resume based on detecting a prior session in the working directory.
- Socket.IO `emitWithAck` calls in happy-cli MUST include a timeout: use `socket.timeout(10000).emitWithAck(...)` instead of `socket.emitWithAck(...)` directly.

**Why:** When the socket disconnects, bare `emitWithAck` returns a promise that never resolves, hanging the `backoff()` retry loop forever. The `backoff()` function only retries on thrown errors, not on hung promises. The server already uses `socket.timeout(30000).emitWithAck(...)` — the CLI must match this pattern. Bug was discovered in `apiSession.ts` (updateMetadata, updateAgentState) and `apiMachine.ts` (updateMachineMetadata, updateDaemonState).

**How to apply:** Any new `emitWithAck` in the CLI codebase must be wrapped with `socket.timeout(ms)` first. 10000ms (10s) is the established timeout value.
- Happy app voice mode session disambiguation: when multiple Claude Code sessions share the same folder, the voice assistant generates composite labels like 'happy — voice prompt fix' vs 'happy — gemini support'. The OpenAI Realtime system prompt must instruct the voice model to use these full composite labels when calling switchSession, not just the folder name.

**Why:** If the model sends just the folder name ('happy'), the resolution scoring sees a tie and returns null, causing an error. The tool description previously said 'use folder name' which caused consistent wrong-session switching.

**How to apply:** Tool descriptions for session-related tools must say 'use the full session label (e.g. happy — voice prompt fix)' not just 'folder name'. The `resolveSessionId` function uses scored matching — unique words from the summary score highest.

<!-- retro:managed:end -->
