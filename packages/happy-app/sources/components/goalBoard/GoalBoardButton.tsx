import * as React from 'react';
import { Platform, Pressable, type View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { GoalBoardCardFocus } from './GoalBoardCard';
import { ProjectSurfaces } from './ProjectSurfaces';

interface GoalBoardButtonProps {
    children: React.ReactNode;
    label: string;
    testID?: string;
    onPress: () => void;
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    busy?: boolean;
    touchTarget?: boolean;
    variant?: 'plain' | 'chip' | 'row' | 'primary' | 'toolbar' | 'card';
}

/** Shared keyboard, pointer and touch surface; colors always come from the active theme. */
export const GoalBoardButton = React.memo(React.forwardRef<View, GoalBoardButtonProps>(function GoalBoardButton({
    children, label, testID, onPress, selected, expanded, disabled, busy, touchTarget = false, variant = 'plain',
}, ref) {
    const surfaces = React.useContext(ProjectSurfaces);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const setCardFocused = React.useContext(GoalBoardCardFocus);
    return <Pressable
        ref={ref}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected, expanded, disabled, busy }}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => { setFocused(true); if (variant === 'card') setCardFocused?.(true); }}
        onBlur={() => { setFocused(false); if (variant === 'card') setCardFocused?.(false); }}
        hitSlop={4}
        style={(state: { pressed: boolean; hovered?: boolean }) => [
            styles.base,
            touchTarget && styles.touchTarget,
            variant === 'card' ? styles.card : variant === 'row' ? styles.row : variant === 'chip' ? styles.chip : variant === 'primary' ? styles.primary : variant === 'toolbar' ? styles.toolbar : styles.plain,
            variant === 'card' && setCardFocused ? styles.ownedCard : undefined,
            variant !== 'card' && selected ? styles.selected : undefined,
            variant !== 'card' && !disabled && (state.pressed || state.hovered || hovered) ? styles.pressed : undefined,
            (variant !== 'card' || !setCardFocused) && focused ? styles.focused : undefined,
            surfaces && variant !== 'card' && { backgroundColor: !disabled && (state.pressed || state.hovered || hovered) ? surfaces.pressed : selected || variant === 'primary' ? surfaces.selected : variant === 'toolbar' ? 'transparent' : surfaces.surface, ...(!focused ? { borderColor: 'transparent' } : {}) },
            disabled ? styles.disabled : undefined,
        ]}
    >{children}</Pressable>;
}));

const styles = StyleSheet.create((theme) => ({
    base: { minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.surface, backgroundColor: theme.colors.surface,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7 },
    plain: {},
    touchTarget: { minWidth: 44, minHeight: 44 },
    // Chromium paints outline-style:auto even at width 0; use a solid zero-width
    // outline so the explicit theme border remains the sole focus indicator.
    card: { flexGrow: 1, flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', paddingHorizontal: 0, paddingVertical: 0, borderColor: 'transparent', backgroundColor: 'transparent', borderRadius: 13, overflow: 'hidden', width: '100%', ...(Platform.OS === 'web' ? { outlineWidth: 0, outlineStyle: 'solid' as const } : {}) },
    ownedCard: { borderWidth: 0, borderRadius: 0 },
    chip: { borderRadius: 999, paddingHorizontal: 10 },
    // Header actions sit on the active header/skin instead of adding a solid chip.
    toolbar: { borderColor: 'transparent', backgroundColor: 'transparent', borderRadius: 10, paddingHorizontal: 10 },
    row: { alignItems: 'flex-start', justifyContent: 'flex-start', paddingHorizontal: 12, paddingVertical: 12, width: '100%' },
    primary: { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceSelected, minHeight: 44 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.5 },
}));
