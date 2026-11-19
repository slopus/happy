import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ComposerTooltip } from './DesktopShortcutTooltip';

export interface DiscussionModeButtonProps {
    active: boolean;
    disabled?: boolean;
    onToggle: () => void;
}

export const DiscussionModeButton = React.memo(function DiscussionModeButton({
    active, disabled = false, onToggle,
}: DiscussionModeButtonProps) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);

    return <Pressable
        testID="session-discussion-mode"
        accessibilityRole={Platform.OS === 'web' ? 'button' : 'switch'}
        accessibilityLabel={t('discussionMode.toggle')}
        accessibilityState={{ checked: active, disabled }}
        aria-pressed={Platform.OS === 'web' ? active : undefined}
        disabled={disabled}
        onPress={onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => [
            styles.button,
            active && { backgroundColor: theme.colors.surfaceSelected },
            !active && !disabled && (pressed || hovered) && { backgroundColor: theme.colors.surfacePressed },
            focused && { borderColor: theme.colors.textLink },
            disabled && styles.disabled,
            Platform.OS === 'web' && { cursor: disabled ? 'auto' : 'pointer' },
        ]}
    >
        <Ionicons name="chatbubbles-outline" size={Platform.OS === 'web' ? 20 : 24}
            color={active ? theme.colors.textLink : theme.colors.textSecondary} />
        <ComposerTooltip testID="session-discussion-mode-tooltip" label={t('discussionMode.label')}
            visible={Platform.OS === 'web' && !disabled && (hovered || focused)} />
    </Pressable>;
});

const styles = StyleSheet.create({
    button: {
        width: Platform.select({ web: 32, default: 44 }),
        height: Platform.select({ web: 32, default: 44 }),
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    disabled: { opacity: 0.5 },
});
