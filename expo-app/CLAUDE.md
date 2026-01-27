# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `yarn start` - Start the Expo development server
- `yarn ios` - Run the app on iOS simulator
- `yarn android` - Run the app on Android emulator
- `yarn web` - Run the app in web browser
- `yarn prebuild` - Generate native iOS and Android directories
- `yarn typecheck` - Run TypeScript type checking after all changes

### macOS Desktop (Tauri)
- `yarn tauri:dev` - Run macOS desktop app with hot reload
- `yarn tauri:build:dev` - Build development variant
- `yarn tauri:build:preview` - Build preview variant
- `yarn tauri:build:production` - Build production variant

### Testing
- `yarn test` - Run tests in watch mode (Vitest)
- Tests exist and should be kept green (Vitest)

### Production
- `yarn ota` - Deploy over-the-air updates via EAS Update to production branch

## Changelog Management

The app includes an in-app changelog feature that displays version history to users. When making changes:

### Adding Changelog Entries

1. **Always update the latest version** in `/CHANGELOG.md` when adding new features or fixes
2. **Format**: Each version follows this structure:
   ```markdown
   ## Version [NUMBER] - YYYY-MM-DD
   - Brief description of change/feature/fix
   - Another change description
   - Keep descriptions user-friendly and concise
   ```

3. **Version numbering**: Increment the version number for each release (1, 2, 3, etc.)
4. **Date format**: Use ISO date format (YYYY-MM-DD)

### Regenerating Changelog Data

After updating CHANGELOG.md, run:
```bash
npx tsx sources/scripts/parseChangelog.ts
```

This generates `sources/changelog/changelog.json` which is used by the app.

### Best Practices

- Write changelog entries from the user's perspective
- Start each entry with a verb (Added, Fixed, Improved, Updated, Removed)
- Group related changes together
- Keep descriptions concise but informative
- Focus on what changed, not technical implementation details
- The changelog is automatically parsed during `yarn ota` and `yarn ota:production`
- Always improve and expand basic changelog descriptions to be more user-friendly and informative
- Include a brief summary paragraph before bullet points for each version explaining the theme of the update

### Example Entry

```markdown
## Version 4 - 2025-01-26
- Added dark mode support across all screens
- Fixed navigation issues on tablet devices  
- Improved app startup performance by 30%
- Updated authentication flow for better security
- Removed deprecated API endpoints
```

## Architecture Overview

### Core Technology Stack
- **React Native** with **Expo** SDK 54
- **TypeScript** with strict mode enabled
- **Unistyles** for cross-platform styling with themes and breakpoints
- **Expo Router v6** for file-based routing
- **Socket.io** for real-time WebSocket communication
- **libsodium** (via `@more-tech/react-native-libsodium`) for end-to-end encryption
- **LiveKit** for real-time voice communication

### Project Structure
```
sources/
├── app/              # Expo Router screens
├── auth/             # Authentication logic (QR code based)
├── components/       # Reusable UI components
├── sync/             # Real-time sync engine with encryption
└── utils/            # Utility functions
```

### Key Architectural Patterns

1. **Authentication Flow**: QR code-based authentication using expo-camera with challenge-response mechanism
2. **Data Synchronization**: WebSocket-based real-time sync with automatic reconnection and state management
3. **Encryption**: End-to-end encryption using libsodium for all sensitive data
4. **State Management**: React Context for auth state; sync state is centralized in `sources/sync/storage.ts` (Zustand) with domain slices under `sources/sync/store/domains/*`
5. **Real-time Voice**: LiveKit integration for voice communication sessions
6. **Platform-Specific Code**: Separate implementations for web vs native when needed

### Development Guidelines

