# Fork Changes Summary

This document catalogs all changes made in the `rrnewton` fork compared to the
upstream Happy repositories. Use this as a checklist when upstreaming changes.

**Starting Points (tagged as `starting-point` in each repo):**
- `happy`: `503b198` - Merge pull request #151 (Claude Sonnet 4.5 update)
- `happy-cli`: `4a9ba96` - Release version 0.11.2
- `happy-server`: `5ba780c` - fix: put -> post

--------------------------------------------------------------------------------
## Feature List

### [BYO-VOICE] Bring-Your-Own Voice Agent
Allow users to configure their own ElevenLabs API key and agent for voice
features instead of relying on the production Happy agent.

**Status:** [ ] Ready for PR

### [SELF-HOSTED] Self-Hosted Server Support
Enable running the Happy stack locally with dynamic server URL detection,
including localhost detection, URL parameter overrides, and custom server
configuration.

**Status:** [ ] Ready for PR

### [CLI-REMOTE] CLI Remote Control Commands
Add `happy list` and `happy prompt` commands for controlling remote sessions
from the CLI, including session listing, filtering, and message sending.

**Status:** [ ] Ready for PR

### [AUTH-FIXES] Authentication Flow Improvements
Various fixes and improvements to authentication including redirect flows,
credential validation, backup key login, and better error handling.

**Status:** [ ] Ready for PR

### [DAEMON-PING] Daemon Ping/Status Testing
Add ability to ping daemons from the web UI and test connectivity.

**Status:** [ ] Ready for PR

### [DEPS-UPGRADE] Dependency Upgrades
Upgrade @anthropic-ai/claude-code from 2.0.14 to 2.0.55 and other dependency
updates.

**Status:** [ ] Ready for PR

### [PROFILE-API] Profile Update API
Add server endpoint for updating user profiles.

**Status:** [ ] Ready for PR

--------------------------------------------------------------------------------
## Parent Repository (All New Files)

All files in the parent `happy-fork` repository are new and provide
infrastructure for self-hosted development and testing.

### Configuration & Documentation
```
CLAUDE.md                 |  3628 bytes | AI coding instructions and conventions
CONTRIBUTING.md           |  3436 bytes | Contribution guidelines
DEPENDENCIES.md           |  2655 bytes | System dependencies documentation
QUICKSTART.md             |  3282 bytes | Quick start guide for self-hosting
README.md                 |   931 bytes | Main README
Makefile                  | 11491 bytes | Build/run orchestration targets
.gitmodules               |   183 bytes | Submodule definitions
.gitignore                |   180 bytes | Git ignore rules
env_setup.sh              |   227 bytes | Environment setup helper
```

### Launch & Build Scripts
```
happy-launcher.sh         | 35256 bytes | Main launcher script with slot system
build_and_run_container.sh|  3149 bytes | Docker container build/run
start-server.sh           |   852 bytes | Server startup helper
setup-postgres.sh         |  2228 bytes | PostgreSQL setup script
```

**Purpose:** `happy-launcher.sh` is the primary orchestration tool, implementing
a "slot" system for running multiple isolated instances of the stack. It handles
starting/stopping servers, web apps, CLI builds, and process management.

### Testing Infrastructure
```
e2e-demo.sh               |  3827 bytes | E2E demo script
e2e-web-demo.sh           |  7767 bytes | Web-based E2E demo script
e2e-tests/                |        dir | Playwright E2E test suite
  - playwright.config.ts  |   616 bytes | Playwright configuration
  - tests/                |        dir | Test specs
  - utils/                |        dir | Test utilities
```

**Purpose:** Automated end-to-end testing with Playwright for the web client.

