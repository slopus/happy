# Happy CLI Release

This document covers the A+ fork release path for `@buzzni/happy-cli`.

## Fork Scope

The A+ Happy CLI release line is maintained for Buzzni/A+ service integration.
Do not treat A+ release work as an upstream contribution path to
`slopus/happy` `main`.

When updating from upstream, merge released upstream tags into the A+ fork and
validate the A+ service surfaces. Do not open or plan a reverse PR back to
upstream `main` unless that is explicitly requested as separate work.

## Version Bump

1. Update `packages/happy-cli/package.json` to the next `*-aplus.*` version.
2. Run the normal build and tests from the workspace.
3. Create a tag that exactly matches the package version: `happy-cli-v<version>`.
4. Push the tag **without running any local publish command**. The `Publish @buzzni/happy-cli` workflow verifies that the tag and package version match, then is the sole process that publishes.

## Cross-Repository Spawn Bootstrap Compatibility (CRITICAL)

The `bootstrapFiles[].relativePath` values sent by A+ Dev Studio are a wire
contract with Happy CLI's `MANAGED_BOOTSTRAP_PATHS` allowlist. Adding a file on
the web producer side before the installed daemon accepts that path prevents
the entire session from spawning; it is not a best-effort file-sync failure.

On 2026-08-14, the web began sending `.aplus/agent/common-base.md` while the
production daemon was still `1.1.10-aplus.106`. The daemon rejected the request
with `Unsupported spawn bootstrap path: .aplus/agent/common-base.md`, which
blocked new conversation creation.

For every new spawn bootstrap path, use this rollout order:

1. Add the path to `materializeSpawnBootstrapFiles.ts` and add a test that
   materializes the exact path while unrelated paths remain rejected.
2. Bump and release Happy CLI through the tag workflow, then complete the
   registry install smoke described in this runbook.
3. In A+ Dev Studio, gate the new path using the target machine's
   `happyCliVersion`. Installed versions below the supporting release, missing
   versions, and malformed versions must omit only the new path.
4. Add an API-level compatibility test for the real
   `createNewSession -> spawn-happy-session` payload: production version `N`
   omits the path and supporting version `N+1` includes it.
5. Deploy the gated web producer. Do not remove the compatibility gate merely
   because `latest` points at the supporting CLI; existing daemons may still be
   running an older installed version.

If this contract breaks in production, the fastest safe recovery is a web
hotfix that filters only the unsupported path for old/unknown daemon versions.
Do not disable all bootstrap files, relax the daemon to arbitrary paths, or
wait for fleet-wide CLI upgrades before restoring session creation.

## Usage Wire Compatibility — Server Deploys Before the CLI (CRITICAL)

`@slopus/happy-wire`'s `ProviderUsageEventV1Schema` is `.strict()`, and it is
bundled into **both** the CLI and happy-server. When the CLI starts sending a
field the deployed server's copy does not know, `usageHandler.ts` rejects the
event with `safeParse` and logs one line:

```
log({ module: 'websocket', level: 'warn' }, 'Rejected invalid provider usage event');
```

The whole event is dropped — not just the new field, but that event's entire
token usage — and the log does not name the offending field. Publishing the CLI
first therefore loses usage silently across every session until the server
catches up.

This is the mirror of the spawn-bootstrap contract above: there the CLI ships
first, here the **server** ships first.

Before tagging a release that adds or changes any field in
`packages/happy-wire/src/usage.ts`:

1. Land the happy-wire change on happy `main`.
2. Bump `vendor/happy` in A+ Dev Studio and promote `main` -> `product`. The
   pointer bump is what rebuilds the happy-server image (its changed paths are
   matched by `HAPPY_SERVER_IMAGE_PREFIXES` in `tools/ci/select-deploy-services.mjs`),
   and the image is built from the checked-out `vendor/happy`. Bumping the
   pointer does **not** publish the CLI, so this step puts nothing new in the
   field.
3. Confirm the deployed server accepts the new shape.
4. Only then tag `happy-cli-v<version>`.

