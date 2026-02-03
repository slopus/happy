# Minimal Fix Plan for Happy-CLI Bugs with TDD
# Date: 2025-01-15
# Created by: Andrew Hundt
# Bugs: Session ID conflict + Server crash

## Overview
Two targeted fixes with concrete error messages and TDD tests to verify behavior.

## Bug 1: Session ID Conflict with --continue Flag

**Problem**: When running `./bin/happy.mjs --continue`, Claude CLI returns error:
```
Error: --session-id cannot be used with --continue or --resume
```

**Root Cause Analysis**:
- This is a Claude Code 2.0.64+ design constraint, NOT a happy-cli bug
- Happy-CLI generates a NEW session ID and adds `--session-id <uuid>` for all local sessions
- When user passes `--continue`, Claude Code sees: `--continue --session-id <uuid>` → REJECTS
- The conflict occurs ONLY in local mode (claudeLocal.ts), not remote mode

**Two Different Pathways**:

1. **Local Mode (Path with conflict)**:
   ```
   user: happy --continue
   → index.ts (claudeArgs = ["--continue"])
   → runClaude.ts
   → loop.ts
   → claudeLocalLauncher.ts
   → claudeLocal.ts
   ├─ Generates NEW session ID
   ├─ Adds --session-id <new-id>
   └─ Claude sees both flags → ERROR
   ```

2. **Remote Mode (No conflict)**:
   ```
   user: happy --continue
   → ... → claudeRemote.ts → SDK query.ts
   → SDK passes --continue to Claude
   → No --session-id added by happy-cli
   → Works fine
   ```

**Claude Session File Analysis**:

- Claude creates session files at: `~/.claude/projects/{project-id}/`
- Format: `{session-id}.jsonl` with UUID or agent-* IDs
- `--continue` creates NEW session with copied history
- `--resume {id}` continues EXISTING session with same ID
- Claude 2.0.64+ rejects `--session-id` with `--continue`/`--resume`

## Solution Approach Analysis

| Method | Description | Upsides | Downsides | Complexity | Risk |
|--------|-------------|---------|-----------|------------|------|
| **Convert --continue → --resume** | Find last valid session, convert flag | ✅ Exact --continue behavior<br>✅ Native Claude support<br>✅ Simple implementation | ❌ Needs session finding logic<br>❌ Fails if no sessions exist | Medium | Medium |
| Environment Variables | Set session ID via env var | ✅ Simple<br>✅ No file system deps | ❌ Non-obvious to users<br>❌ Hard to debug | Low | Low |
| Post-process Extraction | Run Claude, extract session ID from output | ✅ Always gets correct ID<br>✅ Works with any Claude version | ❌ Complex parsing<br>❌ Race conditions<br>❌ High complexity | High | High |
| Hybrid | Try --continue, fallback if fails | ✅ Minimal changes<br>✅ Graceful fallback | ❌ Inconsistent behavior<br>❌ Two code paths | Medium | Medium |

**Recommended Solution: Convert --continue to --resume**

This approach:
- Uses Claude's native --resume mechanism
- Maintains exact --continue behavior (new session with copied history)
- Transparent to users
- Works with existing session infrastructure

```typescript
// In claudeLocal.ts (around line 35, after startFrom initial check)

// Convert --continue to --resume with last session
if (!startFrom && opts.claudeArgs?.includes('--continue')) {
    const lastSession = claudeFindLastSession(opts.path);
    if (lastSession) {
        startFrom = lastSession;
        logger.debug(`[ClaudeLocal] Converting --continue to --resume ${lastSession}`);
    } else {
        logger.debug('[ClaudeLocal] No sessions found for --continue, creating new session');
    }
    // Remove --continue from claudeArgs since we're handling it
    opts.claudeArgs = opts.claudeArgs?.filter(arg => arg !== '--continue');
}

// Then existing logic:
if (startFrom) {
    args.push('--resume', startFrom);  // Will continue the found session
} else {
    args.push('--session-id', newSessionId!);  // New session
}
```

## Bug 2: Happy Server Unavailability Crash

**Problem**: Happy-CLI crashes when Happy API server is unreachable

**Server Details**:
- Default server: `https://api.cluster-fluster.com`
- Environment variable: `HAPPY_SERVER_URL` (overrides default)
- Local development: `http://localhost:3005`
- The server handles session management and real-time communication for Happy CLI

**Fixes with Clear Messages**:

1. **apiSession.ts** (line 152) - Socket connection failure:
```typescript
try {
    this.socket.connect();
} catch (error) {
    console.log('⚠️  Cannot connect to Happy server - continuing in local mode');
    logger.debug('[API] Socket connection failed:', error);
    // Don't throw - continue without socket
}
```

2. **api.ts** (catch block around line 75) - HTTP API failure:
```typescript
} catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.log('⚠️  Happy server unreachable - working in offline mode');
        return null; // Let caller handle fallback
    }
    throw error; // Re-throw other errors
}
```

## TDD Tests (Test-First Development)

### Test File 1: src/claude/claudeLocal.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claudeLocal } from './claudeLocal';

