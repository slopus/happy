# Agent Workflow

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.

## Happy CLI Local Install / Publish

`packages/happy-cli` imports `@slopus/happy-wire` at runtime, while the source
workspace uses `file:../happy-wire`. Do not use `npm install -g .` or `npm link`
from `packages/happy-cli` for daemon runtime installs; that can recreate
`ERR_MODULE_NOT_FOUND: Cannot find package '@slopus/happy-wire'`.

Use:

```bash
corepack pnpm -C packages/happy-cli run cli:install
```

Publish only a package prepared by `packages/happy-cli/scripts/prepare-publish-package.cjs`
and verified with `packages/happy-cli/scripts/guard-publish-artifact.cjs --install-smoke`.
