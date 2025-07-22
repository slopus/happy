# Happy Coder DevTools

## Use Case: Setting Up UI State

This tool is useful for **setting up the UI state of your app** by replaying Claude conversations. The interactive mode allows you to:

- **Control message flow**: Send messages one at a time to gradually build up the UI state
- **Selective replay**: Choose which messages to send based on your current needs
- **State verification**: Pause between messages to verify the UI state is correct
- **Debugging**: Step through conversations to understand how the UI state evolved

## Usage

### 1. Generate a Secret Key

First, generate a secret key that will be used to authenticate your uploads:

```bash
npx tsx src/index.ts generate-key
```

**Example output:**
```
Generated new secret key:
XKXQ0YBDxPm_NNTpQruWy4YoKULSegmTBJH8XM1MljA
```

### 2. Find Recent Claude Code Sessions

Use the `recent` command to browse and select from your recent Claude project files:

```bash
npx tsx src/index.ts recent
```

**Example output:**
```
Claude project: -Users-user-src-github-com-12-057-joint-venture-claude-code-client-devtools

? Select a recent Claude project file › - Use arrow-keys. Return to submit.
❯   Do nothing (default)
    4 hours ago - 2025-07-15T01:32:31.261Z - 6d0eec5b-678c-4299-909e-0438d94b7b08.jsonl
    4 hours ago - 2025-07-15T01:13:46.452Z - aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl
```

After selecting a file:
```
✔ Select a recent Claude project file › 4 hours ago - 2025-07-15T01:13:46.452Z - aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl
Selected file: /Users/user/.claude/projects/-Users-user-src-github-com-12-057-joint-venture-claude-code-client-devtools/aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl
```

### 3. Upload Session with Interactive Mode

Upload your Claude code session one message at a time using the interactive flag. This is perfect for setting up UI state as you can control which messages are sent:

```bash
npx tsx src/index.ts upload --key XKXQ0YBDxPm_NNTpQruWy4YoKULSegmTBJH8XM1MljA /Users/user/.claude/projects/-Users-user-src-github-com-12-057-joint-venture-claude-code-client-devtools/aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl --interactive
```

**Example output:**
```
[2025-07-15T05:30:31.116Z] [INFO] File exists: /Users/user/.claude/projects/-Users-user-src-github-com-12-057-joint-venture-claude-code-client-devtools/aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl
[2025-07-15T05:30:31.117Z] [INFO] Using filename-based session ID: aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f
[2025-07-15T05:30:31.364Z] [INFO] Session created: cmd43g0mo01liw41446ohc2rp
[2025-07-15T05:30:31.369Z] [INFO] Processing 3 messages from /Users/user/.claude/projects/-Users-user-src-github-com-12-057-joint-venture-claude-code-client-devtools/aa7e2167-b308-4fcf-8d9a-9fdb982bcc3f.jsonl
[2025-07-15T05:30:31.369Z] [INFO] Message 1/3: {"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/Users/user/src/github.com/12.05...
Send this message? (Y/n): 
[2025-07-15T05:30:32.834Z] [INFO] Message 2/3: {"parentUuid":"763f6049-9243-4e2d-9e17-a76830637a37","isSidechain":false,"userType":"external","cwd"...
Send this message? (Y/n): 
[2025-07-15T05:30:34.130Z] [INFO] Message 3/3: {"parentUuid":"7efd78f1-4e74-491b-8007-67708c02eddb","isSidechain":false,"userType":"external","cwd"...
Send this message? (Y/n): 
[2025-07-15T05:30:34.951Z] [INFO] All messages sent successfully
[2025-07-15T05:30:36.952Z] [INFO] Shutting down...
```


## Commands

### `generate-key`
Generates a new secret key for authentication.

### `recent`
Shows a list of recent Claude project files to choose from.

### `upload`
Uploads a Claude code session file.

**Options:**
- `--key <key>`: Secret key for authentication (required)
- `--interactive`: Send messages one at a time with confirmation prompts
- `--session-id <id>`: Custom session ID (optional, defaults to filename-based ID)

## Examples

### Complete Workflow
```bash
# 1. Generate authentication key
npx tsx src/index.ts generate-key

# 2. Find recent Claude sessions
npx tsx src/index.ts recent

# 3. Upload with interactive mode for UI state setup
npx tsx src/index.ts upload --key YOUR_KEY_HERE /path/to/claude/session.jsonl --interactive
```

### Non-Interactive Upload
Uploads the messages as fast as possible and then sends the sendSessionDeath() message.
```bash
npx tsx src/index.ts upload --key YOUR_KEY_HERE /path/to/claude/session.jsonl
```