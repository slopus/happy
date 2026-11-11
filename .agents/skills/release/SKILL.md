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

## Step 0: Where you release from (never skipped)

**Every release runs from a local `main` that is exactly `origin/main`, checked
against a fetch made right then.** Not from a worktree. Not from a branch. Not
from a `main` that is ahead by an unpushed commit or behind by anyone else's.
Not with uncommitted changes. This applies to every target below: preview OTA,
production OTA, native builds, store submissions, CLI dispatch.

Why this is rule zero. On 2026-09-20 a preview OTA was published from a
worktree commit (`fe7de0a1`) that had branched off `main` hours earlier. The
commit was fine on its own, and it was later rebased and pushed, so git looked
right afterwards. But expo-updates serves whatever was published *last* on a
branch, not whatever is on `main`. For the next several hours every phone on
the preview channel ran a bundle missing four fixes that `main` already had:
bot faces, the truncated "Auto" chip, paste-from-clipboard, and the send button
being pushed out of the composer. Nothing errored. The user saw "the same old
issue" and could not tell why. A release from a stale checkout is not a
release, it is a rollback that nobody asked for.

Run this and read the output before any release command:

```bash
git checkout main
git fetch origin main
git rev-parse --abbrev-ref HEAD            # must print exactly: main
git rev-parse HEAD origin/main             # the two hashes must be identical
git status --porcelain                     # must print nothing
```

If `HEAD` is behind, `git merge --ff-only origin/main`. If it is ahead, the
commits are not on `main` yet — push first (see `AGENTS.md` "Sync To Main"),
then release. If the tree is dirty, commit or stash; a release must be
reproducible from the released artifact's recorded commit.

The retired Expo preflight no longer exists; perform the checks above for native releases.

**The only exception is one the user asks for by name, in the current
conversation** — for example "publish this branch to preview so I can test
it on my phone". A standing instruction from an earlier session does not
count, and neither does your own judgement that it is probably fine. When the
user does ask: fetch and rebase anyway, show them `git log --oneline
HEAD..origin/main` (what the release will *not* contain), get a yes,
and say in the final report that the release
was off-main and from which commit. Afterwards, once the work lands on `main`,
republish from `main` so the channel is back on the mainline.

## Step 1: Pick a target

Ask which component to release:

- **CLI** — npm package `happy`
- **Mobile** — Native iOS + Android builds
- **Server** — Docker image + K8s deploy via TeamCity
- **Docs** — GitHub Pages (separate repo)

Present these as options. Wait for the user to pick.

---

## CLI Release

    Package:     packages/happy-cli
    npm name:    happy
    Registry:    https://registry.npmjs.org
    Git tags:    cli-{version}

CLI releases use `.github/workflows/release-happy-cli.yml`, dispatched manually:
one run builds/tests/packs, then
publishes that exact artifact through npm trusted publishing. Never publish
from local npm credentials or create a release tag by hand. The workflow creates
the tag and GitHub Release only after npm publication and a fresh-install smoke
check succeed. Steps 4–6 below describe the workflow's build gates, not a second
local release procedure.

Tag namespace note:
- CLI releases use `cli-X.Y.Z`
- Native public releases use `native-<platform>-<version>-build<N>` (see Native Mobile Release)
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

The workflow stamps its requested version into `packages/happy-cli/package.json`
before building. Do NOT use `npm version` (it chokes on pnpm workspace protocol).
Beta identities stay in the artifact; stable releases persist the version on main.

IMPORTANT: do this **before** build/test for the CLI. The build imports `package.json` and bakes the version into the generated bundle. If you build first and bump later, `happy --version` can still report the old prerelease version even though npm metadata shows the new one.

### Step 4b: `@slopus/happy-wire` must stay bundled — do NOT move it back

`packages/happy-cli/package.json` keeps `"@slopus/happy-wire": "workspace:*"` in
**`devDependencies`, deliberately**. That is not a mistake to tidy up.

pkgroll has no `--external` flag — its entire externals policy is derived from
`dependencies`/`peerDependencies`. So the dependency section IS the bundling
switch:

- in `dependencies` → pkgroll emits a bare `import ... from '@slopus/happy-wire'`
  and Node resolves it from the registry at runtime
- in `devDependencies` → pkgroll inlines the code into `dist/`. The dev dependency
  may remain in the published manifest, but is not installed as a runtime dependency.

It must stay in `devDependencies`. After any build change, verify:

