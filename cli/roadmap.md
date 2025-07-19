# July 18

# CLI

- Test end to end & rollout new version
- Server diying test
  - lsof -ti tcp:3005 | xargs kill -9
  - This kills the app :D and cli

CLI dies with 
error Command failed with exit code 137.
info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.
kirilldubovitskiy@MacBookPro handy-cli % node:events:496
      throw er; // Unhandled 'error' event
      ^

Error: read EIO
    at TTY.onStreamRead (node:internal/stream_base_commons:216:20)
Emitted 'error' event on ReadStream instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  errno: -5,
  code: 'EIO',
  syscall: 'read'
}

Node.js v22.17.0

- Dogfood for issues
- Refactor existing code
- Make it feel nicer

- Embed amphetamine into it?

- Permissions
  - Define schema
  - 

- Deep link to a website

# App
- Logout - make a full reload
- Make scroll work nicely 

# Big ideas
- Coordinator agent - will ensure claude keeps working at max token usage - juice the most out of it
- Social component
- Notifications
- Real time voice

# Archive July 18

# Roadmap

## App
- Make key messages render
- [later] Wrapping claude in an http proxy, allows us to snoop on token usage to show its doing something in the ui when running in remote mode
- For local mode, same approach will work

- Distribution
  - Website - happyinc.ai?
  - App Store
  - Google Play

- Deep link to download app from cli link

## Server

- Session management
  - Keep track of who is controlling the session - remote or local


## CLI
- Make it stable to be a drop in replacement for claude
- Fix snooping on existing conversation bug, after switching back and forth stops watching the session file for new messages
- [later] Test it works on linux, windows, lower node version

Conversation continuity
- Some things will not expect as you would want such as /clear ing the conversation, or forking (press 2 escape on empty input)
- We might want to be better at switching between sessions for full compatibility with claude

MCP
- Permissions
  - I think we should reuse the format from .claude/settings.local.json, so interactive & our checking will be similar
  - Impelement checking logic
  - Implement blessing command logic ()
- Implement conversation naming
  - I wonder if the server can initiate an llm call on its own accord?

Permission automatic checking
- Pull antropic token from secrets


Blocking
- Permission checking [steve]
  - use mcp 
  - see if it has a timeout or we can block forever (ideally)
  - copy cc system (deterministic splitting, prefix checking, injection detection, prefix whitelist suggest)
  - use cc settings local file & format for compatibility  
  - figure out extra path permissions

- CLI dies if server disconnects :D

- Need to make agent state work. Most important state - permissions
- Try logging out of Claude and see how to handle that case
- Make sure to use Claude from our package. Kill other Claudes
- Make sure interruption of remote controlled session works

### Nice to have
- UX final touches - onboarding make sure terminal, add session icons or something catchy
- See if I can simplify / get rid of a likely race condition in pty related code
- Pass --local-installation to setup .happy folder locally and avoid clashing with global installation

# Distribution

- Post on hacker news
- Send to friends to try
- Send to influencers who reviewed similar products
- Mass email people who have starred claudecodeui


# Later, low priority


- Permissions callout:
  - permission checking will not be visible on the client nor will we be aware of it
  - ✻ Enchanting… (5s · ↑ 27 tokens · esc to interrupt)
    - We can parse the terminal output

- e2e single tests
  - Would be nice to be able to run the whole thing - including pty to emulate a simple scenario and make sure a single multi step happy path works fine

