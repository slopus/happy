# UI & Theming Architecture

This document explains Arc's styling infrastructure, component library, and theming system.

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Styling** | `react-native-unistyles` v3 | Theme-aware stylesheets, CSS variables |
| **Colors** | Material Color Utilities | Generated light/dark palettes |
| **Typography** | IBM Plex Sans/Mono | Custom font system |
| **Animation** | React Native Reanimated v4 | Shimmer, transitions, gestures |
| **Canvas** | React Native Skia | Pixelated avatar generation |
| **Images** | expo-image | Optimized image loading with placeholders |

## Theming System

### Core Files

```
sources/
├── theme.ts           # Light & dark theme definitions
├── unistyles.ts       # Unistyles configuration & bootstrap
├── theme.gen.ts       # Material Color Utilities generator
├── theme.css          # Web-specific CSS variables
├── theme.light.json   # Generated light palette
└── theme.dark.json    # Generated dark palette
```

### Theme Bootstrap

On app launch, the theme system:

1. Loads theme preference from storage (adaptive/light/dark)
2. Initializes Unistyles with theme and breakpoints
3. Sets CSS variables for web platform
4. Syncs status bar color via `expo-system-ui`

```typescript
// unistyles.ts
import { UnistylesRegistry } from 'react-native-unistyles';

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
};

UnistylesRegistry
    .addThemes(appThemes)
    .addBreakpoints(breakpoints);
```

### Using Themes in Components

```typescript
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.md,
        padding: theme.margins.lg,
    },
    title: {
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
}));

export function MyComponent() {
    const { theme } = useUnistyles();
    // Access stylesheet directly or use theme inline
    return (
        <View style={stylesheet.container}>
            <Text style={stylesheet.title}>Hello</Text>
        </View>
    );
}
```

## Design Tokens

### Spacing Scale

```typescript
margins: {
    xs: 4,    // Tight spacing, status indicators
    sm: 8,    // Small gaps
    md: 12,   // Button gaps, card margins
    lg: 16,   // Most common padding
    xl: 20,   // Large padding
    xxl: 24,  // Section spacing
}
```

### Border Radius

```typescript
borderRadius: {
    sm: 4,    // Checkboxes, small elements
    md: 8,    // Buttons, list items
    lg: 10,   // Input fields
    xl: 12,   // Cards, containers
    xxl: 16,  // Main containers
}
```

### Icon Sizes

```typescript
iconSize: {
    small: 12,    // Inline icons
    medium: 16,   // Section headers
    large: 20,    // Action buttons (most common)
    xlarge: 24,   // Main section icons
}
```

### Shadow System

```typescript
shadow: {
    color: Platform.select({
        default: '#000000',
        web: 'rgba(0, 0, 0, 0.1)'
    }),
    opacity: 0.1,
}
```

## Color Palette

### Core Colors

```typescript
colors: {
    // Text
    text: '#1a1a1a',              // Primary text
    textSecondary: '#666666',     // Secondary/muted text
    link: '#007AFF',              // Links and actions

    // Surfaces
    surface: '#FFFFFF',           // Cards, containers
    surfaceHigh: '#F5F5F5',       // Elevated surfaces
    surfaceHighest: '#EEEEEE',    // Highest elevation
    surfacePressed: '#E8E8E8',    // Pressed state
    surfaceSelected: '#E0E7FF',   // Selected state

    // Status
    destructive: '#FF3B30',       // Errors, delete actions
    warning: '#FF9500',           // Warnings
    success: '#34C759',           // Success states

    // Dividers
    divider: 'rgba(0,0,0,0.1)',   // Separators
}
```

### Specialized Color Sets

```typescript
// Permission mode colors
permissionMode: {
    acceptEdits: '#10B981',
    bypass: '#EF4444',
    plan: '#8B5CF6',
    readOnly: '#6B7280',
    safeYolo: '#F59E0B',
    yolo: '#EF4444',
}

// Diff view colors
diff: {
    added: '#DCFCE7',
    addedText: '#166534',
    removed: '#FEE2E2',
    removedText: '#991B1B',
    context: '#F9FAFB',
    hunkHeader: '#EFF6FF',
}

// Terminal colors
terminal: {
    background: '#1E1E1E',
    text: '#D4D4D4',
    prompt: '#569CD6',
    stderr: '#F14C4C',
    success: '#4EC9B0',
}

// Syntax highlighting
syntax: {
    keyword: '#569CD6',
    string: '#CE9178',
    comment: '#6A9955',
    bracket1: '#FFD700',
    bracket2: '#DA70D6',
    bracket3: '#179FFF',
}
```