- Use **4 spaces** for indentation
- Use **yarn** instead of npm for package management
- Path alias `@/*` maps to `./sources/*`
- TypeScript strict mode is enabled - ensure all code is properly typed
- Follow existing component patterns when creating new UI components
- Real-time sync is orchestrated by the `Sync` singleton in `sources/sync/sync.ts`, with domain logic extracted into `sources/sync/engine/*`
- Store all temporary scripts and any test outside of unit tests in sources/trash folder
- When setting screen parameters ALWAYS set them in _layout.tsx if possible this avoids layout shifts
- **Never use Alert module from React Native, always use @sources/modal/index.ts instead**
- **Always apply layout width constraints** from `@/components/layout` to full-screen ScrollViews and content containers for responsive design across device sizes
- Always run `yarn typecheck` after all changes to ensure type safety

## Folder Structure & Naming Conventions (2026-01)

These conventions are **additive** to the guidelines above. The goal is to keep screens and sync logic easy to reason about.

### Naming
- Buckets are lowercase (e.g. `components`, `hooks`, `sync`, `utils`).
- Feature folders are `camelCase` (e.g. `newSession`, `agentInput`, `profileEdit`).
- Avoid `_folders` except Expo Router special files (e.g. `_layout.tsx`) and `__tests__`.
- Allowed `_*.ts` markers (organization only) inside module-ish folders: `_types.ts`, `_shared.ts`, `_constants.ts`.

### Screens and feature code
- Expo Router routes live in `sources/app/**`.
- Keep route files (Expo Router) as the screen entrypoints; extract non-trivial UI/logic into `sources/components/**`.

### Components: domain map (2026-01)
When adding or refactoring components, prefer placing them under one of these domains:
- `sources/components/ui/` — reusable UI primitives (lists, popovers, dropdowns, forms)
- `sources/components/sessions/` — session-related UX (`agentInput`, `newSession`, etc.)
- `sources/components/profiles/` — profile management UI (edit, list, pickers)
- `sources/components/secrets/` — secrets + requirements UI
- `sources/components/machines/` — machine-related UI
- `sources/components/tools/` — tool rendering + permission UI

Guidance (not a hard rule):
- Prefer reusing an existing domain over creating a new top-level folder under `sources/components/`.
- If a new domain is clearly warranted (distinct concept, multiple screens/features, long-term ownership), create it with a clear noun name and keep it cohesive.

Bucket rule:
- Use `components/`, `hooks/`, `modules/`, `utils/` only when they contain multiple files; avoid creating a 1-file subfolder just for structure.

### Sync organization
- `sources/sync/sync.ts` is the canonical sync orchestrator (public API + wiring) and remains the entrypoint.
- Extract cohesive logic into subdomains under `sources/sync/`:
  - `sources/sync/engine/*` — runtime helpers used by `Sync` (prefer a few domain files like `sessions.ts`, `machines.ts`, `settings.ts`; avoid “one helper per file” sprawl)
  - `sources/sync/store/domains/*` — Zustand domain slices
  - `sources/sync/ops/*` — RPC operation helpers (sessions/machines/capabilities)
  - `sources/sync/reducer/*` — message reducer pipeline (phases/helpers)
  - `sources/sync/typesRaw/*` — raw message schemas + normalization
- Prefer splitting by *domain* (sessions/messages/machines/settings) rather than generic `utils/` buckets.

Canonical entrypoints:
- `sources/sync/{storage.ts,ops.ts,typesRaw.ts,sync.ts}` are canonical entrypoints that define the public surface for sync.
- Extract internals under subfolders (`store/`, `ops/`, `typesRaw/`, `reducer/`, etc.) and have the entry files orchestrate them (import and compose).

## Modals & dialogs (web + native)

### Rules of thumb
- **Never call `Alert` / `Alert.prompt` directly**. Use `Modal` from `sources/modal` (`import { Modal } from '@/modal'`).
- **Avoid `react-native` `<Modal>`** for app-controlled overlays. Use the app modal system so stacking works consistently.
- If you need a new overlay:
  - “OK / Confirm / Prompt” → `Modal.alert()` / `Modal.confirm()` / `Modal.prompt()`
  - Custom UI → `Modal.show({ component, props })`

