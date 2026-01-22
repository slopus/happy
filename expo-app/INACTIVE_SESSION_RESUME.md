# Inactive Session Resume - Design Document

## Overview

This feature allows users to continue archived/inactive Happy sessions by typing a message directly in the session view. When a message is sent to an inactive session with a resumable agent, the system spawns a new daemon process that:
1. Reconnects to the SAME Happy session (preserving message history)
2. Resumes the underlying Claude/Codex agent using its stored session ID

## User Experience

### Before (Current Behavior)
- Inactive sessions show a grayed avatar and "last seen X ago"
- The input is always enabled, but sending a message does nothing useful
- User must create a new session to continue conversation

### After (New Behavior)
- Inactive sessions with resumable agents show an indicator: "↻ This session has ended. Sending a message will resume the conversation."
- User types and sends a message
- System automatically:
  1. Spawns a new Happy CLI process
  2. CLI connects to the existing session (reuses same session ID)
  3. CLI resumes the Claude/Codex agent
  4. Message is delivered to the agent
- Conversation continues seamlessly in the same session view

### Non-Resumable Sessions
- Sessions without `claudeSessionId`/`codexSessionId` in metadata
- Sessions with non-resumable agents (e.g., Gemini)
- These show: "This session has ended and cannot be resumed."
- Input is disabled or shows a disabled state

## Technical Architecture

### Flow Diagram

```
User views inactive session (session.active = false)
  ↓
User types message and presses send
  ↓
UI checks: canResumeSession(metadata)?
  ↓
┌─────────────────────────────────────────────┐
│ YES: Enqueue message as server-pending      │
│   - pending-enqueue (preserves history)     │
│   - then send "resume-session" RPC          │
│     (spawns agent, no message payload)      │
└─────────────────────────────────────────────┘
  ↓
Server receives "resume-session"
  ↓
Server extracts agentSessionId from metadata
  (claudeSessionId or codexSessionId)
  ↓
Server calls daemon RPC "spawn-happy-session" with:
  - directory (from session metadata)
  - agent (from session metadata)
  - resume (agentSessionId)
  - existingSessionId (Happy session ID to reuse)  <-- NEW
  ↓
Daemon spawns CLI:
  happy claude --resume <agentSessionId> --existing-session <happySessionId>
  ↓
CLI connects WebSocket to existing session
  (does NOT create new session)
  ↓
CLI updates session.active = true
  ↓
Agent pops pending message and delivers to agent
  ↓
Conversation continues in same session
```

### Key Changes Required

#### 1. happy (UI)

**SessionView.tsx**
- Detect inactive session state
- Show resume indicator when session is resumable
- On send, call `resumeSession()` instead of normal send

**utils/agentCapabilities.ts** (already exists)
- Add `canResumeSession(metadata)` helper
- Checks: agent is resumable AND has stored session ID

**sync/ops.ts**
- Add `resumeSession(sessionId, message)` operation
- Sends "resume-session" WebSocket event

#### 2. happy-server-light

**sessionUpdateHandler.ts**
- Add "resume-session" event handler
- Validates user owns session
- Extracts agent session ID from metadata
- Calls daemon RPC to spawn session
- Queues message for delivery

#### 3. happy-cli

**index.ts / runClaude.ts / runCodex.ts**
- Add `--existing-session <id>` flag
- When set, skip session creation
- Connect WebSocket to existing session ID
- Update session.active = true

**daemon/run.ts**
- Accept `existingSessionId` in spawn options
- Pass `--existing-session` flag to CLI

## Session ID Storage

Agent session IDs are already stored in session metadata:
- `claudeSessionId` - Set by Claude hook tracking
- `codexSessionId` - Set when Codex configures session

These are persisted when the session archives, so they're available for resume.

## Edge Cases

1. **Agent session expired/deleted**: Resume will fail gracefully, agent starts fresh
2. **Multiple resume attempts**: Only one CLI can be active per session
3. **Directory no longer exists**: Show error, suggest creating new session
4. **Machine offline**: Cannot resume, show machine offline indicator

## Security

- Only session owner can resume (verified via token)
- Resume uses same authentication as normal session access
- No new permissions required
