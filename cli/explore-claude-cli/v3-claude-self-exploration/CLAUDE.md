# V3 Project: Exploring Claude CLI

## Project Goal

The goal of this v3 project is to explore how claude cli (you) work.

SPecifically I am intersted in how it handle resumption, how it stores sessions, how it produces messages.

## Background & Context

Some hints - the messages are stored in a directory ~/.claude/projects/projct-id-path-like/session-id.jsonl

Claude Code - starts an interactive session by default, use -p/--print for non-interactive output

Maybe we can give --continue a try to?

Assume we are already logged in.

## Summary of Findings

### 1. Session Storage & Structure
- Sessions stored in: `~/.claude/projects/<path-encoded-directory>/<session-id>.jsonl`
- Path encoding: Directory paths are encoded with hyphens replacing slashes
- Format: JSONL (one JSON object per line) with UUID chain linking messages

### 2. Session Resumption Behavior
Both `--resume <session-id>` and `--continue` behave identically:
- Create NEW session files with NEW session IDs
- Copy COMPLETE history from original session
- Update all historical message sessionIds to the new ID
- Original session files remain unchanged
- Include a summary line at the top of new session

Key insight: Session "resumption" is actually session cloning with history preservation.

### 3. Interactive Mode & Message Formats
- **True interactive mode**: Without flags, doesn't respond to piped stdin
- **Programmatic mode**: Requires `-p` flag with JSONL input
- **Input format**: `{"role":"user","content":"message text"}`
- **Output format**: Stream of JSON objects when using `--output-format stream-json`

### 4. Permission System
- **No interactive approval** in --print mode
- Permissions must be pre-configured via:
  - CLI flags: `--allowedTools Edit`
  - Project config: `.claude/settings.json` or `.claude/settings.local.json`
  - Global config: `~/.claude/settings.json`
  - Skip all: `--dangerously-skip-permissions`
- Permission errors returned as `tool_result` with `is_error: true`

### 5. Available Tools
From init message: Task, Bash, Glob, Grep, LS, exit_plan_mode, Read, Edit, MultiEdit, Write, NotebookRead, NotebookEdit, WebFetch, TodoWrite, WebSearch

## Experiment Setup

Your goal is basically to run yourself (you are also claude code) in /toy-project-<experiment-name> directory, and inspect how you work. Make sure to cap your execution time to 15 seconds to avoid hanging completely. You should do very simple changes to the project of hello-world.js to explore how you work.

Before running a new experiment - copy the toy-project-template directory to a new directory with a new name.

## Experiments to Run

You should run At least the following experiments
[ Sanity check]
- Run yourself in an interactive output json mode,  and use print flag And make sure you can list the directory of the toy project You should probably call this experiment a sanity check

[Explore session continuation with --print mode]
- Try running yourself twice with --print command to Sanity check that you're able to continue an existing session keep in mind how your sessions are stored and make sure you query and verify that the session was actually resumed. There's a known issue with even when resume session has passed. The session is not being resumed.
-  Now try running resuming a session with a Continue flag. See how that Behaves differently or the same.

[Explore interactive input mode]
- run yourself also with interactive input mode and try Communicating with this child process of yours Interactively

## Documentation Requirements

after running every single experiment, You should write down your conclusions in toy-project-<experiment-name>/conclusions.md file. You should detail what message types were produced, follow a similar format as in /Users/kirilldubovitskiy/projects/handy-cli/explore-claude-cli/v2-manual-run-on-toy-project-explore-session-jsonl/sample-session-update-file.md, not as verbose though. You can ommit not key parts of the info you have. Just the key flows you tested, which commands you ran, what was the output, what was the input, and anything else that is relevant. Should be compact and to the point.

## Additional Notes & Guidelines

Example of how I have tried resuming a session:

`claude -r 10ca66e1-f0ec-4bca-83dc-53fdc29d88cd --output-format stream-json --verbose --print 'make a change to hello-world to accept name arg'`

Which does not seem to work.

I also want to give a shot to interactive input model. 

Each individual experiment can be somewhat faithful, but should be completely independent from other experiments. For example, the sessions that Claude will be storing will be different for each experiment instance for your ease of debugging.

You might Want to search the web for how to use claude cli in this context. Search for people hacking on claude cli.

There is an example of spawning claude code here: /Users/kirilldubovitskiy/projects/claudecodeui/server/claude-cli.js, but there might be more on the web.

## Individual Experiment Results

### Sanity Check (toy-project-sanity-check)
- Verified basic functionality with `--print --output-format stream-json`
- Confirmed session storage location and JSONL format
- Identified message types: system/init, assistant, user, result

### Session Resume (toy-project-session-resume)
- `--resume <session-id>` creates new session but includes full history
- All historical messages get new session ID
- Original session file unchanged

### Session Continue (toy-project-session-continue)
- `--continue` behaves identically to --resume
- Automatically selects most recent session
- Same history copying mechanism

### Interactive Mode (toy-project-interactive)
- `-p` flag required for programmatic input
- JSONL format: `{"role":"user","content":"..."}`
- Cannot use plain text stdin without proper formatting

### Edit Approval (toy-project-edit-approve)
- No interactive approval in --print mode
- Permission errors as tool_result messages
- Pre-approval via `claude config add allowedTools Edit`
- Creates `.claude/settings.local.json` for project permissions

## Appendix: CLI Help Output

This is claude code cli help output so you don't have to run it yourself
Arguments:
  prompt                           Your prompt

Options:
  -d, --debug                      Enable debug mode
  --verbose                        Override verbose mode setting from config
  -p, --print                      Print response and exit (useful for pipes)
  --output-format <format>         Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime
                                   streaming) (choices: "text", "json", "stream-json")
  --input-format <format>          Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input) (choices: "text",
                                   "stream-json")
  --mcp-debug                      [DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)
  --dangerously-skip-permissions   Bypass all permission checks. Recommended only for sandboxes with no internet access.
  --allowedTools <tools...>        Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")
  --disallowedTools <tools...>     Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")
  --mcp-config <file or string>    Load MCP servers from a JSON file or string
  --append-system-prompt <prompt>  Append a system prompt to the default system prompt
  -c, --continue                   Continue the most recent conversation
  -r, --resume [sessionId]         Resume a conversation - provide a session ID or interactively select a conversation to resume
  --model <model>                  Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name
                                   (e.g. 'claude-sonnet-4-20250514').
  --fallback-model <model>         Enable automatic fallback to specified model when default model is overloaded (only works with --print)
  --add-dir <directories...>       Additional directories to allow tool access to
  --ide                            Automatically connect to IDE on startup if exactly one valid IDE is available
  --strict-mcp-config              Only use MCP servers from --mcp-config, ignoring all other MCP configurations
  -v, --version                    Output the version number
  -h, --help                       Display help for command

Commands:
  config                           Manage configuration (eg. claude config set -g theme dark)
  mcp                              Configure and manage MCP servers
  migrate-installer                Migrate from global npm installation to local installation
  setup-token                      Set up a long-lived authentication token (requires Claude subscription)
  doctor                           Check the health of your Claude Code auto-updater
  update                           Check for updates and install if available
  install [options] [target]       Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)