### Web implementation (Radix)
On web, `BaseModal` renders a Radix `Dialog` (portal to `document.body`) so focus, scroll, and pointer events behave correctly when stacking modals (including when an Expo Router / Vaul drawer is already open).

**Critical invariant:** Radix “singleton” stacks (DismissableLayer / FocusScope) must be shared across *all* dialogs. With Metro + package `exports`, mixing ESM and CJS entrypoints can load *two* Radix module instances and break focus/stacking.

- Use the CJS entrypoints via `sources/utils/radixCjs.ts` (`requireRadixDialog()` / `requireRadixDismissableLayer()`) for any web dialog primitives.
- Wrap stacked dialog content with `DismissableLayer.Branch` so underlying Radix/Vaul layers don’t treat the top dialog as “outside” and dismiss.
- Only the top-most modal should render a backdrop; `ModalProvider` handles this via `showBackdrop`.

### Native implementation (iOS/Android)
On native, stacking a React Navigation / Expo Router modal screen with an RN `<Modal>` can produce “invisible overlay blocks touches” and z-index ordering bugs.

- `BaseModal` renders a “portal-style” overlay inside the current screen tree (absolute fill + high `zIndex`) so touches/focus stay within the same navigation presentation context.
- `Modal.alert()` / `Modal.confirm()` use the native system alert UI on iOS/Android (good accessibility + expected platform UX).
- `Modal.prompt()` uses the app prompt modal on all platforms for consistent behavior (since `Alert.prompt` is iOS-only).

### Popovers (menus/tooltips)
Use the app `Popover` + `FloatingOverlay` for menus/tooltips/context menus.

- Use `portal={{ web: { target: 'body' }, native: true }}` when the anchor is inside overflow-clipped containers (headers, lists, scrollviews).
- When the backdrop is enabled (default), `onRequestClose` is required (Popover is controlled).
- For context-menu style overlays, prefer `backdrop={{ effect: 'blur', anchorOverlay: ..., closeOnPan: true }}` so the trigger stays crisp above the blur without cutout seams.
- On web, portaled popovers are wrapped in Radix `DismissableLayer.Branch` (via `radixCjs.ts`) so Expo Router/Vaul/Radix layers don’t treat them as “outside”.

## Settings persistence & sync (Account.settings + pending delta) — rules

### Correct model
- **Effective settings** = server settings merged with `settingsDefaults` (+ migrations in `settingsParse()`).
- **Pending settings** = a **delta-only** object of user-intended changes not yet ACKed by the server (`pending-settings`).
- `/v1/account/settings` **POST replaces the blob** (not a patch), so accidental uploads can overwrite server state.

### Hard rules (do NOT break these)
- **Never apply schema defaults when parsing pending deltas.**
  - Do NOT do `SettingsSchema.partial().parse(...)` (or any parse path that synthesizes missing keys) if the schema contains `.default(...)`.
  - Pending parsing must be “delta-only”: include a key only if it exists in the stored object and validates.
- **Treat settings as immutable.**
  - Never mutate `settings` (or nested arrays/objects like `secrets`, `profiles`, `favorite*`, `dismissedCLIWarnings`) in place.
  - Always update settings via `sync.applySettings({ field: nextValue })` / `useSettingMutable(...)` using immutable patterns (`map`, `filter`, `...spread`).
- **Avoid no-op writes on boot.**
  - Do not call `sync.applySettings()` unconditionally in mount effects.
  - Only persist when the value actually changed vs the current settings.
- **Never log secrets.**
  - Do not log `secrets[].encryptedValue.value` or env-var secret values. If you add logs, log only counts/booleans (`hasValue`) and keys.

### Defaults placement guidance
- It’s OK for `SettingsSchema` to have `.default(...)` for **effective settings parsing**, but you must ensure pending parsing does **not** trigger those defaults.
- If you need both behaviors, consider **separating schemas**:
  - `SettingsSchema` (effective) may include defaults
  - `PendingSettingsSchema` (delta-only) must not

