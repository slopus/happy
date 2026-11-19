# Bots and Paws workspace boundaries

Bots is mounted from its source workspace into Paws Web. The two applications
share a pnpm lockfile, but they remain separately built applications; matching
dependency versions alone does not merge their bundled runtime instances.

## Dependencies

- Paws Web uses React and React DOM 19.2; Bots uses 19.3. The embedded Bots
  build deduplicates React within its own bundle. Keep each React/React DOM pair
  matched and verify the real embedded application before changing either pair.
- Paws Server uses Prisma and Prisma Client 6.19.2; Bots DB uses 7.10.1 and
  generates its own client. Keep both pairs matched and generate both clients
  when changing the workspace. Hoisting the wrong Prisma client can cause the
  Prisma 6 generator to attempt an implicit installation during CI.
- Paws and Bots retain their own TypeScript and Vitest major versions until
  their respective compiler, peer dependency and test suites are migrated.
- Shared dependencies can already resolve to the same version even when their
  declared ranges differ. Check the lockfile before claiming a runtime change.

## Existing packages

The former Personal Agent application and CLI engine were removed when Bots
replaced them. The retired-session guards and old route remain for safe
handling of existing sessions. `paws-agent` is a separate SDK used by Paws CLI and
the browser extension; its `personalTransport` implements AI
service authorization, not the retired Personal Agent. `paws-share` provides session sharing. Check their consumers and external package compatibility before removing public APIs.

For dependency or workspace changes, use a frozen install, generate both
Prisma clients, build Paws Web and the embedded Bots bundle, and run the
relevant regressions. `bots-monorepo-test.yml` lists the Bots CI checks.
