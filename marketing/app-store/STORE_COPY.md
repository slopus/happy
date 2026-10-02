# Store copy: Happy mobile app

Draft for the next native release (app version `1.8.0`). Nothing here has been
uploaded. The copy blocks are ready to paste. Reviewer notes are at the bottom.
They explain the claims and the deliberate omissions, and they are not for
upload.

Positioning follows the live https://happy.engineering/desktop page ("Any Model.
Your Team. Happy Harness."). The page credits multi-provider sessions,
multiplayer and the Happy Harness to Desktop. This copy only claims what the
phone app does: it shows and steers sessions that run on your computer.

---

## Upload copy

### Shared

**App name / Play title** (30 / 30). Keep it exactly as is:

```
Happy: Codex & Claude Code App
```

**Marketing / website URL**

```
https://happy.engineering
```

**Privacy policy URL** (live page "Privacy Policy — Happy"; tracked source [`PRIVACY.md`](../../PRIVACY.md))

```
https://happy.engineering/privacy
```

### App Store (iOS / iPadOS)

**Subtitle** (28 / 30)

```
Your coding agents, anywhere
```

**Promotional text** (168 / 170)

```
Start, steer and approve Claude Code and Codex sessions from your phone. They keep running on your computer. Get notified when an agent needs you. End-to-end encrypted.
```

**Keywords** (97 / 100: comma-separated, no spaces, no words already in the name)

```
ai,agent,coding,developer,terminal,cli,remote,programming,git,diff,llm,assistant,gpt,grok,mac,ssh
```

### Google Play

**Short description** (78 / 80)

```
Run Claude Code and Codex on your computer. Steer and approve from your phone.
```

### Full description (App Store and Google Play; 2,474 / 4,000)

```
Your coding agent shouldn't wait for you to get back to your desk.

A task can run for an hour and then stop five minutes in to ask for permission or a decision. Happy lets you answer from your phone, and the same agent carries on in the same repository with the same tools and context.

Happy is the mobile app for Claude Code and Codex. The agents keep running on your own computer, and your phone is how you start them, steer them and review their work.

WHAT YOU CAN DO FROM YOUR PHONE
• Start a new session or pick up one you began at your desk
• Get notified when an agent needs input or finishes
• Approve or deny permission requests, or let a session run in Auto mode
• Choose the model and reasoning effort from the providers set up on your computer
• Review changes: a file list, colored diffs, and the full set of changes on a branch
• Attach a screenshot or photo to your prompt
• Browse sessions in one list or grouped by project, with each checkout's chats as tabs
• Open a side chat next to a session without losing your place
• Drafts follow you between your phone and your computer

HOW IT WORKS
Happy runs on your computer, and this app connects to it.
1. Install Happy Desktop from happy.engineering, or if you prefer the terminal, run: npm install -g happy
2. Create an account in the app. You don't need an email address or a password.
3. Scan the QR code your computer shows to link it to your phone.

Then start a session from either device. What you see on your phone is the same live session that's running on your computer.

YOU WILL NEED
• A computer running Happy Desktop or the Happy CLI
• Access to the coding agents you want to use, such as a Claude or ChatGPT/Codex plan or API key. Happy uses your existing accounts.

PRIVATE BY DESIGN
Sessions are end-to-end encrypted. Your code, agent and encryption keys stay on your devices. Happy's servers only relay and store encrypted session data and can't read your prompts, responses or code.

OPEN SOURCE
The app, the CLI and the server are MIT-licensed and on GitHub. Read the code, run your own build or host your own server.

ALSO ON DESKTOP
Happy Desktop adds a harness that works across providers and lets you switch models in the middle of a task. The sessions it starts show up on your phone too.

Happy is an independent project. It is not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex and ChatGPT are trademarks of OpenAI.
```

### What's New in 1.8.0 (App Store and Google Play; 490 / 4,000; Play limit 500)

