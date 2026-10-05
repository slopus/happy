import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { Typography } from '@/constants/Typography';

export const authorizationStyles = StyleSheet.create(theme => ({
    content: { width: '100%', maxWidth: Math.min(640, layout.maxWidth), alignSelf: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32, gap: 24 },
    section: { gap: 10 },
    heading: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 24, color: theme.colors.text },
    body: { ...Typography.default(), fontSize: 14, lineHeight: 21, color: theme.colors.textSecondary, flexShrink: 1 },
    title: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 23, color: theme.colors.text, flexShrink: 1 },
    small: { ...Typography.default(), fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary },
    card: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 14, padding: 18, gap: 14 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    textColumn: { flex: 1, gap: 3, minWidth: 0 },
    icon: { height: 40, width: 40, borderRadius: 12, backgroundColor: theme.colors.surfaceSelected, alignItems: 'center', justifyContent: 'center' },
    divider: { height: 1, backgroundColor: theme.colors.divider },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    action: { flexGrow: 1, flexBasis: 180 },
    button: { borderRadius: 12 },
    buttonText: { fontSize: 16 },
    secondaryButton: { borderRadius: 12, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    hint: { ...Typography.default(), fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary, textAlign: 'center' },
    status: { ...Typography.default('semiBold'), fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceSelected, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6 },
    activeStatus: { color: theme.colors.accent },
    notice: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 12, padding: 16, gap: 6 },
    errorTitle: { color: theme.colors.textDestructive },
    choice: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, padding: 16, borderWidth: 1, borderRadius: 12, backgroundColor: theme.colors.surface, borderColor: theme.colors.divider },
    choiceSelected: { backgroundColor: theme.colors.surfaceSelected, borderColor: theme.colors.accent },
    choiceInteracting: { backgroundColor: theme.colors.surfacePressed },
    choiceFocused: { borderColor: theme.colors.accent, borderWidth: 2, padding: 15 },
    choiceDisabled: { opacity: 0.5 },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: theme.colors.textSecondary, alignItems: 'center', justifyContent: 'center' },
    radioSelected: { borderColor: theme.colors.accent },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accent },
}));

export function AppAuthorizationLayout({ children }: { children: React.ReactNode }) {
    return <ItemList><View testID="app-authorization-content" style={authorizationStyles.content}>{children}</View></ItemList>;
}

export function AuthorizationSection({ title, hint, children, radio = false }: { title: string; hint?: string; children: React.ReactNode; radio?: boolean }) {
    const styles = authorizationStyles;
    const keyboardProps = Platform.OS === 'web' && radio ? {
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])'));
            const current = options.indexOf(event.target as HTMLElement);
            if (current < 0 || !options.length) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + options.length) % options.length;
            options[next].focus();
            options[next].click();
        },
    } : {};
    return <View style={styles.section}>
        <View style={{ gap: 2 }}>
            <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
            {hint ? <Text style={styles.body}>{hint}</Text> : null}
        </View>
        <View accessibilityRole={radio ? 'radiogroup' : undefined} accessibilityLabel={radio ? title : undefined} {...keyboardProps} style={{ gap: 10 }}>{children}</View>
    </View>;
}

export function AuthorizationChoice({ title, subtitle, selected, disabled, onPress, icon, testID, role = 'radio' }: {
    title: string; subtitle?: string; selected: boolean; disabled?: boolean; onPress: () => void;
    icon?: React.ComponentProps<typeof Ionicons>['name']; testID?: string; role?: 'radio' | 'checkbox';
}) {
    const styles = authorizationStyles;
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const keyboardProps = Platform.OS === 'web' ? {
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (event.key === ' ' && !disabled) {
                event.preventDefault();
                if (!event.repeat) onPress();
            }
        },
    } : {};
    return <Pressable testID={testID} accessibilityRole={role} accessibilityLabel={title}
        accessibilityState={{ checked: selected, disabled: !!disabled }} disabled={disabled}
        aria-checked={selected}
        {...keyboardProps}
        onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.choice, selected && styles.choiceSelected,
            !disabled && (hovered || pressed) && styles.choiceInteracting,
            focused && styles.choiceFocused, disabled && styles.choiceDisabled]}>
        {icon ? <Ionicons name={icon} size={24} color={selected ? theme.colors.accent : theme.colors.textSecondary} /> : null}
        <View style={styles.textColumn}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.small}>{subtitle}</Text> : null}
        </View>
        <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
    </Pressable>;
}

export function AuthorizationNotice({ title, message, error = false }: { title: string; message?: string; error?: boolean }) {
    const styles = authorizationStyles;
    return <View style={styles.notice} accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite">
        <Text style={[styles.title, error && styles.errorTitle]}>{title}</Text>
        {message ? <Text style={styles.body}>{message}</Text> : null}
    </View>;
}