### Scripts Directory
```
scripts/
  auto-auth.mjs                    |  7455 bytes | Automated auth for testing
  configure-web-client-server.html |  4780 bytes | Web client server config tool
  diagnose-web-client.html         | 11256 bytes | Web client diagnostic tool
  rebase-upstream.sh               |  3201 bytes | Upstream rebase helper
  setup-submodules.sh              |  4795 bytes | Submodule initialization
  setup-test-credentials.mjs       | 13176 bytes | Test credential setup
  test-specific-key.mjs            |  1700 bytes | Key testing utility
  test-web-auth.mjs                |  2474 bytes | Web auth testing
  test-web-client-exact-flow.mjs   |  5795 bytes | Web client flow testing
  validate.sh                      |  6963 bytes | Pre-commit validation script
  verify-server-detection.mjs      |  1966 bytes | Server detection verification
  e2e/                             |        dir | E2E test helpers
  browser/                         |        dir | Browser automation tools
```

**Purpose:** Development and testing utilities for the self-hosted stack.

### CI/CD
```
.github/workflows/ci.yml  |  3129 bytes | GitHub Actions CI workflow
```

**Purpose:** Automated builds and tests on push/PR.

### Dev Container
```
.devcontainer/            |        dir | VS Code devcontainer configuration
```

**Purpose:** Reproducible development environment setup.

### Issue Tracking
```
.beads/                   |        dir | Minibeads issue tracking data
```

**Purpose:** Local issue tracking using the `mb` (minibeads) tool.

--------------------------------------------------------------------------------
## happy (Web/Mobile Client)

**Commits:** 28 new commits
**Summary:** 3013 insertions(+), 363 deletions(-)

### File Changes by Feature

#### [BYO-VOICE] Voice Agent Configuration
```
sources/app/(app)/settings/voice.tsx           | +360 lines | [BYO-VOICE]
```
New UI in voice settings to toggle between default and custom ElevenLabs agent,
with fields for API key and agent ID, plus "Find Agent" and "Create Agent"
buttons that call the ElevenLabs API directly.

```
sources/sync/apiVoice.ts                       | +328 lines | [BYO-VOICE]
```
New file implementing voice token fetching with custom credentials support, plus
direct ElevenLabs API integration for finding/creating agents.

```
sources/components/VoiceAssistantStatusBar.tsx | +225/-75 | [BYO-VOICE]
```
Added mute button, improved status display, and custom agent integration.

```
sources/realtime/RealtimeVoiceSession.tsx      | +20 lines | [BYO-VOICE]
sources/realtime/RealtimeVoiceSession.web.tsx  | +39 lines | [BYO-VOICE]
```
Updated voice session handling to support custom credentials.

```
sources/sync/settings.ts                       | +7 lines  | [BYO-VOICE]
```
Added settings keys for ElevenLabs credentials.

```
sources/text/_default.ts (and translations)    | +86 each  | [BYO-VOICE]
```
Added i18n strings for voice settings in all supported languages.

#### [SELF-HOSTED] Self-Hosted Server Support
```
sources/sync/serverConfig.ts                   | +101/-15  | [SELF-HOSTED]
```
Major rewrite of server URL resolution: dynamic mode for self-hosted setups,
URL hash/param overrides for runtime port binding, localhost auto-detection.

```
sources/app/(app)/server.tsx                   | +171/-30  | [SELF-HOSTED]
```
Enhanced Server Configuration page with connection status display, server info,
and reload functionality.

```
sources/app/(app)/settings/account.tsx         | +185/-40  | [SELF-HOSTED]
```
Added CLI login command display, username editing, improved account info.

```
sources/app/(app)/terminal/connect.tsx         | +27 lines | [SELF-HOSTED]
```
Support for server URL override in terminal connect URLs.

```
sources/app/_layout.tsx                        | +64/-20   | [SELF-HOSTED]
```
Improved app initialization and server detection.

```
.env.example                                   | +9 lines  | [SELF-HOSTED]
```
New example environment file for local development.

