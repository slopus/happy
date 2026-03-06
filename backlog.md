# Backlog

- `happy-agent spawn`: add later, mirroring the app's `spawn-happy-session`
  flow. Not part of the current testing doc work.

- Native dev builds: do not recompile the iOS or Android client for JS-only changes when the development build is already installed and still matches the current native code. Prefer starting Metro against the current env and reusing the installed dev client. Rebuild with `yarn env:ios` or `yarn env:android` only when the build is missing, outdated, or native dependencies/config changed.

- Native app test flow:
  1. Start an authenticated env with `yarn env:up:authenticated` or reuse the current env from `yarn env:current`.
  2. Source the env so Expo picks up the right server and dev auth vars: `source .environments/<env-name>/env.sh`.
  3. For JS-only work, start Metro without recompiling native: `APP_ENV=development yarn --cwd packages/happy-app start --dev-client --port 8081`.
  4. Open the installed simulator or device build from Metro with `i` or `a`, or reopen the dev client onto the Metro URL.
  5. Confirm native auth is correct in Metro logs:
     `credentials ...`
     `📊 Sync: Fetched <n> machines from server`
     `📥 fetchSessions completed - processed <n> sessions`
  6. Verify the target flow in-app. For session quick actions:
     long-press a session row in the session list
     long-press the top-right session avatar in a session
     on web, right-click the same surfaces
