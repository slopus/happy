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
- Fix bug with 
- [later] Test it works on linux, windows, lower node version

MCP
- Permissions
  - I think we should reuse the format from .claude/settings.local.json, so interactive & our checking will be similar
  - Impelement checking logic
  - Implement blessing command logic ()
- Implement conversation naming
  - I wonder if the server can initiate an llm call on its own accord?

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

