<div align="center">

<h1>Any Model. Your Team.<br><em>Happy Harness.</em></h1>

<p>Free and open source</p>

</div>

https://github.com/user-attachments/assets/d193098c-4c60-440b-b91e-274a76d923d5

<p align="center">
<a href="https://happy.engineering/#download"><img width="245" height="56" alt="Download Desktop for macOS, Windows, and Linux" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/download-desktop.svg" /></a>
</p>

<p align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="150" height="56" alt="Download on the App Store. Rated 4.9 stars from 1,000+ ratings" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/app-store-rating.svg" /></a>&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="150" height="56" alt="Get it on Google Play. Rated 5.0 stars from 3.1k+ reviews" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/google-play-rating.svg" /></a>
</p>

## What you get

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

## How Happy fits together

| Repository                                                                            | What it is                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[slopus/happy](https://github.com/slopus/happy)** ← this repository | **The mobile app (iOS, Android, web), the original CLI, and the relay server** |
| [slopus/happy-desktop](https://github.com/slopus/happy-desktop) | The desktop app for macOS, Windows, and Linux |
| [slopus/happy-agent](https://github.com/slopus/happy-agent)                           | Happy Agent, the open-source agent runtime the desktop app runs on         |
| [slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)                 | The website and docs at happy.engineering                                  |

## Original Happy CLI

The original CLI wraps the Claude Code and Codex harnesses directly in your
terminal and lets you continue from your phone.

For multi-model sessions and teams, move to the desktop app and Happy Harness.

```sh
npm install -g happy

# Start Claude Code
happy claude

# Or start Codex
happy codex
```

- [happy-app](packages/happy-app): the Happy mobile app and web client (Expo)
- [happy-cli](packages/happy-cli): the original Happy CLI (`happy` on npm)
- [happy-agent](packages/happy-agent): remote session control for the original Happy CLI (not the Happy Agent runtime)
- [happy-server](packages/happy-server): the relay server for encrypted sync

Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

---

<p align="center">
<a href="https://happy.engineering/">Website</a> · <a href="https://happy.engineering/desktop/docs/">Documentation</a> · <a href="https://discord.gg/fX9WBAhyfD">Discord</a> · <a href="docs/CONTRIBUTING.md">Development guide</a> · <a href="LICENSE">MIT License</a>
</p>