```bash
# must return nothing — no runtime import may survive
grep -rnE "(import|require).*@slopus/happy-wire" packages/happy-cli/dist/
# must return the definitions, not just import mentions
grep -rhoE "(function|const) (createEnvelope|stripLeadingTaskNotificationWrappers)" packages/happy-cli/dist/
```

(A bare `"@slopus/happy-wire": "workspace:*"` string does still appear in dist —
that is the CLI's own package.json inlined as a JSON literal for the version
string. Inert. Only an actual `import`/`require` matters.)

**Why this exists.** `1.2.1-beta.0` shipped declaring `"@slopus/happy-wire":
"0.1.0"` — the only version on npm, published 2026-02-13. Local happy-wire was
*also* labeled `0.1.0` but had 18 commits of drift, including `f85b20c3` which
added `stripLeadingTaskNotificationWrappers` and imported it from
`happy-cli/src/codex/utils/sessionProtocolMapper.ts`. February's tarball had no
such export, ESM failed at module load, and `happy` crashed on **every**
invocation — dead on arrival, not degraded. `1.2.0` had survived the identical
latent bug purely because none of its 15 import sites needed a post-February
symbol. `workspace:*` publishes the local version NUMBER, never the local CODE.

**No in-repo test can catch that class of bug.** Inside the monorepo
`workspace:*` resolves to local source, so `prepublishOnly` — build, typecheck,
all 792 unit tests — always sees the correct code. It only fails against the
registry. The isolated install smoke check is what catches that class of bug.

**Still exposed — `happy-server-self-host`** keeps happy-wire in `dependencies`,
so it carries the original trap. Before publishing it, bundle happy-wire the
same way or get happy-wire republished first.

**Publish rights:** `@slopus/happy-wire` is owned solely by `steve.kite
<steve@korshakov.com>`. `bra1ndump` is an owner of `happy` but NOT of the
`@slopus` scope, so publishing happy-wire 404s for them. Bundling exists partly
to route around that.

Note: `happy --version` prints BOTH happy's own version and the Claude Code
version it found:

```
happy version: 1.2.1-beta.1
Using Claude Code v2.1.224 from native installer
2.1.224 (Claude Code)
```

Do NOT pipe it through `tail -2` — that cuts the happy line off and makes it
look like the command only reports Claude Code's version. Read the first line.

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
`happy-server-self-host` separately. It lives in `packages/happy-server-self-host`
and is the publishing shell around the private `packages/happy-server`:
`pnpm --filter happy-server-self-host build` bundles its standalone
entrypoint into `dist/` and copies `prisma/` in (this needs bun).
Publish from `packages/happy-server-self-host`; it no longer bundles a web app.
Pre-run its full `prepublishOnly` chain before handing a publish to the user.

The server typecheck, unit suite, and both Docker images are gated by
`.github/workflows/server.yml`.

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

Fetch/rebase onto current main before dispatching. Build user-facing release notes
from the actual changes since the previous CLI release of that channel (for a
first beta of a new stable target, start from the latest stable). Keep notes under
`.context/`. Show the chosen version, channel, and notes and get confirmation.

```bash
gh workflow run release-happy-cli.yml --repo slopus/happy --ref main \
  -f version=X.Y.Z-beta.N -F prerelease=true \
  -F release_notes=@.context/release-notes.md
```

Stable releases use `version=X.Y.Z` and `prerelease=false`. The workflow derives
the npm dist-tag (`beta` or `latest`) and rejects mismatched versions. Do not
introduce a separate prepare/publish dispatch. `-F release_notes=@...` reads file
contents; `-f release_notes=...` sends a literal path, which is wrong.

The workflow runs `prepublishOnly` explicitly **after version stamping and before
`pnpm pack`**. Packing or publishing an existing tarball does not invoke the source
workspace's `prepublishOnly`. Never omit this build/typecheck/unit-test gate.
`1.1.10-beta.9` previously shipped a stale `beta.8` bundle when scripts were skipped.

Use pnpm for workspace packaging. Uploading the already-tested pnpm tarball with
a pinned npm CLI is supported and matches Happy Terminal's CI. Do not run raw
`npm publish` against the source workspace. npm 11.5.1+ supports OIDC; the workflow
pins and directly invokes npm 11.18.0 so Node's bundled npm cannot shadow it.

One-time trust configuration on npm: GitHub owner `slopus`, repository `happy`,
workflow `release-happy-cli.yml`, environment `npm`, direct publishing allowed.
The GitHub environment permits only main. Never request npm passwords, tokens,
browser authentication links, or OTPs in chat, and never fall back to local npm
credentials if OIDC fails.

