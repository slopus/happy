---
name: release
description: >
  Release pipeline for CLI, mobile, web, and server. Guides through version
  bumping, building, testing, publishing, and deploying. Replaces the old
  interactive release-it flow with a Claude Code-native experience.
  Use when user types /release or asks to release, publish, deploy, or ship
  any component.
---

# Release

You are the release operator for the Happy monorepo. When invoked, walk the user through releasing the component they choose.

## Step 1: Pick a target

Ask which component to release:

- **CLI** — npm package `happy`
- **Mobile** — Expo/EAS builds for iOS + Android
- **Web** — Docker image + K8s deploy via TeamCity
- **Server** — Docker image + K8s deploy via TeamCity
- **Docs** — GitHub Pages (separate repo)

Present these as options. Wait for the user to pick.

---

## CLI Release

    Package:     packages/happy-cli
    npm name:    happy
    Registry:    https://registry.npmjs.org
    Git tags:    cli-{version}

Tag namespace note:
- CLI releases use `cli-X.Y.Z`
- Native releases use `native-<runtime-version>`
- OTA releases use `ota-<ota-version>`
- Do not use a bare `vX.Y.Z` tag for Happy releases because multiple release streams coexist in this repo

### Step 2: Gather state

Run these in parallel:
1. `npm view happy dist-tags` — see current latest + beta
2. `cat packages/happy-cli/package.json | grep version` — local version
3. `git status --short` — check for dirty state
4. `git branch --show-current` — confirm branch
5. `git log --oneline -10` — recent commits for release notes context

Present a summary:
```
Local version:  X.Y.Z
npm latest:     X.Y.Z
npm beta:       X.Y.Z-N
Branch:         main
Working tree:   clean / dirty
```

### Step 3: Pick channel and version

Ask the user:
- **Channel**: `latest` or `beta`
- **Bump type**: For latest: `patch`, `minor`, `major`. For beta: `prerelease` (appends `-N`), or explicit version.

Suggest a sensible default based on the current state. For beta, the next prerelease of the current version. For latest, a patch bump.

Present as options. Wait for confirmation.

### Step 4: Version bump

Edit `packages/happy-cli/package.json` directly — do NOT use `npm version` (it chokes on pnpm workspace protocol).

IMPORTANT: do this **before** build/test for the CLI. The build imports `package.json` and bakes the version into the generated bundle. If you build first and bump later, `happy --version` can still report the old prerelease version even though npm metadata shows the new one.

### Step 5: Build

```bash
cd packages/happy-cli
pnpm --filter happy run build
```

Report success/failure. Stop on failure.

### Step 5b: Self-host server split

The `happy` npm package no longer bundles the self-host server binary or webapp.
Packaged installs resolve those from the separately installed
`happy-server-self-host` package. Do not rebuild or ship `tools/server` or
`tools/webapp` as part of a CLI release.

If the CLI release depends on self-host server changes, release
`happy-server-self-host` separately: regenerate Prisma, build the bundled webapp
with `pnpm --filter happy-server-self-host run bundle:webapp`, then publish the
server package. The server package is a JS/TS npm package; npm handles platform
specific dependencies such as Prisma and sharp normally. Do not pass
`--ignore-scripts` when publishing it; its `prepublishOnly` script rebuilds the
runtime, rebuilds the webapp, and runs tests before npm receives the tarball.

Before handing a server publish to the user, pre-run the full `prepublishOnly`
chain yourself to catch failures early — the `bundle:webapp` step runs a multi-minute
`expo export`, and the server unit suite is **not** part of the GitHub CI gate, so
`main` can be red even when the PR "passed":

```bash
cd packages/happy-server && pnpm run build && pnpm run bundle:webapp && pnpm test
```

(Observed: `1332` merged a `standalone.spec.ts` test that only passes on Windows
because the impl used POSIX `path.basename`; it was red on `main` and would have
aborted the publish at the `prepublishOnly` test step.)

### Step 6: Test (unit only)

