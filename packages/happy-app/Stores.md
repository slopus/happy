# Paws Distribution Metadata

This document is the source copy for release listings and future store submissions. As of July 2026, the maintained Android distribution is a sideloadable APK on GitHub Releases; do not claim an active Paws App Store or Google Play listing unless one has actually shipped.

## Product Metadata

- **App name:** Paws
- **Short description:** Control AI coding agents from another device
- **Categories:** Developer Tools, Productivity
- **License:** MIT
- **Production package / bundle ID:** `build.paws`
- **Preview package / bundle ID:** `build.paws.preview`
- **Development package / bundle ID:** `build.paws.dev`

## Android Distribution Variants

| Build | Package | OTA channel | runtimeVersion |
|---|---|---|---|
| Production | `build.paws` | `production` | `24` |
| Preview | `build.paws.preview` | `preview` | `23` |
| Development / test | `build.paws.dev` | `preview` | `23` |

This table mirrors `scripts/ota-runtime-config.js` and `ota-runtime-versions.json`. APK release notes and filenames must identify the variant and runtime explicitly.

## Short Listing

Paws is an open-source mobile and web companion for AI coding agents. Start Claude Code, Codex, Gemini, OpenCode, or another ACP-compatible agent on your computer, then follow progress, send instructions, handle permission requests, and remotely start sessions from another device.

## Full Description

Paws keeps long-running AI coding sessions within reach when you leave the terminal. The CLI and daemon run on the computer that has your repository; the App connects through an end-to-end encrypted synchronization layer.

Key capabilities:

- control supported coding agents from Android, web, or desktop experiments;
- receive notifications when a session needs attention;
- switch between local terminal control and remote control;
- send images and supported attachments to agent sessions;
- run multiple sessions and inspect their state from one App;
- operate a self-hosted sync server and web client;
- inspect and modify the complete open-source implementation.

Paws requires a supported agent CLI and account on the computer where the code lives. Model-provider access, usage limits, and charges remain the user's responsibility.

## Search Terms

AI coding agent, Claude Code, Codex, Gemini CLI, OpenCode, ACP, developer tools, remote control, encrypted sync, self-hosted, coding assistant

## Current Distribution URLs

- Product site: <https://paws-landing-eo4.pages.dev>
- Source and support: <https://github.com/wangjs-jacky/happy>
- Android APK releases: <https://github.com/wangjs-jacky/happy/releases>
- CLI package: <https://www.npmjs.com/package/@wangjs-jacky/paws>
- Privacy policy: <https://github.com/wangjs-jacky/happy/blob/main/PRIVACY.md>

## Store Submission Checklist

- Confirm the package ID and version from `app.config.js`.
- Replace GitHub APK language with the actual store URL only after publication.
- Verify screenshots and copy against the current production build.
- Declare current permissions, analytics, push, and third-party integrations accurately.
- Do not reuse upstream Happy store URLs, package IDs, screenshots, reviews, or branding.
