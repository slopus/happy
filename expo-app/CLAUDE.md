# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For shared development principles and mono-repo overview, see [CLAUDE.md](../CLAUDE.md)**

## Component Overview

Expo App - React Native mobile/web client for remote control and viewing of AI coding sessions, with real-time sync, end-to-end encryption, and multi-platform support (iOS, Android, Web).

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
- No existing tests in the codebase yet

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
4. **State Management**: React Context for auth state, custom reducer for sync state
5. **Real-time Voice**: LiveKit integration for voice communication sessions
6. **Platform-Specific Code**: Separate implementations for web vs native when needed

### Development Guidelines

- Path alias `@/*` maps to `./sources/*`
- Real-time sync operations are handled through SyncSocket and SyncSession classes
- Store all temporary scripts and any test outside of unit tests in sources/trash folder
- **Use the i18n-translator agent** - When adding new translatable strings or verifying existing translations, use the i18n-translator agent to ensure consistency across all language files

### Internationalization (i18n)

**CRITICAL: Always use the `t(...)` function for ALL user-visible strings**

For detailed i18n guidelines, see @../.claude/rules/react-native.md

Key points:
- Language files in `sources/text/translations/` (currently: `en`, `ru`, `pl`, `es`, `ca`, `it`, `pt`, `ja`, `zh-Hans`)
- Language metadata in `sources/text/_all.ts`
- Never hardcode strings in JSX - always use `t('key')`
- Add new strings to ALL language files

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

## Styling & Component Development

For detailed Unistyles styling guide and React Native guidelines, see @../.claude/rules/react-native.md

Key points:
- Always use `StyleSheet.create` from 'react-native-unistyles'
- Never use Alert module from React Native, always use @sources/modal/index.ts instead
- Always apply layout width constraints from `@/components/layout` to full-screen ScrollViews
- Store app pages in @sources/app/(app)/
- Always use expo-router API, not react-navigation one
- Always wrap pages in memo
- Always put styles in the very end of the component or page file
- For hotkeys use "useGlobalKeyboard", do not change it, it works only on Web
- Use "AsyncLock" class for exclusive async locks

## Project Scope and Priorities

Core principles: never show loading error, always just retry. Always sync main data in "sync" class. No backward compatibility unless explicitly stated.

For shared code style guidelines, see @../.claude/rules/code-style.md
For testing guidelines, see @../.claude/rules/testing.md
For TypeScript rules, see @../.claude/rules/typescript.md