## Typography System

### Font Families

```typescript
// constants/Typography.ts

// IBM Plex Sans (default UI font)
Typography.default('regular' | 'italic' | 'semiBold')

// IBM Plex Mono (code/monospace)
Typography.mono('regular' | 'italic' | 'semiBold')

// Bricolage Grotesque (logo/special)
Typography.logo()

// Convenience helpers
Typography.header()  // semiBold default
Typography.body()    // regular default
```

### Usage

```typescript
import { Typography } from '@/constants/Typography';

// In styles
const styles = {
    title: {
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
    code: {
        fontSize: 14,
        ...Typography.mono(),
    },
    logo: {
        fontSize: 24,
        ...Typography.logo(),
    },
};
```

## Component Library

### List Components

Arc uses a consistent Item/ItemGroup/ItemList pattern for settings and lists:

```
ItemList (ScrollView container)
├── ItemGroup (section with header/footer)
│   ├── Item (row with icon, title, detail)
│   ├── Item
│   └── Item
└── ItemGroup
    └── Item
```

**Item.tsx** - Individual list row:
```typescript
<Item
    title="Account"
    subtitle="Manage your account settings"
    icon={<Ionicons name="person" size={28} color="#007AFF" />}
    detail="Pro"
    onPress={() => router.push('/settings/account')}
    showChevron={true}
    destructive={false}
/>
```

Props:
- `title`: Primary text
- `subtitle`: Secondary text (optional)
- `detail`: Right-aligned text (optional)
- `icon`: Left icon component
- `leftElement` / `rightElement`: Custom elements
- `loading`: Show spinner
- `selected`: Selected state
- `destructive`: Red text styling
- `showChevron`: Show arrow (auto-hidden for non-interactive)

**ItemGroup.tsx** - Section container:
```typescript
<ItemGroup
    title="Account"
    footer="Changes take effect immediately"
>
    <Item ... />
    <Item ... />
</ItemGroup>
```

**ItemList.tsx** - Scrollable container:
```typescript
<ItemList>
    <ItemGroup>...</ItemGroup>
    <ItemGroup>...</ItemGroup>
</ItemList>
```

### Avatar Components

Three avatar rendering styles:

**1. Gradient (default)**
```typescript
// 100 pre-generated gradient images
// Hash-based deterministic selection
<Avatar id={session.id} size={48} />
```

**2. Pixelated (Skia)**
```typescript
// 8x8 grid canvas rendering
// Uses React Native Skia
<Avatar id={session.id} size={48} style="pixelated" />
```

**3. Custom Image**
```typescript
// URL with thumbhash placeholder
<Avatar
    id={session.id}
    size={48}
    imageUrl="https://..."
    thumbhash="base64..."
/>
```

**Props:**
- `id`: Used for hash-based generation
- `size`: Pixel size
- `monochrome`: Grayscale mode
- `square`: Remove border radius
- `flavor`: Show provider icon ('claude' | 'codex' | 'gemini')
- `imageUrl`: Custom image URL
- `thumbhash`: Placeholder hash

### ShimmerView

Loading placeholder with animated gradient:

```typescript
<ShimmerView
    shimmerColors={['#E0E0E0', '#F0F0F0', '#F8F8F8', '#F0F0F0', '#E0E0E0']}
    shimmerWidthPercent={80}
    duration={1500}
>
    {/* Children define the mask shape */}
    <View style={{ height: 20, width: 150, borderRadius: 4 }} />
</ShimmerView>
```

Uses:
- `MaskedView` from `@react-native-masked-view/masked-view`
- `LinearGradient` from `expo-linear-gradient`
- Reanimated for smooth animation

### Other Key Components

| Component | Purpose |
|-----------|---------|
| `ChatHeaderView` | Session header with avatar, title, status |
| `FAB` | Floating action button |
| `StyledText` | Text with Typography.default() |
| `Switch` | Toggle switch |
| `Modal` | Alert/confirm/prompt modals |
| `SearchableListSelector` | Filterable list picker |

## Platform Handling

### Platform.select()

```typescript
// Common pattern throughout codebase
paddingHorizontal: Platform.select({ ios: 16, default: 12 }),
borderRadius: Platform.select({ ios: 10, default: 16 }),
```

