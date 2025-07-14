# Interactive Mode Experiment Conclusions

## Commands and Tests Run

### Test 1: Basic Interactive Mode
```bash
claude --output-format stream-json --verbose
```
- **Result**: Claude started but didn't respond to stdin input sent as plain text

### Test 2: Stream-JSON Input Format
```bash
claude --print --output-format stream-json --input-format stream-json --verbose
```
- **Input Format**: `{"type":"text-input","content":"..."}`
- **Result**: Error - Expected message type 'user' or 'control', not 'text-input'

### Test 3: JSONL Input with -p Flag
```bash
claude -p --output-format stream-json --verbose
```
- **Input Format**: JSONL with `{"role":"user","content":"..."}`
- **Result**: SUCCESS! Claude responded to input

## Key Findings

1. **Interactive Mode Requirements**:
   - Must use `-p` flag (print mode) for programmatic input
   - Input must be in JSONL format (one JSON object per line)
   - Message format: `{"role":"user","content":"message text"}`

2. **Input Processing Behavior**:
   - Claude batches multiple messages sent quickly
   - Processes them as a single conversation turn
   - Tool results are automatically sent back as user messages

3. **Session Management in Interactive Mode**:
   - New session created: `e10c694a-9e19-45a8-bd5f-49822fec7979`
   - Session stored in same pattern as non-interactive mode

4. **Message Flow**:
   ```
   User Input (JSONL) → Claude processes → Stream-JSON output → Tool execution → Auto-sends results → Continue...
   ```

5. **Important Limitations**:
   - The `-p` flag is required even for "interactive" programmatic use
   - Cannot send plain text to stdin; must use JSONL format
   - The `--input-format stream-json` expects different message types than documented

## Practical Usage for handy-cli

For spawning Claude and handling interactive communication:

```javascript
const claude = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'], {
  cwd: projectPath,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Send user messages as JSONL
claude.stdin.write(JSON.stringify({role: 'user', content: 'message'}) + '\n');
```

## Message Types Observed

1. System init message with session info
2. Assistant messages with tool uses
3. User messages with tool results (auto-generated)
4. No explicit result message (unlike --print mode with single prompt)