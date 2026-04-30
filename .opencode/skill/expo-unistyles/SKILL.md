---
name: expo-unistyles
description: Use this when working on styling in the expo-app. Covers react-native-unistyles patterns, theme usage, and special considerations for Expo Image.
---

## Use this when

- Adding or modifying styles in expo-app
- Working with themes and breakpoints
- Styling Expo Image components

## Unistyles basics

- Always use `StyleSheet.create` from `react-native-unistyles`
- Use function mode when you need theme or runtime access:

```typescript
const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: runtime.insets.top,
    }
}))
```

## Using styles

For React Native components, provide styles directly:

```typescript
<View style={styles.container}>
    <Text style={styles.text}>Hello</Text>
</View>
```

For other components, use `useStyles` hook:

```typescript
const { styles, theme } = useStyles(stylesheet)
```

## Variants

```typescript
const styles = StyleSheet.create(theme => ({
    button: {
        variants: {
            color: {
                primary: { backgroundColor: theme.colors.primary },
                secondary: { backgroundColor: theme.colors.secondary },
            },
            size: {
                small: { padding: 4 },
                large: { padding: 12 },
            }
        }
    }
}))

// Usage
const { styles } = useStyles(styles, {
    button: { color: 'primary', size: 'large' }
})
```

## Expo Image special handling

- **Size properties** (`width`, `height`) must be inline styles
- **`tintColor`** must be on the component, not in style prop

```typescript
<Image 
    style={[{ width: 100, height: 100 }, styles.image]}
    tintColor={theme.colors.primary}
    source={{ uri: 'https://...' }}
/>
```

## Quick checklist

- Use `StyleSheet.create` from unistyles
- Put styles at the end of file
- Use variants for state-based styling
- Use breakpoints for responsive design
- Special handling for Expo Image size and tintColor
