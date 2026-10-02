# Happy 1.8.0 — App Store and Google Play marketing

All store copy is in this document, directly inside `marketing/`. Copy only the
text inside the fenced blocks into the indicated store fields. Screenshot
folders below contain the images to drag into each upload section. Reviewer
notes at the bottom are not for upload. Locale: English (United States).

## Where each field goes

| Console section | Field | Copy in this document |
| --- | --- | --- |
| App Store Connect → App Information | Name | [Shared app name](#shared) |
| App Store Connect → App Information | Subtitle | [App Store subtitle](#app-store-connect--ios-and-ipados) |
| App Store Connect → iOS App → 1.8.0 | Promotional Text, Keywords, Support URL, Marketing URL | [App Store fields](#app-store-connect--ios-and-ipados) |
| App Store Connect → iOS App → 1.8.0 | Description | [Shared full description](#shared-description--app-store-description-and-google-play-full-description) |
| App Store Connect → iOS App → 1.8.0 | What's New in This Version | [Shared release notes](#shared-release-notes--whats-new-in-this-version-and-release-notes) |
| Play Console → Store presence → Main store listing | App name | [Shared app name](#shared) |
| Play Console → Store presence → Main store listing | Short description | [Google Play fields](#google-play-console--android) |
| Play Console → Store presence → Main store listing | Full description | [Shared full description](#shared-description--app-store-description-and-google-play-full-description) |
| Play Console → Store presence → Main store listing | Graphics → Phone / 7-inch tablet / 10-inch tablet screenshots | [Screenshot folders](#screenshots--drag-and-drop-folders) |
| Play Console → Store settings | App category and contact website | [Google Play fields](#google-play-console--android) |
| Play Console → App content → Privacy policy | Privacy policy URL | [Shared privacy policy](#shared) |
| Play Console → Test and release → selected track → Edit release | Release name and Release notes | [Google Play fields](#google-play-console--android) |

## Screenshots — drag-and-drop folders

Select the five PNG files inside the folder for the specific upload section.

| Store upload section | Exact image dimensions | Folder |
| --- | --- | --- |
| **App Store: iPhone 6.5-inch Display** | **1284 × 2778** | [iphone-6.5-inch-1284x2778](app-store/en-US/iphone-6.5-inch-1284x2778/) |
| App Store: iPhone 6.9-inch Display | 1320 × 2868 | [iphone](app-store/en-US/iphone/) |
| App Store: iPad 13-inch Display | 2064 × 2752 | [ipad](app-store/en-US/ipad/) |
| Google Play: Phone screenshots | 1080 × 1920 | [phone](google-play/en-US/phone/) |
| Google Play: 7-inch tablet screenshots | 1920 × 1080 | [tablet-7](google-play/en-US/tablet-7/) |
| Google Play: 10-inch tablet screenshots | 1920 × 1080 | [tablet-10](google-play/en-US/tablet-10/) |

For the App Store slot asking for 1242 × 2688 or 1284 × 2778, use only
`iphone-6.5-inch-1284x2778`. The folder named `iphone` is the 6.9-inch set.

## Logo and store icons

| Use / store section | Exact dimensions | File |
| --- | --- | --- |
| Current Happy logo | 1024 × 1024 | [logo.png](logo.png) |
| App Store app icon — supplied by the native build | 1024 × 1024 | [app-icon-1024x1024.png](app-store/app-icon-1024x1024.png) |
| Google Play → Main store listing → Graphics → App icon | 512 × 512 | [app-icon-512x512.png](google-play/app-icon-512x512.png) |

These opaque RGB/sRGB exports use the current H logo and galaxy background from
the mobile app's configured `icon.png`. Apple gets its app icon from the build;
there is no separate screenshot-slot upload for it.

Google Play's Feature graphic is a separate 1024 × 500 field. No replacement
feature graphic is prepared here; retain the existing Console asset.

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

**Privacy policy URL** (live page "Privacy Policy — Happy"; tracked source [`PRIVACY.md`](../PRIVACY.md))

```
https://happy.engineering/privacy
```

### App Store Connect — iOS and iPadOS

App Information → **Name**: use the shared app name above.
App Information → **Primary Category**: Developer Tools.
App Information → **Secondary Category**: Productivity.
The following copy goes in the **1.8.0 version** fields, except Subtitle, which
is under App Information.

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

**Description**: paste the [shared full description](#shared-description--app-store-description-and-google-play-full-description).

**What's New in This Version**: paste the [shared release notes](#shared-release-notes--whats-new-in-this-version-and-release-notes).

**Support URL**

```
https://github.com/slopus/happy/issues
```

**Marketing URL**: `https://happy.engineering`.

**Privacy Policy URL**: `https://happy.engineering/privacy`, under App Privacy.

**App Previews and Screenshots**: use the App Store folders in the table above.

### Google Play Console — Android

**Main store listing → App name**: use the shared app name above.

**Short description** (78 / 80)

```
Run Claude Code and Codex on your computer. Steer and approve from your phone.
```

**Main store listing → Full description**: paste the [shared full description](#shared-description--app-store-description-and-google-play-full-description).

**Main store listing → Graphics**: upload the corresponding Phone, 7-inch tablet,
and 10-inch tablet folders above. Google Play has no App Store-style Subtitle,
Promotional Text, or Keywords field.

**Store settings → App or game**: App.

**Store settings → App category**: Productivity.

**Store settings → Store listing contact details → Website**

```
https://happy.engineering
```

**Store listing contact details → Email address**: keep the existing verified
support email in Play Console; no replacement email is supplied in this draft.

**App content → Privacy policy**

```
https://happy.engineering/privacy
```

**Selected track → Edit release → Release name** (internal Console label)

```
1.8.0
```

**Selected track → Edit release → Release notes**: paste this complete block,
including the language tags:

```
<en-US>
• Easier setup: link your computer from one checklist, with troubleshooting and a Get help button
• Bots: create one from your phone, give it a face and a name, and start talking
• Drafts sync between your phone and desktop, and you can see when the agent picks up a sent message
• Colored diffs, including a workspace's full branch changes
• Projects: group checkouts, with their chats as tabs
• Paste a picture straight from your clipboard
• Faster chats and more reliable history loading
</en-US>
```

### Shared description — App Store Description and Google Play Full description

2,474 / 4,000 characters. Use the same block in both stores.

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

### Shared release notes — What's New in This Version and Release notes

490 characters. App Store limit: 4,000. Google Play limit: 500 per language.
Google Play's complete language-tagged block is included in its section above.

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
