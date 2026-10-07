> **Happy is now a desktop app.** The original Happy CLI (`happy` on npm, formerly `happy-coder`) is in maintenance mode: it keeps working and still gets critical fixes, but new features ship in the [Happy desktop app](https://happy.engineering/). The Happy mobile app (Claude Code and Codex on iOS and Android) works with both.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/logotype-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/logotype-light.png">
  <img src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/logotype-dark.png" width="400" height="106" alt="Happy">
</picture>

<h1>Any Model. Your Team.<br><em>Happy Harness.</em></h1>

<p>Free and open source</p>

</div>

https://github.com/user-attachments/assets/d193098c-4c60-440b-b91e-274a76d923d5

<p align="center">
<b>⬇️&nbsp;&nbsp;Download for macOS:</b>&nbsp; <a href="https://github.com/slopus/happy-desktop/releases/download/v0.0.90/Happy-0.0.90-arm64.dmg"><b>Apple Silicon</b></a> · <a href="https://github.com/slopus/happy-desktop/releases/download/v0.0.90/Happy-0.0.90-x64.dmg"><b>Intel</b></a>
</p>

```sh
brew install --cask slopus/tap/happy
```

<p align="center">
<a href="https://github.com/slopus/happy-desktop/releases/download/v0.0.90/Happy-0.0.90-x64.exe">Windows</a> · <a href="https://github.com/slopus/happy-desktop/releases/download/v0.0.90/Happy-0.0.90-x64.AppImage">Linux x64</a> · <a href="https://github.com/slopus/happy-desktop/releases/download/v0.0.90/Happy-0.0.90-arm64.AppImage">Linux arm64</a> · <a href="https://github.com/slopus/happy-desktop/releases">All releases</a>
</p>

<p align="center">
<sub>Windows: if SmartScreen says "Windows protected your PC", click <b>More info → Run anyway</b>. &nbsp;·&nbsp; Linux: <code>chmod +x</code> the AppImage.</sub>
</p>

<table align="center">
<tr>
<td align="center"><a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="Download on the App Store" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a><br>★★★★★ <b>4.9</b> · 1,000+ ratings</td>
<td align="center"><a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="Get it on Google Play" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a><br>★★★★★ <b>5.0</b> · 3.1k+ reviews</td>
</tr>
</table>

## What you get with Happy

1. **Multi-provider within one session.** Astra, Fable, and Grok in the same
   session. Switch models in the middle of a task or delegate to subagents.
2. **Natively multiplayer.** Invite a colleague or a friend into the session.
   You both watch the same agent work, and either of you can steer it.
3. **Reuse current subscriptions.** Sign in with the Claude, Codex, and Grok
   plans you already pay for. Happy adds a harness, not another bill.
4. **Open source MIT.** It runs on your own hardware and your projects stay
   ordinary folders. Read the code, fork it, ship your own build.
5. **End-to-end encrypted mobile app.** Left your desk? The same sessions are
   already on your phone, and what moves between your devices is encrypted.

## Already using Happy?

Your existing account and sessions still work. Connect Desktop from
**Settings → Mobile Access**.

## Love your terminal? Keep it.

The OG Happy experience (for those who have been around :D)

Start Claude Code or Codex in your terminal. Resume that session or start a new
one from your phone. No Desktop app required.

```sh
# Not using Happy Desktop?
# Install the CLI here:
npm install -g happy

# Start Claude Code
happy claude

# Or start Codex
happy codex
```

Using Desktop? Onboarding handles this setup for you.

## How Happy fits together

| Repository                                                                            | What it is                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **[slopus/happy](https://github.com/slopus/happy)** ← this repository | **The Happy mobile app (iOS, Android, web), the original Happy CLI, and the relay server** |
| [slopus/happy-desktop](https://github.com/slopus/happy-desktop) | The Happy desktop app for macOS, Windows, and Linux |
| [slopus/happy-agent](https://github.com/slopus/happy-agent)                           | Happy Agent, the open-source agent runtime the desktop app runs on                     |
| [slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)                 | The website and docs at happy.engineering                                              |

## Original Happy CLI

Happy Coder is the mobile and web client for Claude Code and Codex: push notifications, voice, switch between devices with one keypress, end-to-end encrypted.

[Web app](https://app.happy.engineering) · [Demo video](https://youtu.be/GCS0OG9QMSE) · [CLI docs](https://happy.engineering/docs/) · [CLI README](packages/happy-cli/README.md) · [Contributing](docs/CONTRIBUTING.md)

- [happy-app](packages/happy-app): the Happy mobile app and web client (Expo)
- [happy-cli](packages/happy-cli): the original Happy CLI (`happy` on npm)
- [happy-agent](packages/happy-agent): remote session control for the original Happy CLI (not the Happy Agent runtime)
- [happy-server](packages/happy-server): the relay server for encrypted sync

Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

---

<p align="center">
<a href="https://happy.engineering/">Website</a> · <a href="https://happy.engineering/desktop/docs/">Documentation</a> · <a href="https://discord.gg/fX9WBAhyfD">Discord</a> · <a href="docs/CONTRIBUTING.md">Development guide</a> · <a href="LICENSE">MIT License</a>
</p>