```bash
cd packages/happy-cli
pnpm --filter happy exec vitest run --project unit
```

Integration tests are slow and flaky — skip them for releases. Unit tests are the gate.
Expect the unit suite to take around a minute; `src/utils/serverConnectionErrors.test.ts` is particularly slow, so don't mistake a long run for a hang.

Report results. If failures, ask the user whether to proceed or abort.

### Step 7: Publish

```bash
cd packages/happy-cli
pnpm publish --tag {channel} --no-git-checks
```

- `--no-git-checks`: allows dirty working tree (we already verified state)

⚠️ **NEVER pass `--ignore-scripts`.** `prepublishOnly` runs `pnpm test` (build +
unit tests), and **the build re-stamps the version into the bundle** (Step 4).
Skipping it ships whatever stale `dist/` happens to be on disk. Two rationalizations
look reasonable and are both WRONG:

- *"We already built + tested this session, so the scripts are redundant — skip them
  to go faster."* That earlier build may predate the version bump (or a dependency
  change). The on-disk `dist/` is then stamped with the OLD version, and
  `--ignore-scripts` ships it. **This actually happened: `1.1.10-beta.9` was published
  with `--ignore-scripts` and shipped a bundle stamped `beta.8`** — `happy --version`
  reported `beta.8` while npm metadata said `beta.9`. npm versions are immutable, so
  the only fix was bumping to `beta.10` and re-releasing. A wasted version number and
  a broken publish, to save one ~1-minute rebuild.
- *"It makes the TLS-failure retries faster."* The `prepublishOnly` rebuild on each
  retry is the price of correctness, not overhead to trim. If retries are painful,
  change the network (see the TLS note above) — do NOT skip scripts.

If you catch yourself reasoning toward `--ignore-scripts`, stop: there is no case in
this repo where it is correct for a publish.

**MUST use `pnpm publish` — never `npm publish`.** This is a pnpm workspace; `npm
publish` mis-resolves the workspace protocol and the `bin` entries and ships a
broken tarball (a regression was reported for exactly this and the fix was to
standardize on `pnpm publish`). `pnpm publish` is the only supported path. Do not
"fall back" to `npm publish` if pnpm errors — diagnose the pnpm error instead.

**Transient TLS upload failures are expected — retry, don't panic.** The tarball
is large (~160 MB, ~1000 files). The upload to `registry.npmjs.org` frequently
dies mid-stream with:

```
npm error code ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC
npm error ... ssl3_read_bytes:ssl/tls alert bad record mac ...
```

This is network-layer corruption of a single TLS record on the long upload, **not**
a code, auth, or version problem. A single bad record kills the whole stream, so
each fresh attempt has an independent chance to complete. Just re-run the exact
same `pnpm publish` command — it typically succeeds within 2–3 attempts (it took
3 on the 1.1.10-beta.4 release). Before each retry, confirm it did NOT actually
land (see Step 8); npm rejects re-publishing an already-published version, which
would be a misleading error. A clean success prints `+ happy@X.Y.Z`.

### Step 8: Verify

```bash
npm view happy@{version} version   # did the version actually publish?
npm view happy dist-tags           # did the channel tag move?
```

Check `npm view happy@X.Y.Z version` first — it returns the version string if the
publish landed (use this between TLS retries to avoid double-publishing, and to
distinguish a real failure from a cosmetic upload error).

⚠️ **This metadata check is necessary but NOT sufficient.** `npm view ... version`
only confirms the tarball was *accepted* — it says nothing about what's *inside* it.
A bundle stamped with the wrong version (the `--ignore-scripts` footgun above) passes
this check cleanly. The authoritative check is the bundle itself in Step 11
(`happy --version` after a real install). Never report a release as done on the
metadata check alone.

Then confirm the new version appears under the correct dist-tag. The tag often
lags the publish by 10–40s — poll a few times before concluding it failed; npm
tag propagation is not instant.

### Step 9: Git tag + commit (latest only)

