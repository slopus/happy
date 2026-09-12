# expo-tailcat

This is a standalone Expo module, not an integration into happy-app.

- Never publish or create a release without an explicit user request.
- Run cheap JS/package checks and local Go tests before native CI.
- Native CI is manual and platform-selectable. Do not enable per-push mobile builds.
- Tests use a private, local DERP relay. Never use the public relay fleet in automated tests.
- Treat Tailcat addresses and local endpoint capability paths as secrets; do not log them.
- Native artifacts are built ahead of publishing, never downloaded during consumer installation.
- Keep Go/mobile dependencies pinned and test real HTTP and WebSocket traffic through Tailcat.