```
• Easier setup: link your computer from one checklist, with troubleshooting and a Get help button
• Bots: create one from your phone, give it a face and a name, and start talking
• Drafts sync between your phone and desktop, and you can see when the agent picks up a sent message
• Colored diffs, including a workspace's full branch changes
• Projects: group checkouts, with their chats as tabs
• Paste a picture straight from your clipboard
• Faster chats and more reliable history loading
```

---

## Reviewer notes (not for upload)

### Character counts

| Field                  | Count | Limit |
| ---------------------- | ----- | ----- |
| App name / Play title  | 30    | 30    |
| Subtitle               | 28    | 30    |
| Promotional text       | 168   | 170   |
| Keywords               | 97    | 100   |
| Play short description | 78    | 80    |
| Full description       | 2,474 | 4,000 |
| What's New             | 490   | 4,000 (Play: 500) |

Recount after any edit. Use `node -e` with `.length`, not `wc -c`: the `•` and
curly quotes take several bytes each.

### Evidence for each claim

- **Setup with Desktop or CLI, QR linking, no email or password:**
  `packages/happy-app/sources/text/translations/en.ts`, in the `onboarding`
  block (`tagline`, `installStep`, `terminalInstall`, `scanStep`). The live
  /desktop page also says "No Desktop app required" for the CLI path.
- **Notifications:** `sources/sync/pushRegistration.ts`. The live site says
  "Happy tells you when input is needed".
- **Permissions and Auto mode, model and effort pickers, diffs, side chats,
  projects, drafts, pasting images, bots:** `packages/happy-app/CHANGELOG.md`
  entries from July 28 to September 20.
- **End-to-end encryption wording:** taken from the live site's "How it works"
  section. The copy does not name a cipher, does not compare Happy to Signal and
  does not say "military-grade". The source uses both libsodium and AES-GCM.
- **MIT license:** the root `LICENSE` and `packages/happy-app/LICENSE`.
- **What's New:** the September 20 changelog entry, plus commits since then
  (`bc589e1d` checklist, `99bc1a9f` Get help, `381f1c1b` clipboard image,
  `4cf54d18` history loading). **Check this list against the last native build
  that went to the stores.** If 1.8.0 already shipped any of these items as an
  over-the-air update, users already have them, so either keep the list as a
  summary of the native release or cut it down.

### Left out on purpose

- **Multiplayer and "Your Team":** the screenshot README says the multiplayer
  card only shows how messages from other participants are displayed. Nobody has
  verified authenticated multi-account sharing on mobile. Don't put this in the
  upload copy until that flow works in the build being submitted. The fourth
  screenshot carries the same risk.
- **Desktop-only features:** the multi-provider harness and switching models in
  the middle of a task are attributed to Desktop under "ALSO ON DESKTOP". They
  are not described as phone features.
- **Grok in the description:** the live site lists Grok plans as a Desktop
  feature. The Android model-picker screenshot shows Grok as a provider, but I
  left it out of the description and kept `grok` only as a keyword. Remove the
  keyword if Grok isn't selectable in the submitted build.
- **"Free" and pricing:** the voice settings say "Voice uses Happy Cloud and
  your Happy subscription", and there is purchase code
  (`sources/app/(app)/dev/purchases.tsx`). So the copy makes no claims about
  free use, in-app purchases or subscriptions. Voice isn't mentioned either,
  because it has usage limits.
- **Trademarks:** Apple may reject the brand keywords `gpt` or `grok`. If it
  does, replace them with `automation` or `workflow`. The name already includes
  Codex and Claude Code, so the disclaimer at the end of the description should
  stay.

### Differences from the old `packages/happy-app/Stores.md`

The old file is outdated, so don't use it. It names the app "Happy Coder", only
covers Claude, describes setup through the CLI only and links to GitHub as the
marketing URL. It also says "military-grade" and "same encryption as Signal",
its keywords run to 132 characters, and its What's New reads "Initial release".
Categories haven't changed: App Store Developer Tools / Productivity, and
Google Play Productivity.
