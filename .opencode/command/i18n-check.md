---
description: Verify i18n translations are complete
---

Check that all user-visible strings in the expo-app use the `t(...)` function and that translations exist in all language files.

1. Search for hardcoded strings in JSX that should use `t(...)`
2. Verify new translation keys exist in ALL language files:
   - `sources/text/translations/en.ts`
   - `sources/text/translations/ru.ts`
   - `sources/text/translations/pl.ts`
   - `sources/text/translations/es.ts`
   - `sources/text/translations/ca.ts`
   - `sources/text/translations/it.ts`
   - `sources/text/translations/pt.ts`
   - `sources/text/translations/ja.ts`
   - `sources/text/translations/zh-Hans.ts`

3. Report any missing translations or hardcoded strings.