### Pending storage when empty
- Writing `"{}"` for “no pending” is acceptable **only if pending parsing is delta-only** (so `{}` stays `{}`).
- Deleting the `pending-settings` key when empty is a recommended optimization (less churn/ambiguity), but not required for correctness once delta-only parsing is in place.

## Secret settings (encrypted-at-rest fields inside settings)

Some settings values are secrets (e.g. API keys). Even though the outer `Account.settings` blob is encrypted for server transport, we also require **field-level encryption at rest** so secrets are not stored as plaintext in MMKV/JSON after the blob is decrypted.

### Rules
- **Never persist plaintext secrets** in settings. Plaintext may be accepted as input, but must be sealed before persistence.
- **Decrypt just-in-time** (e.g. right before sending an encrypted machine RPC to spawn a session).
- **Never log secret values** (only counts/booleans like `hasValue`).

### How to add a new secret setting field
- Use the standardized secret container schema: **`SecretStringSchema`** from `sources/sync/secretSettings.ts`
  - Marker: **`_isSecretValue: true`** (required for automatic sealing)
  - Plaintext input only: `.value` (must not be persisted)
  - Ciphertext persisted: `.encryptedValue` (an `EncryptedStringSchema`)
- Sealing is automatic: `sync.applySettings(...)` runs `sealSecretsDeep(...)` (see `sources/sync/secretSettings.ts`).
- Decrypt just-in-time via `sync.decryptSecretValue(...)`.

### Internationalization (i18n) Guidelines

**CRITICAL: Always use the `t(...)` function for ALL user-visible strings**

#### Basic Usage
```typescript
import { t } from '@/text';

// ✅ Simple constants
t('common.cancel')              // "Cancel"
t('settings.title')             // "Settings"

// ✅ Functions with parameters
t('common.welcome', { name: 'Steve' })           // "Welcome, Steve!"
t('time.minutesAgo', { count: 5 })               // "5 minutes ago"
t('errors.fieldError', { field: 'Email', reason: 'Invalid format' })
```

#### Adding New Translations

1. **Check existing keys first** - Always check if the string already exists in the `common` object or other sections before adding new keys
2. **Think about context** - Consider the screen/component context when choosing the appropriate section (e.g., `settings.*`, `session.*`, `errors.*`)
3. **Add to ALL languages** - When adding new strings, you MUST add them to all language files in `sources/text/translations/` (currently: `en`, `ru`, `pl`, `es`, `ca`, `it`, `pt`, `ja`, `zh-Hans`)
4. **Use descriptive key names** - Use clear, hierarchical keys like `newSession.machineOffline` rather than generic names
5. **Language metadata** - All supported languages and their metadata are centralized in `sources/text/_all.ts`

#### Translation Structure
```typescript
// String constants for static text
cancel: 'Cancel',

// Functions for dynamic text with typed parameters  
welcome: ({ name }: { name: string }) => `Welcome, ${name}!`,
itemCount: ({ count }: { count: number }) => 
    count === 1 ? '1 item' : `${count} items`,
```

#### Key Sections
- `common.*` - Universal strings used across the app (buttons, actions, status)
- `settings.*` - Settings screen specific strings
- `session.*` - Session management and display
- `errors.*` - Error messages and validation
- `modals.*` - Modal dialogs and popups
- `components.*` - Component-specific strings organized by component name

#### Language Configuration

The app uses a centralized language configuration system:

- **`sources/text/_all.ts`** - Centralized language metadata including:
  - `SupportedLanguage` type definition
  - `SUPPORTED_LANGUAGES` with native names and metadata
  - Helper functions: `getLanguageNativeName()`, `getLanguageEnglishName()`
  - Language constants: `SUPPORTED_LANGUAGE_CODES`, `DEFAULT_LANGUAGE`

- **Adding new languages:**
  1. Add the language code to the `SupportedLanguage` type in `_all.ts`
  2. Add language metadata to `SUPPORTED_LANGUAGES` object
  3. Create new translation file in `sources/text/translations/[code].ts`
  4. Add import and export in `sources/text/index.ts`