#### [AUTH-FIXES] Authentication Improvements
```
sources/auth/AuthContext.tsx                   | +7 lines  | [AUTH-FIXES]
sources/auth/authApprove.ts                    | +42 lines | [AUTH-FIXES]
sources/auth/authGetToken.ts                   | +26 lines | [AUTH-FIXES]
```
Improved error handling, debug logging, and flow fixes.

```
sources/app/(app)/restore/manual.tsx           | +49 lines | [AUTH-FIXES]
```
Fixed restore flow redirect issues.

```
sources/encryption/hmac_sha512.ts              | +57 lines | [AUTH-FIXES]
```
Added pure JS SHA-512 fallback for insecure contexts (HTTP).

```
sources/utils/randomUUID.ts                    | +53 lines | [AUTH-FIXES]
```
Fixed randomUUID for HTTP contexts where crypto.randomUUID is unavailable.

#### [DAEMON-PING] Daemon Status/Ping
```
sources/app/(app)/machine/[id].tsx             | +150 lines | [DAEMON-PING]
```
Added "Ping Daemon" button, improved machine/daemon status display.

```
sources/utils/machineUtils.ts                  | +43 lines | [DAEMON-PING]
```
Utilities for daemon status checking.

#### Other Changes
```
sources/sync/apiProfile.ts                     | +60 lines | [PROFILE-API]
```
New file for profile update API calls.

```
sources/toast/                                 | +330 lines | [UI]
```
New toast notification system (ToastManager, ToastProvider, types).

```
sources/components/AgentInput.tsx              | +63 lines | [UI]
```
New reusable input component for agent configuration.

```
sources/sync/sync.ts                           | +32 lines | [MISC]
sources/sync/storage.ts                        | +56 lines | [MISC]
sources/sync/ops.ts                            | +23 lines | [MISC]
```
Various sync improvements and storage enhancements.

--------------------------------------------------------------------------------
## happy-cli

**Commits:** 33 new commits
**Summary:** 1695 insertions(+), 237 deletions(-)

### File Changes by Feature

#### [CLI-REMOTE] Remote Control Commands
```
src/commands/list.ts                           | +525 lines | [CLI-REMOTE]
```
New `happy list` command for listing remote sessions with filtering, recent
message display, and current working directory from Claude session files.

```
src/commands/prompt.ts                         | +285 lines | [CLI-REMOTE]
```
New `happy prompt` command for sending prompts to remote sessions, with
configurable timeout, output formatting, and tool error handling.

```
src/index.ts                                   | +148 lines | [CLI-REMOTE]
```
Added CLI argument parsing for new commands, --yolo flag for bypass permissions,
--version fix to exit immediately.

```
src/parsers/specialCommands.ts                 | +48 lines | [CLI-REMOTE]
```
Added /happy-status command for testing message flow.

#### [AUTH-FIXES] Authentication Improvements
```
src/commands/auth.ts                           | +259 lines | [AUTH-FIXES]
```
Major enhancements: merged auth account into auth status, backup key login,
account info commands, credential validation, server URL display.

```
src/ui/auth.ts                                 | +15 lines | [AUTH-FIXES]
```
Improved auth UI display.

```
src/ui/doctor.ts                               | +92 lines | [AUTH-FIXES]
```
Enhanced doctor command with credential checking.

```
src/utils/backupKey.ts                         | +65 lines | [AUTH-FIXES]
```
Backup key login functionality.

#### [SELF-HOSTED] Self-Hosted Support
```
src/api/api.ts                                 | +35 lines | [SELF-HOSTED]
```
Server URL parameter support in API calls.

#### [DAEMON-PING] Daemon Ping
```
src/api/apiMachine.ts                          | +11 lines | [DAEMON-PING]
```
Added ping RPC handler to daemon for connectivity testing.

#### [DEPS-UPGRADE] Dependency Upgrades
```
package.json                                   | +5 lines  | [DEPS-UPGRADE]
yarn.lock                                      | +80 lines | [DEPS-UPGRADE]
```
Upgraded @anthropic-ai/claude-code from 2.0.14 to 2.0.55, added
@elevenlabs/elevenlabs-js.

