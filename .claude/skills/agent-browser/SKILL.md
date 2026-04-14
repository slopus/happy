---
name: agent-browser
description: Browser automation CLI for AI agents. Use this when asked to test something in a real browser.
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
---

# Browser Automation with agent-browser

Pure Rust CLI (v0.25+) that controls Chrome via CDP. No Node.js/Playwright dependency.

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Command Chaining

Commands can be chained with `&&` in a single shell invocation. The browser persists between commands via a background daemon, so chaining is safe and more efficient than separate calls.

```bash
# Chain open + wait + snapshot in one call
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser screenshot page.png
```

**When to chain:** Use `&&` when you don't need to read the output of an intermediate command before proceeding (e.g., open + wait + screenshot). Run commands separately when you need to parse the output first (e.g., snapshot to discover refs, then interact using those refs).

## Batch Commands

Execute multiple commands sequentially in one call (alternative to `&&` chaining):

```bash
agent-browser batch "open example.com" "snapshot -i" "screenshot /tmp/shot.png"
agent-browser batch --bail "fill @e1 test" "click @e2"   # Stop on first error
```

## Essential Commands

```bash
# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser back                    # Go back
agent-browser forward                 # Go forward
agent-browser reload                  # Reload page
agent-browser close                   # Close browser
agent-browser close --all             # Close all sessions

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i -C          # Include cursor-interactive elements (divs with onclick, cursor:pointer)
agent-browser snapshot -c             # Compact output
agent-browser snapshot -d 3           # Limit depth to 3
agent-browser snapshot -s "#selector" # Scope to CSS selector
agent-browser snapshot --urls         # Include href URLs for links

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser dblclick @e1            # Double-click
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser uncheck @e1             # Uncheck checkbox
agent-browser press Enter             # Press key
agent-browser press Control+a         # Key combination
agent-browser keyboard type "text"    # Type at current focus (no selector)
agent-browser keyboard inserttext "text"  # Insert without key events
agent-browser hover @e1               # Hover element
agent-browser focus @e1               # Focus element
agent-browser drag @e1 @e2            # Drag and drop
agent-browser upload @e1 file.png     # Upload file
agent-browser scroll down 500         # Scroll page
agent-browser scroll down 500 --selector "div.content"  # Scroll within a specific container
agent-browser scrollintoview @e1      # Scroll element into view

# Get information
agent-browser get text @e1            # Get element text
agent-browser get html @e1            # Get element HTML
agent-browser get value @e1           # Get input value
agent-browser get attr name @e1       # Get attribute
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title
agent-browser get count @e1           # Count matching elements
agent-browser get box @e1             # Get bounding box
agent-browser get styles @e1          # Get computed styles
agent-browser get cdp-url             # Get CDP WebSocket URL

# Check state
agent-browser is visible @e1          # Check visibility
agent-browser is enabled @e1          # Check if enabled
agent-browser is checked @e1          # Check if checked

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait --text "Success"   # Wait for text
agent-browser wait 2000               # Wait milliseconds

# Downloads
agent-browser download @e1 ./file.pdf          # Click element to trigger download
agent-browser wait --download ./output.zip     # Wait for any download to complete
agent-browser --download-path ./downloads open <url>  # Set default download directory

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot path.png     # Save to file
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser pdf output.pdf          # Save as PDF

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element

# Tabs
agent-browser tab list                # List open tabs
agent-browser tab new                 # Open new tab
agent-browser tab 2                   # Switch to tab 2
agent-browser tab close               # Close current tab

# Semantic locators (alternative to refs)
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search..." fill "query"
agent-browser find testid "submit-btn" click
```

## Authentication

### Chrome profile (reuse existing login state)
```bash
agent-browser --profile Default open gmail.com          # Use Chrome's Default profile
agent-browser --profile ~/.myapp open example.com       # Custom profile directory
agent-browser profiles                                  # List available profiles
```

### Auth vault (save and replay credentials)
```bash
agent-browser auth save mysite --url https://example.com --username user --password pass
agent-browser auth login mysite              # Auto-fill login form
agent-browser auth list                      # List saved profiles
agent-browser auth delete mysite             # Remove profile
```

### State persistence
```bash
# Login once and save state
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Reuse in future sessions
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard

# Auto-save/restore by session name
agent-browser --session-name myapp open example.com
```

## Network

```bash
agent-browser network route "*.png" --abort             # Block image requests
agent-browser network route "/api/*" --body '{"mock":1}'  # Mock API responses
agent-browser network unroute "/api/*"                   # Remove route
agent-browser network requests                           # List captured requests
agent-browser network requests --filter "api"            # Filter by pattern
agent-browser har start                                  # Start HAR capture
agent-browser har stop ./traffic.har                     # Stop and save HAR file
```

