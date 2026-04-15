# pnpm Migration [Draft]

## Status: No-op for now

The `expo doctor` duplicate dependency warnings are a Yarn 1 monorepo hoisting issue, not a correctness bug. Quick fixes (expanding `nohoist`, adding `resolutions`) can silence the dangerous duplicates without a package manager migration.

## Why pnpm eventually

- Expo team is leaning pnpm (byCedric's official expo-monorepo-example uses it)
- Faster installs, especially in worktree flows (no re-downloading, content-addressable store)
- Dominant choice for new JS/TS monorepos (~20% market share, fastest growing)
- `pnpm.overrides` cleaner than Yarn `resolutions` for pinning singletons

## Why not now

- React Native requires `node-linker=hoisted`, which negates pnpm's strict isolation — you end up with a similar flat layout anyway
- pnpm symlinks + git worktrees (`.dev/worktree/`) need testing — symlinks may resolve to wrong store location
- pnpm v11 beta just dropped (March 2026) with breaking config changes — migrating now means potentially migrating again
- Half-day of work + risk for moderate gain

## When to reconsider

- If quick Yarn 1 fixes don't stick
- When pnpm v11 stabilizes
- When Expo SDK improves isolated dependency support enough to drop `node-linker=hoisted`

## Quick fixes (current plan)

1. Remove `@expo/config-plugins` from happy-app/package.json
2. Run `npx expo install --check` for version mismatches
3. Expand `nohoist` in root package.json for duplicating expo packages
4. Add `resolutions` to pin `react` and `react-native` to single versions