### Device Detection

```typescript
import { useIsTablet, useDeviceType, useIsLandscape } from '@/utils/responsive';

// In component
const isTablet = useIsTablet();           // boolean
const deviceType = useDeviceType();        // 'phone' | 'tablet'
const isLandscape = useIsLandscape();      // boolean
const headerHeight = useHeaderHeight();    // number
```

### Platform-Specific Behaviors

**iOS:**
- Hairline dividers (0.33px)
- Grouped background colors
- Safe area inset handling
- Different chevron colors

**Android:**
- Ripple effects on press
- Different border radius
- Material-style elevation

**Web:**
- CSS variables for theme
- Custom scrollbar styling
- Different shadow handling

## Animation

### React Native Reanimated

Primary animation library for:
- Shimmer effects
- List item transitions
- Gesture interactions
- Layout animations

```typescript
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    Easing,
} from 'react-native-reanimated';

// Shimmer animation example
const translateX = useSharedValue(-100);

useEffect(() => {
    translateX.value = withRepeat(
        withTiming(100, { duration: 1500, easing: Easing.linear }),
        -1,  // Infinite
        false
    );
}, []);

const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
}));
```

### React Native Skia

Canvas-based graphics for:
- Pixelated avatar generation
- Custom shapes
- High-performance rendering

```typescript
import { Canvas, Rect, Group, ClipPath } from '@shopify/react-native-skia';

// 8x8 pixel avatar
<Canvas style={{ width: size, height: size }}>
    <ClipPath clip={circlePath}>
        <Group>
            {pixels.map((pixel, i) => (
                <Rect
                    key={i}
                    x={pixel.x * cellSize}
                    y={pixel.y * cellSize}
                    width={cellSize}
                    height={cellSize}
                    color={pixel.color}
                />
            ))}
        </Group>
    </ClipPath>
</Canvas>
```

## Responsive Layout

### Layout Module

```typescript
// components/layout.ts
export const layout = {
    maxWidth: Platform.select({
        ios: 800,
        android: 800,
        web: 1400,
        default: 800
    }),
    headerMaxWidth: Platform.select({
        ios: 800,
        android: 800,
        web: 1400,
        default: 800
    }),
};
```

### Usage

```typescript
import { layout } from '@/components/layout';

<View style={[styles.content, { maxWidth: layout.maxWidth }]}>
    {/* Content constrained for tablet/web */}
</View>
```

## Building Runner-Specific UI

To build Runner-specific components that integrate with the existing design system:

### Required Patterns

```typescript
// 1. Use Unistyles for all styling
const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.md,
    }
}));

// 2. Access theme in component
const { theme } = useUnistyles();

// 3. Handle platform differences
paddingHorizontal: Platform.select({ ios: 16, default: 12 })

// 4. Use Typography system
...Typography.default('semiBold')

// 5. Leverage design tokens
backgroundColor: theme.colors.surface
borderRadius: theme.borderRadius.md
```

### Key Color Sets for Runners

```typescript
// Primary surfaces
theme.colors.surface          // Cards/containers
theme.colors.groupped.background  // List backgrounds

// Text
theme.colors.text             // Primary text
theme.colors.textSecondary    // Labels/metadata

// Actions
theme.colors.link             // Interactive elements
theme.colors.fab.background   // Primary actions

// Status
theme.colors.status.connected    // Online indicators
theme.colors.status.disconnected // Offline indicators
```

### Component Templates

For Runner UI, extend these patterns:
- **List rows**: Extend `Item` component
- **Sections**: Use `ItemGroup`/`ItemList`
- **Avatars**: Use `Avatar` with custom `imageUrl`
- **Loading states**: Use `ShimmerView`
- **Headers**: Extend `ChatHeaderView`

## File Reference

| File | Purpose |
|------|---------|
| `theme.ts` | Theme definitions (colors, spacing, typography) |
| `unistyles.ts` | Unistyles bootstrap and configuration |
| `constants/Typography.ts` | Font family helpers |
| `utils/responsive.ts` | Device detection hooks |
| `components/layout.ts` | Layout constraints |
| `components/Item.tsx` | List row component |
| `components/ItemGroup.tsx` | Section container |
| `components/ItemList.tsx` | Scrollable list |
| `components/Avatar.tsx` | Avatar rendering |
| `components/ShimmerView.tsx` | Loading shimmer |
| `components/ChatHeaderView.tsx` | Session header |
