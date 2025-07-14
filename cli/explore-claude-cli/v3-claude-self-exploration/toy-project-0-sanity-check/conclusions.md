# Sanity Check Experiment Conclusions

## Command Run
```bash
claude --print --output-format stream-json --verbose 'list the files in this directory'
```

## Key Observations

### Session Storage
- Session ID: `38fdf44f-b611-4819-9f22-e39c7b14ef38`
- Session file path: `~/.claude/projects/-Users-kirilldubovitskiy-projects-handy-cli-explore-claude-cli-v3-toy-project-sanity-check/38fdf44f-b611-4819-9f22-e39c7b14ef38.jsonl`
- Path encoding: The directory path is encoded with hyphens replacing slashes

### Message Types Produced
1. **System Init Message**:
   - `type: "system", subtype: "init"`
   - Contains session metadata, tools list, model info

2. **Assistant Messages**:
   - `type: "assistant"`
   - Contains the AI's responses and tool uses

3. **User Messages**:
   - `type: "user"`
   - Contains user prompts and tool results

4. **Result Message**:
   - `type: "result", subtype: "success"`
   - Contains final result, duration, cost, and usage stats

### Session File Format
- JSONL format (one JSON object per line)
- Each entry has:
  - `uuid`: Unique identifier for the message
  - `parentUuid`: Links messages in conversation chain
  - `timestamp`: ISO timestamp
  - `sessionId`: Consistent across all messages
  - `type`: "user" or "assistant"
  - `message`: The actual content

### Output Behavior
- With `--print` flag: Non-interactive mode, exits after completion
- `--output-format stream-json`: Outputs streaming JSON events
- `--verbose` required when using stream-json format