The reverse direction is safe on its own: a new server with an old CLI parses
fine as long as the new fields are `.nullish()`. Keep them `.nullish()`.

## Single Publisher Policy (CRITICAL)

GitHub Actions owns the entire registry publication path. Local work ends after the
version bump, validation, and release-tag push. Do **not** run `npm publish`,
`pnpm publish`, or `yarn publish` locally, including against a prepared directory or
tarball.

npm versions are immutable. If a version is published locally and its matching tag is
then pushed, the workflow correctly attempts the same version a second time and fails
with E403. Do not re-run that job. Check the published version and publish a new version
through CI only when a correction is required.

## Verification Recovery Without Republishing

If npm accepted a publication but registry propagation exceeded the CI wait window,
do not rerun the publisher. Once the matching release tag exists, dispatch the
verification-only path from `main`:

```sh
gh workflow run publish-happy-cli.yml --repo buzzni/happy --ref main -f version=1.1.10-aplus.274
```

`workflow_dispatch` skips the publish job entirely and has no npm publication token
or provenance permission. The verifier validates the exact version against its
existing tag, waits up to 60 propagation checks at 30-second intervals, packs only
that registry version, verifies its identity, and runs the artifact guard with a
fresh install, CLI version, agent facade, daemon preflight, and daemon status smoke.
It never moves `latest` or other dist-tags. Keep the original run's failure visible
and record the separate successful verification run before consuming the release.

## Required User Approval Checkpoint

Local implementation, tests, build, package preparation, `npm pack`, and artifact
guarding may be completed before release approval. Immediately before any
external release mutation, present the exact candidate version and the proposed
actions and obtain explicit user approval.

This checkpoint applies separately to:

- pushing a release tag;
- `npm publish`;
- adding, moving, or removing an npm dist-tag;
- adding or changing an npm deprecation message.

Approval of a plan or of the implementation work is not publish approval. If
the external action list changes after approval, stop and ask again for the
changed list.

## Publish Artifact Rule

Do not publish directly from the raw pnpm workspace package.

The source package can use local workspace wiring during development, but the npm registry artifact must not expose local-only dependency protocols. In particular:

- `dependencies.@slopus/happy-wire` in the publish artifact must be a registry version, not `workspace:*` or `file:../happy-wire`.
- `@slopus/happy-wire` must be bundled into the CLI artifact until the A+ wire package changes are published independently.
- The bundled dependency closure currently includes `@slopus/happy-wire`, `@paralleldrive/cuid2`, `@noble/hashes`, and `zod`.
- `@buzzni/saycode-cli` must remain an exact runtime dependency and bundled
  dependency. The guard must prove that `happy agent --help` delegates to that
  bundled artifact and that installing Happy does not create a top-level
  `saycode` binary. This keeps natural-language child orchestration available
  without colliding with an independently installed Saycode CLI.

The following commands describe the **GitHub Actions-only** publish section. They are not
a local release procedure; do not copy the `npm publish` command to a developer machine.
The workflow therefore does this after build:

```sh
REPO="$(pwd)"
node packages/happy-cli/scripts/prepare-publish-package.cjs --out "$RUNNER_TEMP/happy-cli-publish"
cd "$RUNNER_TEMP/happy-cli-publish"
mkdir -p "$RUNNER_TEMP/happy-cli-pack"
npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP/happy-cli-pack"
PUBLISH_TGZ="$(ls "$RUNNER_TEMP"/happy-cli-pack/*.tgz)"
node "$REPO/packages/happy-cli/scripts/guard-publish-artifact.cjs" "$PUBLISH_TGZ" --install-smoke
npm publish "$PUBLISH_TGZ" --access public --tag latest --ignore-scripts
VERSION="$(node -p 'require("./package.json").version')"
PACKAGE_NAME="$(node -p 'require("./package.json").name')"
TARBALL_URL="$(npm view "$PACKAGE_NAME@$VERSION" dist.tarball)"
until curl -fsI "$TARBALL_URL" >/dev/null; do
  echo "waiting for npm tarball propagation: $TARBALL_URL"
  sleep 30
done
npm install -g "$PACKAGE_NAME@$VERSION" --prefer-online
HAPPY_HOME_DIR="$(mktemp -d)" happy daemon status
```

