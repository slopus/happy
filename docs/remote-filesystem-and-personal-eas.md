# Remote Filesystem Browsing and Personal EAS Build Notes

This document records the local changes, validation, packaging steps, and caveats for the remote filesystem browsing work.

## Branch and Commits

Repository fork:

- `zzzzwwwssssss-ux/happyloacl`

Working branch:

- `codex-remote-filesystem-browser`

Relevant commits:

- `b7008602 Add remote filesystem browsing for Happy`
- `e4b9b1c0 Add personal EAS build switch`
- `443b47ba Add personal preview EAS profile`

## Feature Scope

The change adds remote directory browsing when creating a new Happy session.

Main behavior:

- The remote `happy` CLI/daemon can list directories on the selected machine.
- The app's new-session path picker can browse folders from the selected remote machine.
- Users can go to parent folders, refresh, handle offline states, and select a remote path.
- Codex tool display was also adjusted so approval records and execution records can merge when Codex reports different IDs for the same approved command.
- Late Codex messages now keep their turn ID when available, reducing dropped agent responses in the app UI.

## Changed Areas

Remote filesystem RPC:

- `packages/happy-cli/src/api/apiMachine.ts`

App sync API:

- `packages/happy-app/sources/sync/ops.ts`

App new-session UI:

- `packages/happy-app/sources/app/(app)/new/index.tsx`

Codex display and permission merge:

- `packages/happy-app/sources/sync/reducer/reducer.ts`
- `packages/happy-app/sources/sync/reducer/reducer.spec.ts`
- `packages/happy-cli/src/codex/codexAppServerClient.ts`
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`
- `packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts`

Personal EAS build support:

- `packages/happy-app/app.config.js`
- `packages/happy-app/eas.json`

## Validation Already Run

The following checks passed locally:

```powershell
pnpm.cmd --filter @slopus/happy-wire build
pnpm.cmd --filter happy-app typecheck
pnpm.cmd --filter happy typecheck
pnpm.cmd --filter happy-app exec vitest run sources/sync/reducer/reducer.spec.ts
pnpm.cmd --filter happy exec vitest run src/codex/__tests__/sessionProtocolMapper.test.ts
```

## Runtime Update Requirements

Both the app and the remote machine-side CLI/daemon must be updated.

Updating only the app is not enough because remote directory browsing depends on a new machine RPC handler in `happy` CLI/daemon.

On each machine that should expose its filesystem to the app:

```powershell
pnpm --filter happy cli:install
happy.cmd daemon status
happy.cmd codex
```

On Linux/macOS, use `happy` instead of `happy.cmd`.

## Personal EAS Build

The official app config is owned by:

- owner: `bulkacorp`
- projectId: `4558dd3d-cd5a-47cd-bad9-e591a241cc06`

The current personal account did not have permission to build that official EAS project, so a personal EAS project was created for test builds:

- owner: `zzzzwws`
- project: `happy`
- projectId: `1d89df57-549b-484e-aa13-9e708f279188`

The app config now supports a local switch:

```powershell
$env:HAPPY_PERSONAL_EAS='1'
```

When this is set, `app.config.js` uses the personal EAS owner and project ID. Otherwise, it keeps the official `bulkacorp` settings.

Use this profile for personal Android preview builds:

```powershell
$env:EXPO_TOKEN='<expo-token>'
$env:HAPPY_PERSONAL_EAS='1'
npx.cmd eas-cli@latest build --profile personal-preview --platform android --wait --non-interactive
```

The `personal-preview` profile is defined in `packages/happy-app/eas.json` and sets `HAPPY_PERSONAL_EAS=1` inside the EAS cloud build environment. This is required because the cloud build re-evaluates `app.config.js`.

## Build Attempts

Failed attempts:

- `77559e93-1335-499c-8992-a2c5d01c1d5d`
- `a1d3a810-260d-49ca-96a3-7472dfa1e174`
- `60f17536-7434-4650-bb8e-f6ce3bb0718f`

Root cause:

- EAS cloud build did not have `HAPPY_PERSONAL_EAS=1`, so `app.config.js` used the official project ID while building under the personal project.

Current active build after adding `personal-preview`:

- `3cbbf821-e776-4e2f-8021-edbd07a0caf4`
- Logs: `https://expo.dev/accounts/zzzzwws/projects/happy/builds/3cbbf821-e776-4e2f-8021-edbd07a0caf4`

At the last check, this build was still `in progress`.

## Important Caveats

- The personal EAS build is for testing only. It should not be treated as an official `bulkacorp` release.
- Do not remove the default official owner/project settings from `app.config.js`.
- Do not use the `personal-preview` profile for official releases.
- If the Expo token was shared in chat or logs, revoke it after use and create a new one.
- The local files `packages/happy-cli/bin/happy.mjs` and `packages/happy-cli/bin/happy-mcp.mjs` may appear modified after local CLI install/build. They were treated as local build/link noise and intentionally not committed.
- The EAS archive was about 242 MB. A future `.easignore` cleanup could reduce upload time.
- EAS reported a warning about `watcher.unstable_workerThreads`; this warning did not block upload or build submission.

## Useful Commands

Check latest EAS builds:

```powershell
$env:EXPO_TOKEN='<expo-token>'
$env:HAPPY_PERSONAL_EAS='1'
npx.cmd eas-cli@latest build:list --platform android --limit 5
```

View a specific build:

```powershell
$env:EXPO_TOKEN='<expo-token>'
$env:HAPPY_PERSONAL_EAS='1'
npx.cmd eas-cli@latest build:view <build-id>
```

Run local checks before another build:

```powershell
pnpm.cmd --filter happy-app typecheck
pnpm.cmd --filter happy typecheck
pnpm.cmd --filter happy-app exec vitest run sources/sync/reducer/reducer.spec.ts
pnpm.cmd --filter happy exec vitest run src/codex/__tests__/sessionProtocolMapper.test.ts
```