For `latest` releases only:
1. Commit the version bump: `Release version X.Y.Z`
2. Tag: `git tag cli-X.Y.Z`
3. Push: `git push && git push --tags`

For `beta` releases: ask the user if they want to commit the version bump or leave it uncommitted.

If `git push` is rejected because `origin/main` advanced while releasing, fetch and rebase the release commit before retrying:
```bash
git fetch origin main
git rebase --autostash origin/main
git tag -f cli-X.Y.Z
git push && git push --tags
```

Use `--autostash` when the worktree is dirty from unrelated local changes so those edits are preserved. Recreate the tag after rebase because the release commit hash changes.

### Step 10: GitHub Release (latest only)

For `latest` releases, create a GitHub release:
```bash
gh release create cli-X.Y.Z --generate-notes --title "cli-X.Y.Z"
```

### Step 11: Install + verify locally

```bash
npm i -g happy@{channel}
happy --version
happy daemon status
```

Report the installed version and daemon status.
The smoke check must confirm that `happy --version` matches the published version, not just npm metadata. If it reports the old version, rebuild after the version bump and cut a corrective patch release.

---

## Mobile Release

    Package:     packages/happy-app
    Variants:    development, preview, production
    Platform:    Expo SDK 54 / React Native 0.81.4

### Build types

**Always ask the user explicitly what they want to release.** Present these
options in order of popularity:

1. **OTA update (preview)** — push JS bundle to preview channel. Most common release type.
2. **OTA update (production)** — push JS bundle to production channel. Do this after preview OTA is validated.
3. **Native dev build** — when native code changes. Points to dev server with bundled app.
4. **Full native release** — build all profiles (dev + preview + production) to prep for a new native release.

#### OTA Updates

  ```bash
  # Preview (most common)
  pnpm --filter happy-app run ota

  # Production
  pnpm --filter happy-app run ota:production
  ```

OTA scripts require a message — stdin is not readable from Claude Code, so run the
underlying `eas update` directly with `--message`:
  ```bash
  cd packages/happy-app && APP_ENV=preview NODE_ENV=preview tsx sources/scripts/parseChangelog.ts && pnpm typecheck && eas update --branch preview --message "<message>"
  ```

#### Native Builds

- **Dev build** — development profile, used when native code changes (points to dev server)
  ```bash
  cd packages/happy-app && eas build --profile development --platform all --non-interactive
  ```

- **TestFlight / Play Store builds** — use `-store` profiles for distribution via TestFlight and Play Store.
  **Always pass `--auto-submit`** so the build goes straight to TestFlight after completion.
  ```bash
  # Preview (TestFlight/internal testing)
  cd packages/happy-app && eas build --profile preview-store --platform ios --non-interactive --auto-submit

  # Dev (TestFlight, points to dev server)
  cd packages/happy-app && eas build --profile development-store --platform ios --non-interactive --auto-submit

  # Production (App Store / Play Store submission)
  cd packages/happy-app && eas build --profile production --platform ios --non-interactive --auto-submit
  ```

**IMPORTANT:** Always pass `--non-interactive` to `eas build` commands. Without it,
EAS prompts for Apple account login interactively which breaks in non-TTY contexts
(Claude Code, CI). Remote credentials are already configured on EAS servers.

**IMPORTANT:** Always pass `--auto-submit` to `-store` builds. Without it, the build
finishes but never reaches TestFlight — you have to manually submit with `eas submit`.

### EAS Build Profiles

    Profile              Distribution   Channel       Notes
    development-store    store          development   Dev build via TestFlight
    preview-store        store          preview       TestFlight / Play Store internal testing
    production           store          production    App Store / Play Store submission

---

#### Internal / ad-hoc profiles (rarely used)

These install via direct link, NOT TestFlight. Almost never needed — prefer
the `-store` profiles above.

    Profile              Distribution   Channel
    development          internal       development
    preview              internal       preview

Version source is remote (EAS manages build numbers, auto-incremented).
Runtime version "20" — bump when native code changes to invalidate OTA.