The final `npm publish` takes the guarded `.tgz` path, so the registry receives the exact bytes the guard verified. Never publish in any form that re-packs the package:

- `npm publish "$RUNNER_TEMP/happy-cli-publish"` (directory path) re-packed without the bundled dependency set — this shipped `1.1.10-aplus.36` broken.
- `pnpm publish` (and `yarn publish`) do not implement `bundledDependencies` at all; they silently drop the bundled `node_modules` while the metadata still declares them — this shipped `1.1.10-aplus.44` broken.

`prepublishOnly` in both the source and the prepared package now runs `scripts/assert-publish-tool.cjs`, which rejects non-npm publishers, and the published artifact's `postinstall` runs `scripts/verify-bundled-deps.cjs`, which fails a registry install immediately when the bundled files are missing instead of crashing later with `ERR_MODULE_NOT_FOUND`.

The same `postinstall` also runs `scripts/install-companion-tools.cjs`, which puts the companion CLIs `codex-multi-auth` (npm) and `claude-swap` (uv) in place. Both are installed at the **pinned** versions Happy itself manages, never at latest. `CODEX_MULTI_AUTH_VERSION` is resolved out of the npm global root by `src/daemon/aiCredentialRuntime.ts` and `src/codex/codexMultiAuthProxy.ts`, and `CLAUDE_SWAP_VERSION` is matched against `cswap --version` by `ensureClaudeSwap` — note Happy invokes the tool as `cswap`, so grepping for `claude-swap` alone hides that coupling. Installing `latest` over either makes Happy reinstall its pinned copy at runtime and the next Happy update clobber it again; unit tests fail if either constant drifts from `aiCredentialRuntime.ts`. It acts only on a real global install — `npm_config_global` for `npm i -g`, plus `npm_config_location=global` because `npm install --location=global` sets only the latter — and skips when `CI` is truthy, so neither the smoke test above nor the post-publish install check depends on those two registries being reachable. Each install is bounded by the same `timeoutMs` `aiCredentialRuntime` allows these commands, so a stalled registry cannot hang `npm install -g happy` itself. Under `sudo` only the npm half runs: uv resolves its tool directory from `HOME`, which sudo points at root, so `claude-swap` would install where the invoking user cannot reach it — the step says so and prints the command to run instead. A missing `npm`/`uv` or a failed companion install is a warning only and never fails the Happy install. `HAPPY_SKIP_COMPANION_TOOLS=1` opts out entirely. `scripts/guard-publish-artifact.cjs` sets it for its smoke install so the companion packages never enter the prefix whose dependency closure it asserts, and `scripts/install-isolated.cjs` sets it because uv resolves its tool directory from `HOME`, which that script does not isolate — without the switch an isolated dev install would upgrade the developer's real `claude-swap` while reporting that nothing outside the isolated root was touched. An image build or offline install can use the same switch to keep the postinstall off the network.

The command includes `--tag latest` because `*-aplus.*` versions are semver prereleases and npm requires an explicit dist-tag for those publishes.

The install smoke runs every installed CLI command with an isolated
`HOME`/`HAPPY_HOME_DIR` and a bounded timeout. `happy --version` must print
exactly one Happy version line and exit before authentication, provider startup,
or daemon startup. The smoke also requires a complete production dependency
tree and creates then closes the packaged Fastify control-server runtime.

After publish, always install the exact version from the npm registry with lifecycle scripts enabled and run `happy daemon status`. This verifies that the registry metadata, registry tarball, bundled dependency files, native dependencies such as `node-pty`, and the CLI entrypoint all work outside the monorepo. Do not use `--ignore-scripts` for this smoke: Linux installs need `node-pty`'s install script to build its native module because the package does not ship a Linux prebuild.

## npm Tarball Propagation

`npm publish` can print `+ @buzzni/happy-cli@<version>` before every registry edge can serve the tarball blob. During that window, `npm view @buzzni/happy-cli@<version>` and the `latest` dist-tag can already show the new version, while the package tarball URL still returns HTTP 404.