### Step 8: Verify

```bash
npm view happy@{version} version   # did the version actually publish?
npm view happy dist-tags           # did the channel tag move?
```

Watch the dispatched run to completion using the product's durable wait/monitor
mechanism and GitHub CLI status/logs. Check `npm view happy@X.Y.Z version` before
retrying any failed publication: npm versions are immutable. A failed publish
must leave the release tag and GitHub Release absent. If publication succeeded
but a later gate failed, investigate before retrying; do not overwrite the version
or move an existing tag.

⚠️ **This metadata check is necessary but NOT sufficient.** `npm view ... version`
only confirms the tarball was *accepted* — it says nothing about what's *inside* it.
A bundle stamped with the wrong version (the `--ignore-scripts` footgun above) passes
this check cleanly. The authoritative check is the workflow's fresh-install
smoke test (`happy --version`). Never report a release as done on the
metadata check alone.

Then confirm the new version appears under the correct dist-tag. The tag often
lags the publish by 10–40s — poll a few times before concluding it failed; npm
tag propagation is not instant.

### Step 9: Read back the release and installed-package verification

```bash
gh release view cli-X.Y.Z --repo slopus/happy --json body,tagName,isDraft,isPrerelease,url
```

The body must contain the actual notes, not a filename. Betas must be prereleases,
must update only npm's beta tag, and must leave GitHub's latest release unchanged.
The CLI shares its repository with native/OTA releases, so even stable CLI releases
do not automatically replace GitHub's latest release.

The workflow checks the tarball SHA-256 after artifact download, compares the npm
integrity and provenance metadata, then installs the published version in a fresh
directory and checks `happy --version`, `happy --help`, and `happy daemon status`.
Verify that these gates passed. Do not replace the maintainer's global CLI or
restart their daemon as an implicit release step. After stable releases, fetch
and fast-forward/rebase the workflow's version commit while preserving local work.

---

## Native Mobile Release

Packages: `packages/happy-ios` (Swift/UIKit) and `packages/happy-android`
(Kotlin/Compose). Read their AGENTS.md files for build, version and signing
requirements. Build and test on Kirill's Mac Mini. Confirm platform, variant,
version and distribution target before any upload. Step 0 still applies.

The Expo app, EAS OTA workflows and legacy web/Tauri client have been removed.
Do not invoke their former scripts. A native store release needs the existing
App Store / Play signing identity and an explicit store build number.

### Version

Native versions are CalVer `YYYY.M.C` (UTC year, unpadded month, a counter
from 1 each month), counted per platform. Every variant ships the same
version, and every build of it differs only by build number. Uploading a
build, to TestFlight or a Play test track, production included, does not
move the version: any number of builds of 2026.11.1 can go up. `C` moves
only when a version is **released publicly** (App Store release, Play
production rollout), and the release flow records that with the platform's
tag on the released build, made at release time:

    native-ios-<version>-build<CFBundleVersion>
    native-android-<versionName>-build<versionCode>

Annotate it as the existing ones are ("Native <platform> production
<version> (<build>)", source commit, binary SHA-256, distribution, store
receipt). An upload gets no tag; report its upload ID and binary SHA-256
instead. Before any native build, preview or production, from `main` per
Step 0:

```bash
node scripts/native-version.cjs check ios        # or android
```

