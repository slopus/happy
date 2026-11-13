import * as React from 'react';
import { Platform, Pressable, type View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { GoalBoardCardFocus } from './GoalBoardCard';
import { ProjectSurfaces } from './ProjectSurfaces';
import { DesktopShortcutTooltip } from '../DesktopShortcutTooltip';

interface GoalBoardButtonProps {
    children: React.ReactNode;
    label: string;
    tooltip?: string;
    testID?: string;
    onPress: () => void;
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    busy?: boolean;
    touchTarget?: boolean;
    variant?: 'plain' | 'chip' | 'row' | 'primary' | 'toolbar' | 'card' | 'icon' | 'overlay';
}

/** Shared keyboard, pointer and touch surface; colors always come from the active theme. */
export const GoalBoardButton = React.memo(React.forwardRef<View, GoalBoardButtonProps>(function GoalBoardButton({
    children, label, tooltip, testID, onPress, selected, expanded, disabled, busy, touchTarget = false, variant = 'plain',
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
        hitSlop={variant === 'icon' || variant === 'overlay' ? 0 : 4}
        style={(state: { pressed: boolean; hovered?: boolean }) => [
            styles.base,
            touchTarget && styles.touchTarget,
            variant === 'card' ? styles.card : variant === 'row' ? styles.row : variant === 'chip' ? styles.chip : variant === 'primary' ? styles.primary : variant === 'toolbar' ? styles.toolbar : styles.plain,
            (variant === 'icon' || variant === 'overlay') && styles.icon,
            variant === 'icon' && styles.transparent,
            variant === 'overlay' && styles.overlay,
            variant === 'card' && setCardFocused ? styles.ownedCard : undefined,
            variant !== 'card' && selected ? variant === 'overlay' ? styles.overlaySelected : styles.selected : undefined,
            variant !== 'card' && !disabled && (state.pressed || state.hovered || hovered) ? variant === 'overlay' ? styles.overlayPressed : styles.pressed : undefined,
            (variant !== 'card' || !setCardFocused) && focused ? variant === 'overlay' ? styles.overlayFocused : styles.focused : undefined,
            surfaces && variant !== 'card' && variant !== 'overlay' && { backgroundColor: !disabled && (state.pressed || state.hovered || hovered) ? surfaces.pressed : selected || variant === 'primary' ? surfaces.selected : variant === 'toolbar' || variant === 'icon' ? 'transparent' : surfaces.surface, ...(!focused ? { borderColor: 'transparent' } : {}) },
            disabled ? styles.disabled : undefined,
        ]}
    >{children}{tooltip && Platform.OS === 'web' ? <DesktopShortcutTooltip label={tooltip} testID={`${testID}-tooltip`} visible={hovered || focused} /> : null}</Pressable>;
}));

const styles = StyleSheet.create((theme) => ({
    base: { minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.surface, backgroundColor: theme.colors.surface,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7 },
    plain: {},
    touchTarget: { minWidth: 44, minHeight: 44 },
    icon: { width: 44, height: 44, minWidth: 44, minHeight: 44, flexGrow: 0, flexShrink: 0, borderRadius: 22, borderColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0 },
    transparent: { backgroundColor: 'transparent' },
    overlay: { backgroundColor: theme.colors.imageOverlay.surface },
    overlayPressed: { backgroundColor: theme.colors.imageOverlay.surfacePressed },
    overlaySelected: { backgroundColor: theme.colors.imageOverlay.surfaceSelected },
    overlayFocused: { borderColor: theme.colors.imageOverlay.text },
    // Chromium paints outline-style:auto even at width 0; use a solid zero-width
    // outline so the explicit theme border remains the sole focus indicator.
    // Native ScrollView galleries must wrap the content height. Growing here
    // makes Yoga allocate blank space below each project caption.
    card: { flexGrow: Platform.OS === 'web' ? 1 : 0, flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', paddingHorizontal: 0, paddingVertical: 0, borderColor: 'transparent', backgroundColor: 'transparent', borderRadius: 13, overflow: 'hidden', width: '100%', ...(Platform.OS === 'web' ? { outlineWidth: 0, outlineStyle: 'solid' as const } : {}) },
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