This is an npm registry/CDN propagation delay between package metadata and the tarball object, not a CLI runtime failure. Do not immediately republish just because the first registry install gets a 404. Treat publish as complete only after the tarball URL returns 200 and the registry install smoke passes.

Use this wait loop after every publish:

```sh
VERSION="$(node -p 'require("./package.json").version')"
PACKAGE_NAME="$(node -p 'require("./package.json").name')"
TARBALL_URL="$(npm view "$PACKAGE_NAME@$VERSION" dist.tarball)"
until curl -fsI "$TARBALL_URL" >/dev/null; do
  echo "waiting for npm tarball propagation: $TARBALL_URL"
  sleep 30
done
npm install -g "$PACKAGE_NAME@$VERSION" --prefer-online
HAPPY_HOME_DIR="$(mktemp -d)" happy daemon status
```

Observed on `1.1.10-aplus.37` and `1.1.10-aplus.38`: metadata appeared first, tarball URL returned 404 for a few minutes, then the same URL became 200. The fastest safe release path is to start this polling immediately after `npm publish` succeeds, not to retry publish.

## GitHub Repository Targeting

The local git remote can point at `buzzni/happy` while GitHub CLI may still infer `slopus/happy` from repository metadata. Always pass `--repo buzzni/happy` for Happy PR commands:

```sh
gh pr create --repo buzzni/happy --base main --head <branch> --title "<title>" --body-file <body-file>
gh pr view <number> --repo buzzni/happy --json state,mergeCommit,url
gh pr checks <number> --repo buzzni/happy --watch=false
gh pr merge <number> --repo buzzni/happy --squash --delete-branch
```

Do not rely on `gh repo view` or the default inferred repository for this fork.

## Completion Checklist

Every Happy CLI publish is complete only after all of these are true:

1. The release change is merged into `buzzni/happy` `main`.
2. `@buzzni/happy-cli@<version>` is published and `latest` points to that version.
3. The npm tarball URL returns 200.
4. A fresh registry install runs `happy daemon status` successfully.
5. `buzzni/aplus-dev-studio` updates `vendor/happy` to the merged `buzzni/happy` `main` commit.
6. The root repo `vendor/happy` pointer PR is merged into `buzzni/aplus-dev-studio` `main`.

When the root repo has unrelated local work, use a temporary root worktree from `origin/main` for the pointer PR so release cleanup does not mix with local changes.

## Why 1.1.10-aplus.36 Failed

`1.1.10-aplus.36` was prepared from the clean publish directory but was manually published with:

```sh
npm publish "$RUNNER_TEMP/happy-cli-publish" --access public --tag latest --ignore-scripts
```

That directory-path publish produced registry metadata that still declared bundled dependencies, including `@slopus/happy-wire`, `zod`, `@paralleldrive/cuid2`, and `@noble/hashes`, but the published tarball did not contain the bundled `node_modules` entries. npm then trusted the `bundledDependencies` metadata and did not install those packages from the registry. A fresh global install failed before daemon code ran:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@slopus/happy-wire' imported from .../@namsangboy/happy-cli/dist/index.mjs
```

The fix is to pack from inside the prepared directory, guard the resulting `.tgz`, publish from inside that same prepared directory, and then run a post-publish registry install smoke. The install smoke must also execute the installed `happy` entrypoint so missing runtime imports fail before release completion.

## Why 1.1.10-aplus.44 Failed

`1.1.10-aplus.44` was prepared correctly but published manually outside the tag workflow (the registry entry has no provenance attestation, unlike `1.1.10-aplus.43`). The publish tool re-packed the prepared directory without honoring `bundledDependencies` — the tarball had 64 files instead of ~1100 and contained no `node_modules` — while the metadata still declared the bundled set. Fresh installs failed exactly like `1.1.10-aplus.36`:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@slopus/happy-wire' imported from .../@namsangboy/happy-cli/dist/index.mjs
```

This is the failure mode of `pnpm publish` (pnpm does not implement `bundledDependencies`). The per-artifact guard did not help because it packs with `npm pack` internally — the guard's own tarball was fine; the publisher's re-packed tarball was not. Three defenses were added after this incident:

