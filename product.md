# Manual Product Validation

This is the full Happy product check.

It is manual on purpose.

## Boot A Local Environment

From repo root:

```bash
yarn env:new
```

Start services in separate terminals:

```bash
yarn env:server
yarn env:web
```

Useful helpers:

- `yarn env:list` shows available environments
- `yarn env:current` prints the active environment path
- `yarn env:cli` starts `happy` inside the current environment

For daemon and agent work, use a sourced shell:

```bash
source environments/data/envs/<name>/env.sh
happy daemon start
```

That shell now points at the local stack through:

- `HAPPY_SERVER_URL`
- `HAPPY_WEBAPP_URL`
- `HAPPY_HOME_DIR`

Use the local web app URL printed by `yarn env:web`, or open the mobile app if
you are testing on device.

## External CLI Use

If you are driving the flow from an external CLI such as `agent-browser`, run
it from the same sourced shell:

```bash
source environments/data/envs/<name>/env.sh
agent-browser ...
```

That keeps the browser-side tooling pointed at the current local environment
instead of production.

## Manual Flow

### 1. Verify the machine is visible

- open the app
- sign in
- confirm the machine appears
- confirm daemon status is healthy

Expected:

- machine is listed
- machine can be opened
- app does not show offline or spawn errors

### 2. Spawn a session

- open the machine screen
- pick an agent
- choose a directory
- spawn the session

Expected:

- session appears in active sessions
- session shows the selected agent
- session enters a running or ready state

### 3. Send a basic prompt

Send:

`Reply with exactly: happy-e2e-ok`

Expected:

- response streams into the session
- final answer is visible in the app
- session returns to idle or ready

### 4. Verify context across turns

Send:

`The secret token is blue-falcon-42. Reply with the token only.`

Then send:

`What was the secret token from my previous message?`

Expected:

- the second response still knows `blue-falcon-42`

### 5. Verify permissions

Send a prompt that forces a tool call or file write.

Run it three ways:

1. approve
2. deny
3. cancel

Expected:

- approve completes
- deny is handled cleanly
- cancel does not hang the session

### 6. Verify model switching

If the agent supports model switching:

- switch model from the app
- send another message that depends on earlier context

Expected:

- the model change takes effect
- prior context is preserved

### 7. Verify interruption

Send a prompt that runs long enough to interrupt.

- interrupt while the agent is thinking
- interrupt during a tool call if possible

Expected:

- the current turn stops cleanly
- the app reflects the interruption
- the next prompt still works

### 8. Verify history

- leave the live session screen
- reopen the session
- inspect history

Expected:

- prompts and outputs are present
- permission outcomes are reflected correctly
- interrupted turns do not leave the session broken

### 9. Verify stop

- stop the session from the app

Expected:

- the session leaves the active state
- no zombie process remains

## Minimum Agents

Run this flow for:

- Codex
- Claude
- Gemini
- OpenClaw

If one is blocked by provider auth or environment issues, record the block
explicitly.
