---
paths:
- "expo-app/**/*.{ts,tsx}"
---

# React Native Guidelines

## Core Technology Stack

- **React Native** with **Expo** SDK 54
- **TypeScript** with strict mode enabled
- **Unistyles** for cross-platform styling with themes and breakpoints
- **Expo Router v6** for file-based routing
- **Socket.io** for real-time WebSocket communication
- **libsodium** (via `@more-tech/react-native-libsodium`) for end-to-end encryption
- **LiveKit** for real-time voice communication

## Component Development

### Styling with Unistyles

#### Creating Styles
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

#### Using Styles in Components
For React Native components, provide styles directly:

```typescript
import React from 'react'
import { View, Text } from 'react-native'

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
import { useStyles } from 'react-native-unistyles'

const MyComponent = () => {
    const { styles, theme } = useStyles(styles)

    return (
        <CustomComponent style={styles.container} />
    )
}
```

#### Special Component: Expo Image
- **Size properties** (`width`, `height`) must be set outside of Unistyles stylesheet as inline styles
- **`tintColor` property** must be set directly on the component, not in style prop
- All other styling goes through Unistyles

```typescript
import { Image } from 'expo-image'

const MyComponent = () => {
    const { theme } = useStyles()

    return (
        <Image
            style={[{ width: 100, height: 100 }, styles.image]}  // Size as inline styles
            tintColor={theme.colors.primary}                      // tintColor goes on component
            source={{ uri: 'https://example.com/image.jpg' }}
        />
    )
}
```

### Internationalization (i18n)

**CRITICAL: Always use the `t(...)` function for ALL user-visible strings**

```typescript
import { t } from '@/text';

// ✅ Simple constants
t('common.cancel')              // "Cancel"
t('settings.title')             // "Settings"

// ✅ Functions with parameters
t('common.welcome', { name: 'Steve' })           // "Welcome, Steve!"
t('time.minutesAgo', { count: 5 })               // "5 minutes ago"
```

#### Important i18n Rules
- **Never hardcode strings** in JSX - always use `t('key')`
- **Dev pages exception** - Development/debug pages can skip i18n
- **Check common first** - Before adding new keys, check if a suitable translation exists in `common`
- **Context matters** - Consider where the string appears to choose the right section
- **Update all languages** - New strings must be added to every language file
- **Use centralized language names** - Import language names from `_all.ts` instead of translation keys
- **Beware of technical terms** - Keep universally understood terms like "CLI", "API", "URL", "JSON" in their original form

### Navigation

#### Expo Router API
- **Always use expo-router API**, not react-navigation one
- **Store app pages** in `@sources/app/(app)/`
- **Never use custom headers** in navigation, almost never use Stack.Page options in individual pages
- **Always show header** on all screens
- **When setting screen parameters ALWAYS set them in _layout.tsx** if possible this avoids layout shifts

#### Custom Header Component
The app includes a custom header component (`sources/components/Header.tsx`):

```typescript
import { NavigationHeader } from '@/components/Header';

// As default for all screens in Stack navigator:
<Stack
    screenOptions={{
        header: NavigationHeader,
    }}
>
```

### UI Components

#### Avatar Component
- **Always use "Avatar" component** for avatars

#### Modal/Alert
- **Never use Alert module** from React Native
- **Always use @sources/modal/index.ts instead**

#### Layout
- **Always apply layout width constraints** from `@/components/layout` to full-screen ScrollViews and content containers for responsive design

#### ItemList
- **Use ItemList for most containers** for UI, if it is not custom like chat one

### File Organization

#### Page Files
- **Store pages in** `@sources/app/(app)/`
- **Always put styles** in the very end of the component or page file
- **Always wrap pages in memo**

#### Hooks
- **When non-trivial hook is needed** - create a dedicated one in hooks folder
- **Add a comment** explaining its logic
- **Always try to use "useHappyAction"** from @sources/hooks/useHappyAction.ts if you need to run some async operation (error handling is automatic)

#### Other Guidelines
- **Store all temporary scripts and any test outside of unit tests** in sources/trash folder
- **For hotkeys use "useGlobalKeyboard"** - do not change it, it works only on Web
- **Use "AsyncLock" class** for exclusive async locks

### Best Practices

1. **Always use `StyleSheet.create`** from 'react-native-unistyles'
2. **Provide styles directly** to components from 'react-native' and 'react-native-reanimated' packages
3. **Use `useStyles` hook only** for other components (but try to avoid it when possible)
4. **Always use function mode** when you need theme or runtime access
5. **Use variants** for component state-based styling instead of conditional styles
6. **Leverage breakpoints** for responsive design rather than manual dimension calculations
7. **Keep styles close to components** but extract common patterns to shared stylesheets
8. **Use TypeScript** for better developer experience and type safety

## Development Commands

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

## Project Scope and Priorities

- This project targets Android, iOS, and web platforms
- Web is considered a secondary platform
- Avoid web-specific implementations unless explicitly requested
- Core principles: never show loading error, always just retry
- Always sync main data in "sync" class
- Always use invalidate sync for it
- No backward compatibility unless explicitly stated

## See Also

- Detailed Expo app documentation: @expo-app/CLAUDE.md
- Unistyles styling guide: @expo-app/CLAUDE.md#unistyles-styling-guide
- i18n guidelines: @expo-app/CLAUDE.md#internationalization-i18n-guidelines
- Code style guidelines: @.claude/rules/code-style.md
- TypeScript rules: @.claude/rules/typescript.md