1. The workflow publishes the guarded `.tgz` path itself, so no re-pack can happen between guard and publish.
2. `scripts/assert-publish-tool.cjs` runs from `prepublishOnly` and rejects pnpm/yarn publishers outright.
3. `scripts/verify-bundled-deps.cjs` runs from the published artifact's `postinstall` and fails the install with an actionable message when bundled files are missing.

In the field, a machine with the broken version installed can be repaired without waiting for a republish:

```sh
cd "$(npm root -g)/@namsangboy/happy-cli"
npm install --no-save --no-package-lock '@slopus/happy-wire@<version>' '@paralleldrive/cuid2@^2.2.2' '@noble/hashes@^2.0.1' 'zod@^4.0.0'
happy daemon stop && happy daemon start
```

## Why 1.1.10-aplus.46 Verification Failed

`1.1.10-aplus.46` was published correctly, but the post-publish registry smoke installed it with `--ignore-scripts`. The Linux `node-pty` package does not include a prebuilt native module, so skipping lifecycle scripts prevented its install script from building `pty.node`. The installed CLI then failed while loading `node-pty` before `happy daemon status` could run.

The same registry version installs and runs successfully when lifecycle scripts are enabled. Post-publish verification must match a real user install and must not pass `--ignore-scripts`.

## Why 1.1.8-aplus.22 Failed

`1.1.8-aplus.22` was published with this dependency metadata:

```json
"@slopus/happy-wire": "workspace:*"
```

Local builds and tests did not catch it because pnpm resolves `workspace:*` to the local `packages/happy-wire` package. A registry install happens outside the monorepo, so npm reads the published metadata as-is and fails with:

```text
EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:": workspace:*
```

This was introduced when upstream pnpm workspace metadata was merged back into the A+ fork. The previous A+ release line used a registry version for `@slopus/happy-wire`, so the issue only appeared in the new version.

## Guard Requirements

`scripts/guard-publish-artifact.cjs` checks the packed npm artifact, not just source files. It fails when:

- any dependency metadata contains `workspace:` or `file:`;
- `@slopus/happy-wire` is missing or points to a local-only protocol;
- the tarball contains pnpm workspace paths such as `node_modules/.pnpm` or `../`;
- required bundled files are missing;
- `npm ls --global --all --omit=dev` reports an incomplete production dependency tree;
- the optional global install smoke test cannot install the tarball;
- the installed artifact cannot create and close its Fastify control-server runtime;
- the optional global install smoke test cannot execute the installed `happy daemon status` entrypoint.

Do not remove this guard from the publish workflow.

## Fail-safe Daemon Handoff

Both daemon startup and the bundle-replacement heartbeat must preflight the new
control-server runtime before stopping the current daemon. A failed candidate
must leave the current API connection, control socket, state file, lock, and
sleep-prevention process intact. The heartbeat retries the on-disk candidate on
the next interval instead of advancing its observed bundle marker.

This protects availability from incomplete or concurrently replaced install
prefixes. It is not a full blue/green supervisor: failures after a successful
preflight and teardown still require a separate OS service-manager design.

## Should We Use pnpm Pack or pnpm Publish?

`pnpm pack` and `pnpm publish` can rewrite `workspace:` dependencies for normal pnpm monorepo packages, so they are useful when every workspace dependency is independently publishable with a correct version.

That is not enough for this fork right now. The CLI currently needs the local A+ `@slopus/happy-wire` build bundled into the CLI package, and direct packing from the pnpm workspace can still expose workspace-shaped paths or incomplete bundled dependency content if the artifact is not prepared cleanly first.

Current rule: build with pnpm, prepare a clean publish directory, pack a `.tgz` from inside that directory, guard that `.tgz`, publish from inside the prepared directory, then verify the exact published version by installing from the npm registry.

If `@slopus/happy-wire` or an A+ scoped replacement is later published independently with its own bumped version, we can revisit this and simplify the release path to versioned workspace dependencies plus `pnpm publish`/`pnpm pack`.