describe('claudeLocal --continue handling', () => {
    let mockSpawn: any;
    let onSessionFound: any;

    beforeEach(() => {
        mockSpawn = vi.fn();
        vi.mock('child_process', () => ({
            spawn: mockSpawn
        }));
        onSessionFound = vi.fn();
        mockSpawn.mockReturnValue({
            stdio: [null, null, null, null],
            on: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            on: vi.fn(),
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: { on: vi.fn(), end: vi.fn() }
        });
    });

    it('should pass --continue to Claude without --session-id when user requests continue', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue'] // User wants to continue last session
        });

        // Verify spawn was called with --continue but WITHOUT --session-id
        expect(mockSpawn).toHaveBeenCalled();
        const spawnArgs = mockSpawn.mock.calls[0][2];

        // Should contain --continue
        expect(spawnArgs).toContain('--continue');

        // Should NOT contain --session-id (this was causing the conflict)
        expect(spawnArgs).not.toContain('--session-id');

        // Should notify about continue
        expect(onSessionFound).toHaveBeenCalledWith('continue-pending');
    });

    it('should add --session-id for normal new sessions', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [] // No session flags - new session
        });

        // Verify spawn was called with --session-id for new sessions
        expect(mockSpawn).toHaveBeenCalled();
        const spawnArgs = mockSpawn.mock.calls[0][2];
        expect(spawnArgs).toContain('--session-id');
        expect(spawnArgs).not.toContain('--continue');
    });

    it('should handle --resume with session ID without conflict', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: 'existing-session-123',
            path: '/tmp',
            onSessionFound,
            claudeArgs: [] // No --continue
        });

        // Should use --resume with session ID
        const spawnArgs = mockSpawn.mock.calls[0][2];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('existing-session-123');
        expect(spawnArgs).not.toContain('--session-id');
    });
});
```

### Test File 2: src/api/apiSession.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import { ApiSessionClient } from './apiSession';

describe('ApiSessionClient connection handling', () => {
    it('should handle socket connection failure gracefully', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock socket.connect() to throw
        const mockSocket = {
            connect: vi.fn(() => { throw new Error('ECONNREFUSED'); }),
            on: vi.fn()
        };

        // Should not throw
        expect(() => {
            new ApiSessionClient('fake-token', { id: 'test' } as any);
        }).not.toThrow();

        // Should show user-friendly message
        expect(consoleSpy).toHaveBeenCalledWith(
            '⚠️  Cannot connect to Happy server - continuing in local mode'
        );

        consoleSpy.mockRestore();
    });
});
```

### Test File 3: src/api/api.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';
import { Api } from './api';

describe('Api server error handling', () => {
    it('should return null when Happy server is unreachable', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock axios to throw connection error
        vi.mock('axios', () => ({
            default: {
                post: vi.fn(() => Promise.reject({ code: 'ECONNREFUSED' }))
            }
        }));

        const api = new Api('fake-key');
        const result = await api.getOrCreateSession({ machineId: 'test' });

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            '⚠️  Happy server unreachable - working in offline mode'
        );

        consoleSpy.mockRestore();
    });
});
```

## Implementation Steps (TDD Flow)

1. **Create Local Plan Copy**:
   ```bash
   # Copy plan with date and author to project docs
   cp /Users/athundt/.claude/plans/lively-plotting-snowflake.md \
      ./docs/bug-fix-plan-2025-01-15-athundt.md
   git add ./docs/bug-fix-plan-2025-01-15-athundt.md
   git commit -m "docs: add bug fix plan for session conflict and server crash"
   ```

2. **Red Phase**:
   - Write the 3 test files above
   - Run tests - they should fail (bugs not fixed yet)

3. **Green Phase - Bug 1 (Session ID Conflict)**:
   - Apply fix to src/claude/claudeLocal.ts (around line 35):
     - Import claudeFindLastSession from src/claude/utils/claudeFindLastSession.ts
     - Detect --continue flag
     - Convert to --resume with last session ID using claudeFindLastSession()
     - Remove --continue from claudeArgs
     - Use existing logic to add --resume or --session-id
   - Run tests - they should pass

4. **Green Phase - Bug 2 (Server Crash)**:
   - Apply fixes to src/api/apiSession.ts, src/api/api.ts
   - Add graceful error handling with user messages
   - Run tests - they should pass

5. **Refactor Phase**:
   - Add session ID extraction for --continue (future enhancement):
     - Monitor Claude's session file creation
     - Extract real session ID from ~/.claude/projects/*/session-id.jsonl
     - Update Happy's session metadata with Claude's ID
   - Ensure code is clean and minimal

6. **Manual Verification**:
   ```bash
   # Test Bug 1 fix:
   ./bin/happy.mjs --continue  # Should work without error
   # Verify mobile/daemon still work with session ID

   # Test Bug 2 fix:
   HAPPY_SERVER_URL=http://invalid:9999 ./bin/happy.mjs  # Should show warning, not crash
   # Or test with unreachable default server:
   # Temporarily block network access to test default server fallback
   ```

## Success Criteria

**Bug 1 Fixed**:
- Test: `./bin/happy.mjs --continue` exits with code 0
- No "session-id cannot be used" error

**Bug 2 Fixed**:
- Test: `HAPPY_SERVER_URL=http://invalid:9999 ./bin/happy.mjs` shows warning message
- Process continues in local mode instead of crashing
- Clear user feedback: "⚠️ Happy server unreachable - working in offline mode"

**All Tests Pass**:
- Unit tests: 100% pass
- Integration tests: Verify actual CLI behavior
- No regression in existing functionality