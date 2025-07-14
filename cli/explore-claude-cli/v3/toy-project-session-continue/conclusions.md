# Session Continue Experiment Conclusions

## Commands Run

### Initial Session
```bash
claude --print --output-format stream-json --verbose 'show me the contents of hello-world.js'
```
- Original Session ID: `5f41d411-d645-4b47-8345-252f37f42304`
- Created file: `~/.claude/projects/.../5f41d411-d645-4b47-8345-252f37f42304.jsonl`

### Continue with --continue flag
```bash
claude --print --output-format stream-json --verbose --continue 'what file did we just look at?'
```
- New Session ID: `d8c445ce-47ee-4214-b556-7c69e455f9c7`
- Created file: `~/.claude/projects/.../d8c445ce-47ee-4214-b556-7c69e455f9c7.jsonl`

## Key Findings for --continue

### 1. Session File Behavior
- Creates a NEW session file with NEW session ID (same as --resume)
- Original session file remains unchanged
- Two separate files exist after continuation

### 2. History Preservation
- **IDENTICAL TO --RESUME**: Complete history copied to new file
- History is prefixed at the beginning
- Includes a summary line at the top

### 3. Session ID Rewriting
- **IDENTICAL TO --RESUME**: All historical messages have sessionId updated
- Original messages from session `5f41d411-d645-4b47-8345-252f37f42304` now show `sessionId: "d8c445ce-47ee-4214-b556-7c69e455f9c7"`
- Creates unified session history under new ID

### 4. Message Structure
- Exactly the same pattern as --resume
- Summary → Historical messages (with new IDs) → New messages

## Comparison: --resume vs --continue

### Similarities
1. Both create new session files with new IDs
2. Both preserve complete conversation history
3. Both rewrite session IDs in historical messages
4. Both maintain full context for Claude
5. Both leave original session file untouched

### Differences
1. **--resume**: Requires explicit session ID to resume
2. **--continue**: Automatically finds and continues the most recent session
3. Usage intent:
   - --resume: Resume a specific known session
   - --continue: Continue the last conversation

### Behavioral Analysis
- The underlying mechanism appears to be the same
- --continue likely just auto-selects the most recent session and internally calls the same resume logic
- Both provide identical session management behavior

## Technical Implementation Details

Both flags appear to:
1. Read the specified/most recent session file
2. Create a new session with new ID
3. Copy all messages from old session
4. Update all sessionId fields to new ID
5. Add summary at the beginning
6. Append new messages

## Implications for handy-cli

1. **Session ID Management**: Always expect new session IDs, even when "resuming"
2. **History Tracking**: Can rely on full history being preserved
3. **No Difference in Implementation**: Can treat --resume and --continue the same way
4. **File Proliferation**: Each resume/continue creates a new file - consider cleanup strategies