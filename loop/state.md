# Loop State

Last updated: 2026-03-26 20:00 PDT

Previous completed tasks are archived in `loop/state-archive.md`.

## Current Task

TASK: Record a proper walkthrough video using webreel + take proper screenshots

### Architecture: webreel + background SyncNode driver

Use `webreel` (by Vercel, `npx webreel`) to record a HIGH QUALITY video of the
Happy web app while exercise steps run. webreel produces H.264 MP4 at configurable
CRF (not Playwright's garbage 1Mbps VP8). DO NOT USE Playwright recordVideo.

**Two-part setup:**

**Part 1: Background driver script** (`packages/happy-sync/src/e2e/walkthrough-driver.ts`)
- Boots infrastructure: PGlite server + isolated daemon + Expo web (BROWSER=none)
- Creates a SyncNode, spawns a Claude session
- Writes session URL to a file (e.g. `e2e-recordings/ux-review/session-url.txt`)
- Sends all 38 exercise step prompts via SyncNode with appropriate waits
- Handles permissions, questions, stop/resume as needed
- Runs for the full duration (~30-40 min)

**Part 2: webreel config** (`webreel.config.ts` or `webreel.config.json`)
- Reads the session URL from the file
- Opens Chrome at the session page
- Uses `wait` steps to sync with content appearing
- Uses `scroll` steps to follow the transcript as it grows
- Uses `screenshot` steps at key moments (every component type)
- Uses `pause` steps between interactions
- Records everything as a continuous H.264 MP4 video

**webreel config settings:**
```json
{
  "viewport": "macbook-pro",
  "fps": 30,
  "quality": 65,
  "output": "e2e-recordings/ux-review/happy-walkthrough.mp4"
}
```

**webreel step pattern for each exercise step:**
```json
{ "action": "wait", "text": "Step N prompt text or tool name", "timeout": 120000 },
{ "action": "scroll", "y": 300, "selector": "<chat-scroll-container>" },
{ "action": "pause", "ms": 3000 },
{ "action": "screenshot", "output": "e2e-recordings/ux-review/step-N-name.png" }
```

**webreel docs reference:**
- Config: https://webreel.dev/configuration
- Actions: pause, click, key, type, scroll, wait, screenshot, navigate, hover, drag, moveTo, select
- NO eval/js action — use `wait` to sync with app state, driver script handles SyncNode
- `wait` polls every 200ms for text or selector, up to timeout
- `scroll` supports targeting specific elements via `selector`
- Quality 65 = CRF 18 (visually excellent). Quality 80 = CRF 10 (overkill).
- Supports .mp4, .webm, .gif output
- Install: `npx webreel` (auto-downloads Chrome + ffmpeg to ~/.webreel)

### Implementation steps

1. **Write the driver script** — reuse existing `phase1-visual.ts` infrastructure
   boot code. The driver should:
   - Boot server + daemon + Expo web
   - Create session, write URL to file
   - Send all 38 prompts with waits between each
   - Signal completion when done (write a done-marker file)

2. **Write the webreel config** — create `webreel.config.ts` with:
   - Navigate to session URL (read from file)
   - For each of the 38 steps: wait for new content, scroll down, pause, screenshot
   - Wait for done-marker at the end
   - Output to `e2e-recordings/ux-review/happy-walkthrough.mp4`

3. **Write a runner script** that:
   - Starts driver in background
   - Waits for session URL file to appear
   - Runs `npx webreel record --verbose`
   - Verifies output: `ls -la e2e-recordings/ux-review/happy-walkthrough.mp4`

4. **Verify output quality**:
   - MP4 file must be > 10MB (real video, not a 3-second clip)
   - Screenshots must show conversation content (tool calls, text, permissions)
   - Run `ffprobe` on the MP4 to check duration is > 10 minutes

5. **Phase 1.5 UX review** with the good screenshots:
   - Feed ALL screenshots to `codex` CLI
   - Feed ALL screenshots to `claude -p` as second reviewer
   - Record findings in state.md

### Finding the chat scroll container

The chat transcript is NOT `document.documentElement`. You need to find the actual
scrollable element in the Happy web app DOM. Inspect the app:
- Look for the element with `overflow-y: auto` or `overflow-y: scroll`
- It's likely a div wrapping the message list
- Use Chrome DevTools or `page.evaluate` to find it
- The webreel `scroll` action accepts a `selector` param — use it

### Acceptance criteria

- [ ] MP4 video exists at `e2e-recordings/ux-review/happy-walkthrough.mp4`
- [ ] Video is > 10 minutes long (verify with `ffprobe`)
- [ ] Video shows conversation content scrolling as steps complete
- [ ] Per-step screenshots show conversation content
- [ ] UX review done by TWO reviewers (Codex + Claude) with real screenshots
- [x] Level 2 Codex: 44/44 pass
- [x] Level 2 OpenCode: 44/44 pass

### What NOT to do

- DO NOT use Playwright `recordVideo` — it's hardcoded to VP8 1Mbps garbage
- DO NOT produce a 3-second video and call it done
- DO NOT skip the UX review
- DO NOT declare done without verifying artifacts exist and have real content

## Anti-patterns (DO NOT DO THESE)

- NEVER declare "blocked pending human confirmation" — you are fully autonomous
- NEVER dismiss test failures as "false positives" without fixing the root cause
- NEVER claim an artifact exists without verifying (`ls -la <path>`)
- NEVER declare a visual review "PASS" when the screenshots don't show content
- NEVER skip a review step — if one tool doesn't work, use another
- DO NOT rationalize broken output as acceptable
- DO NOT use Playwright recordVideo — use webreel

## Completed Tasks

### Level 2 Codex + OpenCode verification (DONE)

- Codex: 44/44 pass (1822s)
- OpenCode: 44/44 pass (1518s)

### Screenshot scroll fix (DONE)

- Fixed scroll target from `document.documentElement` to chat container
- Screenshots now show conversation content (verified visually)