#### Encryption & API Changes
```
src/api/encryption.ts                          | +44 lines | [MISC]
```
Fixed encryption key derivation, dataKeySeed handling.

```
src/api/types.ts                               | +4 lines  | [MISC]
src/api/webAuth.ts                             | +17 lines | [MISC]
```
Type updates and web auth improvements.

#### Claude Integration
```
src/claude/claudeRemote.ts                     | +67 lines | [MISC]
src/claude/runClaude.ts                        | +20 lines | [MISC]
src/claude/session.ts                          | +5 lines  | [MISC]
```
Various Claude integration improvements.

#### Utilities
```
src/utils/time.ts                              | +43 lines | [MISC]
```
Added formatTimeAgo utility for relative time display.

```
src/utils/MessageQueue.ts                      | -137 lines | [MISC]
```
Removed unused MessageQueue utility.

--------------------------------------------------------------------------------
## happy-server

**Commits:** 7 new commits
**Summary:** 173 insertions(+), 22 deletions(-)

### File Changes by Feature

#### [BYO-VOICE] Voice Token Endpoint Updates
```
sources/app/api/routes/voiceRoutes.ts          | +95/-27   | [BYO-VOICE]
```
Modified `/v1/voice/token` endpoint to accept optional `customAgentId` and
`customApiKey` parameters. When provided, uses client credentials instead of
server defaults. Improved error handling with detailed ElevenLabs error messages.

#### [PROFILE-API] Profile Update API
```
sources/app/api/routes/accountRoutes.ts        | +98 lines | [PROFILE-API]
```
New file with profile update endpoint.

#### Other Changes
```
.env.dev                                       | +1 line   | [MISC]
.gitignore                                     | +1 line   | [MISC]
sources/storage/__testdata__/image.jpg         | binary    | [MISC]
```
Added REDIS_URL to dev env, test fixture image.

--------------------------------------------------------------------------------
## PR Checklist

When upstreaming, create separate PRs for each feature:

### Voice Agent (BYO-VOICE) PR
- [ ] happy: Voice settings UI changes
- [ ] happy: apiVoice.ts
- [ ] happy: VoiceAssistantStatusBar changes
- [ ] happy: settings.ts additions
- [ ] happy: i18n strings for voice
- [ ] happy-server: voiceRoutes.ts changes
- [ ] happy-cli: @elevenlabs/elevenlabs-js dependency

### Self-Hosted (SELF-HOSTED) PR
- [ ] happy: serverConfig.ts
- [ ] happy: server.tsx
- [ ] happy: .env.example
- [ ] happy: terminal connect changes
- [ ] happy-cli: API server URL support
- [ ] Parent repo infrastructure (optional, may keep separate)

### CLI Remote Control (CLI-REMOTE) PR
- [ ] happy-cli: list.ts
- [ ] happy-cli: prompt.ts
- [ ] happy-cli: index.ts changes
- [ ] happy-cli: time.ts utilities

### Auth Improvements (AUTH-FIXES) PR
- [ ] happy: AuthContext, authApprove, authGetToken
- [ ] happy: hmac_sha512.ts, randomUUID.ts
- [ ] happy: restore/manual.tsx
- [ ] happy-cli: auth.ts enhancements
- [ ] happy-cli: backupKey.ts

### Daemon Ping (DAEMON-PING) PR
- [ ] happy: machine/[id].tsx
- [ ] happy: machineUtils.ts
- [ ] happy-cli: apiMachine.ts ping handler

### Profile API (PROFILE-API) PR
- [ ] happy: apiProfile.ts
- [ ] happy-server: accountRoutes.ts

### Dependencies (DEPS-UPGRADE) PR
- [ ] happy-cli: Claude Code SDK upgrade (2.0.14 -> 2.0.55)