It prints the checked-in version when that is the upcoming release (the
highest `C` this UTC month's release tags carry, plus one, else 1). If it
fails, because a version was released or a new month began, run
`node scripts/native-version.cjs set ios` (it reads origin's tags and writes
every file that holds the version), commit, push to `main`, and start Step 0
again. `next` prints the version without writing anything. Never move or
reuse an existing tag.

### Debug symbols

- **Android:** the AAB embeds the R8 mapping and any available native symbols
  (`ndk.debugSymbolLevel = "FULL"` for release and preview). Before upload, list
  its metadata with `unzip -Z1 <app.aab> 'BUNDLE-METADATA/*'`. If
  `com.android.tools.build.debugsymbols` is present, Play receives those symbols
  with the bundle; no separate upload is needed. Play's native-code-without-debug-symbols
  warning is expected while every `.so` is a stripped vendor prebuilt:
  `liblkjingle_peerconnection_so.so` (LiveKit WebRTC),
  `libandroidx.graphics.path.so`, `libdatastore_shared_counter.so`,
  `libimage_processing_util_jni.so` and `libsurface_util_jni.so` (AndroidX/CameraX).
  The upstream AARs already ship these libraries stripped: build IDs in the AAB
  match the Maven AARs byte for byte, with no `.symtab` or `.debug_*` sections. AGP
  therefore has nothing to extract, and `keepDebugSymbols` cannot help. Neither
  webrtc-sdk (Maven Central, GitHub releases; see webrtc-sdk/android#57) nor
  Google Maven publishes symbol artifacts for them. The warning is advisory. It
  does not block review or rollout, and Java/Kotlin stack traces are still
  deobfuscated through the embedded R8 mapping.
  Do not fabricate or upload a symbols zip containing stripped libraries. If
  first-party native code is added, the build must produce its symbols and the
  warning must go away.
- **iOS:** export uploads the app's own dSYM. "Upload Symbols Failed" for
  `LiveKitWebRTC.framework` or `RustLiveKitUniFFI.framework` is expected: those
  vendor frameworks ship without dSYMs. Any other missing dSYM blocks the
  release until investigated.

---

## Server Release

    Package:     packages/happy-server
    Dockerfile:  Dockerfile.server (production), Dockerfile (standalone w/ PGlite)
    Image:       docker.korshakov.com/handy-server:{version}
    K8s:         packages/happy-server/deploy/handy.yaml (1 replica, port 3005)

Server releases go through TeamCity (`Lab_HappyServer`). The config is in the TeamCity UI, not in the repo.

Build: node:24 + python3 + ffmpeg, builds happy-wire + happy-server.
Secrets from Vault: handy-db, handy-master, handy-github, handy-files, handy-e2b, handy-revenuecat, handy-elevenlabs.
Redis: happy-redis StatefulSet (redis:7-alpine, 1Gi persistent volume).

Guide the user to trigger the TeamCity build.

---

## Docs Release

    Site:    happy.engineering (GitHub Pages)
    Repo:    github.com/slopus/slopus.github.io

Separate repo, not part of this monorepo. Guide the user to push to that repo.

---

## Writing release notes

Write for the users of the component being released. Native changelogs are owned by their native packages.

1. **Investigate before writing — use subagents (Opus).** Don't infer from commit titles. Spawn parallel subagents to read the actual code + git history of each candidate change and classify it: user-visible UX vs impl detail, default-on vs gated, new vs polish/fix.
2. **Default-off ⇒ exclude.** A change behind a setting/experimental flag that defaults to OFF (or whose UI entry point is hidden) is a silent ship — omit it until it's on by default. Same for impl / perf-internal / refactor / type-only changes.
3. **Audience is phone users.** Most never touch the CLI or desktop. Be skeptical of CLI-only / desktop-only / web-only / beta-only items — a genuinely strong feature can still be wrong for *this* venue; announce those in CLI release notes / docs / GitHub instead.
4. **Ask, don't assume.** When announce-vs-silent-ship, default state, or scope is unclear, ask the owner and confirm the final include/exclude list before writing. Never headline-announce on your own judgment.
5. **Voice:** benefit-first, terse, one line per item. Update the native package's changelog.
6. **Community Credits:** credit non-core contributors whose commits ship, using the previous release tag and GitHub PR authors.

## Rules

- **Release only from local `main` that is `origin/main`, fetched right then, tree clean** — see Step 0. Not a worktree, not a branch, not ahead, not behind. Perform these checks before native builds or submissions. The only exception is one the user asks for by name in the current conversation; show what `main` commits the release lacks, get confirmation, and say it was off-main in the report.
- **Release notes: investigate with subagents, exclude default-off, ask when unsure** — see "Writing release notes" above.
- **Always present options** — never assume which component, channel, or version.
- **Always verify before publishing** — show the user what will be published and get confirmation.
- **CLI releases use the approved GitHub workflow** — dispatch from main with the confirmed version and notes; never publish from local credentials or handle npm credentials/OTP.
- **Do not bundle self-host server/webapp into `happy`** — self-host runtime ships through `happy-server-self-host`, not the main CLI package.
- **Unit tests are the gate, not integration tests** — integration tests are slow and have flaky abort/interrupt tests.
- **Use pnpm to pack the workspace** — CI uploads that exact tested tarball with its pinned npm CLI; never use raw npm publishing on the source workspace.
- **Run prepublishOnly after stamping and before packing** — tarball upload does not run the workspace's lifecycle scripts. Never skip this gate.
- **Never force-push tags** — if a tag exists, stop and ask.