## Storage & Clipboard

```bash
agent-browser cookies get                    # Get all cookies
agent-browser cookies set --url https://example.com --name key --value val
agent-browser cookies clear                  # Clear cookies
agent-browser storage local                  # View localStorage
agent-browser storage session                # View sessionStorage
agent-browser clipboard read                 # Read clipboard
agent-browser clipboard write "text"         # Write to clipboard
agent-browser clipboard copy                 # Copy selection
agent-browser clipboard paste                # Paste
```

## Sessions (parallel browsers)

```bash
agent-browser --session test1 open site-a.com
agent-browser --session test2 open site-b.com
agent-browser session list
agent-browser --session test1 close
```

## Connection Modes

```bash
# Default: agent-browser manages Chrome lifecycle
agent-browser open example.com

# CDP: connect to existing Chrome
agent-browser --cdp 9222 open example.com
agent-browser --cdp ws://host:port/devtools/browser/... open example.com

# Auto-connect: discover running Chrome
agent-browser --auto-connect snapshot

# Cloud providers
agent-browser --provider browserbase open example.com
agent-browser --provider browserless open example.com
agent-browser --provider agentcore open example.com    # AWS Bedrock
agent-browser --provider ios open example.com          # iOS Simulator (Xcode+Appium)
```

## Browser Settings

```bash
agent-browser set viewport 1920 1080
agent-browser set device "iPhone 15 Pro"
agent-browser set geo 37.7749 -122.4194
agent-browser set offline on
agent-browser set headers '{"Authorization":"Bearer tok"}'
agent-browser set credentials user pass
agent-browser set media dark                   # Dark mode
agent-browser set media light reduced-motion   # Light + reduced motion
```

## AI Chat (natural language browser control)

```bash
agent-browser chat "open google.com and search for cats"  # Single-shot
agent-browser chat                                        # Interactive REPL mode
agent-browser -q chat "summarize this page"               # Quiet mode (text only)
```

Requires `AI_GATEWAY_API_KEY` env var.

## JavaScript Evaluation

```bash
# Simple expressions
agent-browser eval 'document.title'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF
```

## Debugging & Profiling

```bash
agent-browser --headed open example.com   # Show browser window
agent-browser console                     # View console messages
agent-browser errors                      # View page errors
agent-browser inspect                     # Open Chrome DevTools
agent-browser highlight @e1               # Highlight element visually
agent-browser trace start                 # Record DevTools trace
agent-browser trace stop ./trace.json
agent-browser profiler start              # Record DevTools profile
agent-browser profiler stop ./profile.json
agent-browser record start ./video.webm   # Record video (WebM/VP9)
agent-browser record stop
```

## Dashboard & Streaming

```bash
agent-browser dashboard start              # Start observability dashboard (port 4848)
agent-browser dashboard start --port 5000  # Custom port
agent-browser dashboard stop
agent-browser stream enable                # Start WebSocket streaming
agent-browser stream status                # Check streaming state
agent-browser stream disable               # Stop streaming
```

## Annotated Screenshots (Vision Mode)

Use `--annotate` to take a screenshot with numbered labels overlaid on interactive elements.

```bash
agent-browser screenshot --annotate
# Output includes the image path and a legend:
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"
agent-browser click @e2              # Click using ref from annotated screenshot
```

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `AGENT_BROWSER_SESSION` | Default session name |
| `AGENT_BROWSER_HEADED` | Show browser window |
| `AGENT_BROWSER_DEFAULT_TIMEOUT` | Action timeout in ms (default: 25000) |
| `AGENT_BROWSER_EXECUTABLE_PATH` | Custom browser binary |
| `AGENT_BROWSER_PROXY` | Proxy server URL |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | Auto-shutdown daemon after inactivity |
| `AGENT_BROWSER_SCREENSHOT_DIR` | Default screenshot directory |
| `AGENT_BROWSER_SCREENSHOT_FORMAT` | png or jpeg |
| `AGENT_BROWSER_COLOR_SCHEME` | dark, light, no-preference |
| `AGENT_BROWSER_DOWNLOAD_PATH` | Default download directory |
| `AI_GATEWAY_API_KEY` | Required for `chat` command |

## Configuration File

`agent-browser.json` (project root or `~/.agent-browser/config.json`):

```json
{"headed": true, "proxy": "http://localhost:8080", "profile": "./browser-data"}
```

Priority: CLI flags > env vars > project config > user config.

## Session Cleanup

Always close your browser session when done:

```bash
agent-browser close                    # Close default session
agent-browser --session agent1 close   # Close specific session
agent-browser close --all              # Close all sessions
```
