# Happy CLI Release

This document covers the A+ fork release path for `@namsangboy/happy-cli`.

## Version Bump

1. Update `packages/happy-cli/package.json` to the next `*-aplus.*` version.
2. Run the normal build and tests from the workspace.
3. Create a tag that exactly matches the package version: `happy-cli-v<version>`.
4. Push the tag. The `Publish @namsangboy/happy-cli` workflow verifies that the tag and package version match before publishing.

## Publish Artifact Rule

Do not publish directly from the raw pnpm workspace package.

The source package can use local workspace wiring during development, but the npm registry artifact must not expose local-only dependency protocols. In particular:

- `dependencies.@slopus/happy-wire` in the publish artifact must be a registry version, not `workspace:*` or `file:../happy-wire`.
- `@slopus/happy-wire` must be bundled into the CLI artifact until the A+ wire package changes are published independently.
- The bundled dependency closure currently includes `@slopus/happy-wire`, `@paralleldrive/cuid2`, `@noble/hashes`, and `zod`.

The release workflow therefore does this after build:

```sh
node packages/happy-cli/scripts/prepare-publish-package.cjs --out "$RUNNER_TEMP/happy-cli-publish"
node packages/happy-cli/scripts/guard-publish-artifact.cjs "$RUNNER_TEMP/happy-cli-publish" --install-smoke
cd "$RUNNER_TEMP/happy-cli-publish"
npm publish --access public --tag latest --ignore-scripts
```

The final `npm publish` runs inside the prepared directory so npm preserves bundled dependencies. Do not replace it with `npm publish "$RUNNER_TEMP/happy-cli-publish"`; that form can pack the same files without the bundled dependency set. The command includes `--tag latest` because `*-aplus.*` versions are semver prereleases and npm requires an explicit dist-tag for those publishes.

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
- the optional global install smoke test cannot install the tarball.

Do not remove this guard from the publish workflow.

## Should We Use pnpm Pack or pnpm Publish?

`pnpm pack` and `pnpm publish` can rewrite `workspace:` dependencies for normal pnpm monorepo packages, so they are useful when every workspace dependency is independently publishable with a correct version.

That is not enough for this fork right now. The CLI currently needs the local A+ `@slopus/happy-wire` build bundled into the CLI package, and direct packing from the pnpm workspace can still expose workspace-shaped paths or incomplete bundled dependency content if the artifact is not prepared cleanly first.

Current rule: build with pnpm, prepare a clean publish directory, guard the packed artifact, then run `npm publish --access public --tag latest --ignore-scripts` from inside that directory.

If `@slopus/happy-wire` or an A+ scoped replacement is later published independently with its own bumped version, we can revisit this and simplify the release path to versioned workspace dependencies plus `pnpm publish`/`pnpm pack`.