### App Store Connect

    Apple ID:    steve@bulkovo.com
    Team ID:     466DQWDR8C

    App Store Connect App IDs:
    Production:   6748571505  (com.ex3ndr.happy)
    Preview:      6749025570  (com.slopus.happy.preview)
    Development:  6748984254  (com.slopus.happy.dev)

---

## Web Release

    Package:     packages/happy-app (same Expo app, web export)
    Dockerfile:  Dockerfile.webapp
    Image:       docker.korshakov.com/happy-app:{version}
    K8s:         packages/happy-app/deploy/happy-app.yaml (3 replicas)

Web releases go through TeamCity (`Lab_HappyWeb`). The config is in the TeamCity UI, not in the repo.

Flow: `expo export --platform web` -> nginx:alpine static serve -> Docker build -> push -> K8s deploy.

Build args: `POSTHOG_API_KEY`, `REVENUE_CAT_STRIPE`.

Guide the user to trigger the TeamCity build, or help with manual Docker builds if needed.

---

## Server Release

    Package:     packages/happy-server
    Dockerfile:  Dockerfile.server (production), Dockerfile (standalone w/ PGlite)
    Image:       docker.korshakov.com/handy-server:{version}
    K8s:         packages/happy-server/deploy/handy.yaml (1 replica, port 3005)

Server releases go through TeamCity (`Lab_HappyServer`). The config is in the TeamCity UI, not in the repo.

Build: node:20 + python3 + ffmpeg, builds happy-wire + happy-server.
Secrets from Vault: handy-db, handy-master, handy-github, handy-files, handy-e2b, handy-revenuecat, handy-elevenlabs.
Redis: happy-redis StatefulSet (redis:7-alpine, 1Gi persistent volume).

Guide the user to trigger the TeamCity build.

---

## Docs Release

    Site:    happy.engineering (GitHub Pages)
    Repo:    github.com/slopus/slopus.github.io

Separate repo, not part of this monorepo. Guide the user to push to that repo.

---

## Writing release notes (the in-app changelog)

`CHANGELOG.md` is regenerated into `changelog.json` and shown **inside the mobile app, on a phone, right after an OTA update**. Write for that reader.

1. **Investigate before writing — use subagents (Opus).** Don't infer from commit titles. Spawn parallel subagents to read the actual code + git history of each candidate change and classify it: user-visible UX vs impl detail, default-on vs gated, new vs polish/fix.
2. **Default-off ⇒ exclude.** A change behind a setting/experimental flag that defaults to OFF (or whose UI entry point is hidden) is a silent ship — omit it until it's on by default. Same for impl / perf-internal / refactor / type-only changes.
3. **Audience is phone users.** Most never touch the CLI or desktop. Be skeptical of CLI-only / desktop-only / web-only / beta-only items — a genuinely strong feature can still be wrong for *this* venue; announce those in CLI release notes / docs / GitHub instead.
4. **Ask, don't assume.** When announce-vs-silent-ship, default state, or scope is unclear, ask the owner and confirm the final include/exclude list before writing. Never headline-announce on your own judgment.
5. **Voice:** benefit-first, terse, em-dash, one line per item, grouped as a dated themed entry like existing ones. Edit `CHANGELOG.md` only, then regenerate via `tsx packages/happy-app/sources/scripts/parseChangelog.ts`.

## Rules

- **Release notes: investigate with subagents, exclude default-off, ask when unsure** — see "Writing release notes" above.
- **Always present options** — never assume which component, channel, or version.
- **Always verify before publishing** — show the user what will be published and get confirmation.
- **Do not bundle self-host server/webapp into `happy`** — self-host runtime and the bundled webapp ship through `happy-server-self-host`, not the main CLI package.
- **Unit tests are the gate, not integration tests** — integration tests are slow and have flaky abort/interrupt tests.
- **Use pnpm publish, not npm publish** — avoids workspace protocol issues.
- **Never use --ignore-scripts for package publishing** — prepublish scripts are the last guard before npm receives the tarball.
- **Never force-push tags** — if a tag exists, stop and ask.
