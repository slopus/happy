import * as React from 'react';
import { Pressable, type View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface GoalBoardButtonProps {
    children: React.ReactNode;
    label: string;
    testID?: string;
    onPress: () => void;
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    busy?: boolean;
    variant?: 'plain' | 'chip' | 'row' | 'primary';
}

/** Shared keyboard, pointer and touch surface; colors always come from the active theme. */
export const GoalBoardButton = React.memo(React.forwardRef<View, GoalBoardButtonProps>(function GoalBoardButton({
    children, label, testID, onPress, selected, expanded, disabled, busy, variant = 'plain',
}, ref) {
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        hitSlop={4}
        style={(state: { pressed: boolean; hovered?: boolean }) => [
            styles.base,
            variant === 'row' ? styles.row : variant === 'chip' ? styles.chip : variant === 'primary' ? styles.primary : styles.plain,
            selected ? styles.selected : undefined,
            !disabled && (state.pressed || state.hovered || hovered) ? styles.pressed : undefined,
            focused ? styles.focused : undefined,
            disabled ? styles.disabled : undefined,
        ]}
    >{children}</Pressable>;
}));

const styles = StyleSheet.create((theme) => ({
    base: { minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.surface, backgroundColor: theme.colors.surface,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7 },
    plain: {},
    chip: { borderRadius: 999, paddingHorizontal: 10 },
    row: { alignItems: 'flex-start', justifyContent: 'flex-start', paddingHorizontal: 12, paddingVertical: 12, width: '100%' },
    primary: { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceSelected, minHeight: 44 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.5 },
}));
