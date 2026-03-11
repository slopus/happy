---
paths:
  - packages/happy-app/**
---

## Gotchas

- Never use `Alert` from React Native — always use `@/modal` instead
- Never use Unistyles for expo-image — use plain inline styles
- Use `useUnistyles` (NOT `useStyles`) when you need theme/runtime values outside `StyleSheet.create`
- Custom header: `createHeader` from `@/components/navigation/Header` (not `NavigationHeader`)
- Screen params ALWAYS in `_layout.tsx`, not in individual pages — avoids layout shifts
- Always use expo-router API, not react-navigation API

## Patterns to Follow

- `useHappyAction` from `@/hooks/useHappyAction` for async operations — errors handled automatically
- `t()` from `@/text` for ALL user-visible strings — must add to all 10 languages: `en`, `ru`, `pl`, `es`, `ca`, `it`, `pt`, `ja`, `zh-Hans`, `zh-Hant`
- Dev/debug pages can skip i18n
- `ItemList` for most list containers, `Avatar` for avatars, `AsyncLock` for exclusive async locks
- `useGlobalKeyboard` for hotkeys (Web only, don't modify it)
- Wrap pages in `memo`, store them in `sources/app/(app)/`
- Styles at the very end of component/page files
- Layout width constraints from `@/components/layout` on full-screen ScrollViews
- Non-trivial hooks → dedicated file in `hooks/` folder with a comment explaining logic

## Core Principles

- Never show loading errors — always retry
- No backward compatibility unless explicitly asked
- Web is secondary platform — avoid web-specific implementations unless requested
- Always show header on all screens

## Changelog

When adding features/fixes, update `/CHANGELOG.md` then run `npx tsx sources/scripts/parseChangelog.ts` to regenerate `sources/changelog/changelog.json`. Auto-parsed during `yarn ota`.