#### Important Rules
- **Never hardcode strings** in JSX - always use `t('key')`
- **Dev pages exception** - Development/debug pages can skip i18n
- **Check common first** - Before adding new keys, check if a suitable translation exists in `common`
- **Context matters** - Consider where the string appears to choose the right section
- **Update all languages** - New strings must be added to every language file
- **Use centralized language names** - Import language names from `_all.ts` instead of translation keys
- **Always re-read translations** - When new strings are added, always re-read the translation files to understand the existing structure and patterns before adding new keys
- **Use translations for common strings** - Always use the translation function `t()` for any user-visible string that is translatable, especially common UI elements like buttons, labels, and messages
- **Use the i18n-translator agent** - When adding new translatable strings or verifying existing translations, use the i18n-translator agent to ensure consistency across all language files
- **Beware of technical terms** - When translating technical terms, consider:
  - Keep universally understood terms like "CLI", "API", "URL", "JSON" in their original form
  - Translate terms that have well-established equivalents in the target language
  - Use descriptive translations for complex technical concepts when direct translations don't exist
  - Maintain consistency across all technical terminology within the same language

#### i18n-Translator Agent

When working with translations, use the **i18n-translator** agent for:
- Adding new translatable strings to the application
- Verifying existing translations across all language files
- Ensuring translations are consistent and contextually appropriate
- Checking that all required languages have new strings
- Validating that translations fit the UI context (headers, buttons, multiline text)

The agent should be called whenever new user-facing text is introduced to the codebase or when translation verification is needed.

### Important Files

- `sources/sync/types.ts` - Core type definitions for the sync protocol
- `sources/sync/reducer.ts` - State management logic for sync operations
- `sources/auth/AuthContext.tsx` - Authentication state management
- `sources/app/_layout.tsx` - Root navigation structure

### Custom Header Component

The app includes a custom header component (`sources/components/Header.tsx`) that provides consistent header rendering across platforms and integrates with React Navigation.

#### Usage with React Navigation:
```tsx
import { NavigationHeader } from '@/components/Header';

// As default for all screens in Stack navigator:
<Stack
    screenOptions={{
        header: NavigationHeader,
        // Other default options...
    }}
>

// Or for individual screens:
<Stack.Screen
    name="settings"
    options={{
        header: NavigationHeader,
        headerTitle: 'Settings',
        headerSubtitle: 'Manage your preferences', // Custom extension
        headerTintColor: '#000',
        // All standard React Navigation header options are supported
    }}
/>
```

The custom header supports all standard React Navigation header options plus:
- `headerSubtitle`: Display a subtitle below the main title
- `headerSubtitleStyle`: Style object for the subtitle text

This ensures consistent header appearance and behavior across iOS, Android, and web platforms.

## Unistyles Styling Guide

### Creating Styles

Always use `StyleSheet.create` from 'react-native-unistyles':

```typescript
import { StyleSheet } from 'react-native-unistyles'

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: runtime.insets.top,
        paddingHorizontal: theme.margins.md,
    },
    text: {
        color: theme.colors.typography,
        fontSize: 16,
    }
}))
```

### Using Styles in Components

For React Native components, provide styles directly:

```typescript
import React from 'react'
import { View, Text } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: runtime.insets.top,
    },
    text: {
        color: theme.colors.typography,
        fontSize: 16,
    }
}))

const MyComponent = () => {
    return (
        <View style={styles.container}>
            <Text style={styles.text}>Hello World</Text>
        </View>
    )
}
```

For other components, use `useStyles` hook:

```typescript
import React from 'react'
import { CustomComponent } from '@/components/CustomComponent'
import { useStyles } from 'react-native-unistyles'

const MyComponent = () => {
    const { styles, theme } = useStyles(styles)
    
    return (
        <CustomComponent style={styles.container} />
    )
}
```

### Variants

Create dynamic styles with variants:

```typescript
const styles = StyleSheet.create(theme => ({
    button: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        variants: {
            color: {
                primary: {
                    backgroundColor: theme.colors.primary,
                },
                secondary: {
                    backgroundColor: theme.colors.secondary,
                },
                default: {
                    backgroundColor: theme.colors.background,
                }
            },
            size: {
                small: {
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                },
                large: {
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                }
            }
        }
    }
}))

// Usage
const { styles } = useStyles(styles, {
    button: {
        color: 'primary',
        size: 'large'
    }
})
```

### Media Queries

Use media queries for responsive design:

```typescript
import { StyleSheet, mq } from 'react-native-unistyles'

const styles = StyleSheet.create(theme => ({
    container: {
        padding: theme.margins.sm,
        backgroundColor: {
            [mq.only.width(0, 768)]: theme.colors.background,
            [mq.only.width(768)]: theme.colors.secondary,
        }
    }
}))
```

### Breakpoints

Access current breakpoint in components:

```typescript
const MyComponent = () => {
    const { breakpoint } = useStyles()
    
    const isTablet = breakpoint === 'md' || breakpoint === 'lg'
    
    return (
        <View>
            {isTablet ? <TabletLayout /> : <MobileLayout />}
        </View>
    )
}
```

### Special Component Considerations

#### Expo Image
- **Size properties** (`width`, `height`) must be set outside of Unistyles stylesheet as inline styles
- **`tintColor` property** must be set directly on the component, not in style prop
- All other styling goes through Unistyles

```typescript
import { Image } from 'expo-image'
import { StyleSheet, useStyles } from 'react-native-unistyles'

const styles = StyleSheet.create((theme) => ({
    image: {
        borderRadius: 8,
        backgroundColor: theme.colors.background, // Other styles use theme
    }
}))

const MyComponent = () => {
    const { theme } = useStyles()
    
    return (
        <Image 
            style={[{ width: 100, height: 100 }, styles.image]}  // Size as inline styles
            tintColor={theme.colors.primary}                     // tintColor goes on component
            source={{ uri: 'https://example.com/image.jpg' }}
        />
    )
}
```

### Best Practices

1. **Always use `StyleSheet.create`** from 'react-native-unistyles'
2. **Provide styles directly** to components from 'react-native' and 'react-native-reanimated' packages
3. **Use `useStyles` hook only** for other components (but try to avoid it when possible)
4. **Always use function mode** when you need theme or runtime access
5. **Use variants** for component state-based styling instead of conditional styles
6. **Leverage breakpoints** for responsive design rather than manual dimension calculations
7. **Keep styles close to components** but extract common patterns to shared stylesheets
8. **Use TypeScript** for better developer experience and type safety

## Project Scope and Priorities

- This project targets Android, iOS, and web platforms
- Web is considered a secondary platform
- Avoid web-specific implementations unless explicitly requested
- Keep dev pages without i18n, always use t(...) function to translate all strings, when adding new string add it to all languages, think about context before translating.
- Core principles: never show loading error, always just retry. Always sync main data in "sync" class. Always use invalidate sync for it. Always use Item component first and only then you should use anything else or custom ones for content. Do not ever do backward compatibility if not explicitly stated.
- Never use custom headers in navigation, almost never use Stack.Page options in individual pages. Only when you need to show something dynamic. Always show header on all screens.
- store app pages in @sources/app/(app)/
- use ItemList for most containers for UI, if it is not custom like chat one.
- Always use expo-router api, not react-navigation one.
- Always try to use "useHappyAction" from @sources/hooks/useHappyAction.ts if you need to run some async operation, do not handle errors, etc - it is handled automatically.
- Never use unistyles for expo-image, use classical one
- Always use "Avatar" for avatars
- No backward compatibliity ever
- When non-trivial hook is needed - create a dedicated one in hooks folder, add a comment explaining it's logic
- Always put styles in the very end of the component or page file
- Always wrap pages in memo
- For hotkeys use "useGlobalKeyboard", do not change it, it works only on Web
- Use "AsyncLock" class for exclusive async locks
