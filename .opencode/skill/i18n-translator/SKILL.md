---
name: i18n-translator
description: Use this when adding new translatable strings or verifying translations in the expo-app. Covers the translation function usage and all supported languages.
---

## Use this when

- Adding new user-visible strings to the app
- Verifying existing translations
- Working with the `t(...)` function

## Basic usage

```typescript
import { t } from '@/text'

// Simple constants
t('common.cancel')              // "Cancel"
t('settings.title')             // "Settings"

// Functions with parameters
t('common.welcome', { name: 'Steve' })
t('time.minutesAgo', { count: 5 })
```

## Adding new translations

1. **Check existing keys first** in the `common` object
2. **Add to ALL language files** in `sources/text/translations/`:
   - `en.ts` (English)
   - `ru.ts` (Russian)
   - `pl.ts` (Polish)
   - `es.ts` (Spanish)
   - `ca.ts` (Catalan)
   - `it.ts` (Italian)
   - `pt.ts` (Portuguese)
   - `ja.ts` (Japanese)
   - `zh-Hans.ts` (Simplified Chinese)

3. Use descriptive key names like `newSession.machineOffline`

## Translation structure

```typescript
// String constants
cancel: 'Cancel',

// Functions with typed parameters
welcome: ({ name }: { name: string }) => `Welcome, ${name}!`,
itemCount: ({ count }: { count: number }) => 
    count === 1 ? '1 item' : `${count} items`,
```

## Key sections

- `common.*` - Universal strings (buttons, actions, status)
- `settings.*` - Settings screen
- `session.*` - Session management
- `errors.*` - Error messages
- `modals.*` - Modal dialogs
- `components.*` - Component-specific strings

## Technical terms

- Keep universal terms: "CLI", "API", "URL", "JSON"
- Translate terms with established equivalents
- Use descriptive translations for complex concepts
- Maintain consistency within each language

## Quick checklist

- Never hardcode strings in JSX
- Dev pages can skip i18n
- Check `common` before adding new keys
- Update ALL language files
- Use centralized language names from `_all.ts`
