/**
 * chat-tool-output-streaming Phase 3 — singleton mapping the currently
 * in-flight `mcp__happy__bash_stream` tool call to its session-level call
 * id. Multiple runners (claude/runClaude, acp/runAcp, codex/runCodex,
 * gemini/runGemini) all funnel through the same in-process MCP server
 * (`startHappyServer`), so the bash_stream MCP handler needs a single
 * place to look up "which call id should I attach my progress envelopes
 * to?" without per-runner wiring.
 *
 * Each runner's session-envelope emitter (sessionProtocolMapper for
 * Claude, AcpSessionManager for ACP, etc.) is responsible for calling
 * `setActiveBashStreamCall(callId)` when it emits the matching
 * tool-call-start envelope and `clearActiveBashStreamCall(callId)` when
 * it emits the tool-call-end. Last-in-wins on overlapping calls; the
 * registry stores at most one active call at a time, which matches how
 * Claude executes tool calls sequentially within a turn.
 */

let activeCallId: string | null = null;

export function setActiveBashStreamCall(callId: string): void {
  activeCallId = callId;
}

export function getActiveBashStreamCall(): string | null {
  return activeCallId;
}

export function clearActiveBashStreamCall(callId: string): void {
  if (activeCallId === callId) {
    activeCallId = null;
  }
}

/** Test-only — reset the registry between tests so cases don't leak. */
export function __resetBashStreamCallRegistry(): void {
  activeCallId = null;
}
