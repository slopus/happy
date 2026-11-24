import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useWebPopoverDismiss } from '@/hooks/useWebPopoverDismiss';

type Option = { key: string; name: string };

function ChoiceOption({ option, selected, onPress, onRef, testID }: {
    option: Option; selected: boolean; onPress: () => void; onRef: (node: View | null) => void; testID?: string;
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable ref={onRef} testID={testID} accessibilityLabel={option.name}
        accessibilityRole={Platform.OS === 'web' ? undefined : 'radio'}
        accessibilityState={Platform.OS === 'web' ? { selected } : { checked: selected }}
        {...(Platform.OS === 'web' ? { role: 'option' as const, 'aria-selected': selected, tabIndex: -1 as const } : {})}
        onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.option, selected && styles.selected,
            !selected && hovered && styles.hovered, pressed && styles.hovered,
            (focused || (selected && hovered)) && styles.focused]}>
        <Text style={[styles.optionText, selected && styles.selectedText]}>{option.name}</Text>
        <View style={styles.checkmark}>{selected && <Ionicons name="checkmark" size={18} color={theme.colors.textLink} />}</View>
    </Pressable>;
}

/** A form choice keeps its value visible and distinguishes hover, focus and selection. */
export function ScheduleChoice({ title, value, options, onChange, testID, disabled = false, placeholder }: {
    title: string; value: string; options: Option[]; onChange: (key: string) => void; testID?: string; disabled?: boolean; placeholder?: string;
}) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const rootRef = React.useRef<View>(null);
    const triggerRef = React.useRef<View>(null);
    const optionRefs = React.useRef(new Map<string, View>());
    const escapePressed = React.useRef(false);
    const currentName = options.find(option => option.key === value)?.name ?? (value || placeholder || '');
    const unavailable = disabled || options.length === 0;

    useWebPopoverDismiss({ enabled: expanded,
        isInside: target => (rootRef.current as unknown as HTMLElement | null)?.contains(target) ?? false,
        onDismiss: () => setExpanded(false) });

    React.useEffect(() => {
        if (expanded && Platform.OS === 'web') {
            (optionRefs.current.get(value) ?? optionRefs.current.values().next().value)?.focus();
        }
    }, [expanded]);
    React.useEffect(() => { if (unavailable) setExpanded(false); }, [unavailable]);

    const close = () => { setExpanded(false); if (Platform.OS === 'web') triggerRef.current?.focus(); };
    const choose = (key: string) => { if (unavailable) return; if (key !== value) onChange(key); close(); };
    const webKeys = Platform.OS === 'web' ? {
        onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
            if (unavailable || event.nativeEvent.isComposing) return;
            if (expanded && event.key === 'Escape') {
                escapePressed.current = true;
                event.preventDefault(); event.stopPropagation(); close();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                if (!expanded) { setExpanded(true); return; }
                const index = options.findIndex(option => (optionRefs.current.get(option.key) as unknown) === document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
                optionRefs.current.get(options[next]?.key)?.focus();
            } else if (expanded && (event.key === 'Enter' || event.key === ' ')) {
                const option = options.find(option => (optionRefs.current.get(option.key) as unknown) === document.activeElement);
                if (option) {
                    event.preventDefault(); event.stopPropagation(); choose(option.key);
                }
            } else if (expanded && event.key === 'Tab') close();
        },
        onKeyUpCapture: (event: React.KeyboardEvent<HTMLElement>) => {
            // RN Web's parent Modal handles Escape on keyup, after our list closes.
            if (event.key === 'Escape' && escapePressed.current) {
                escapePressed.current = false;
                event.preventDefault(); event.stopPropagation();
            }
        },
    } : {};

    return <View ref={rootRef} style={styles.container} {...webKeys}>
        <Pressable ref={triggerRef} testID={testID} accessibilityRole="button"
            disabled={unavailable} accessibilityLabel={[title, currentName].filter(Boolean).join(', ')} accessibilityState={{ expanded, disabled: unavailable }}
            {...(Platform.OS === 'web' ? { 'aria-haspopup': 'listbox' as const, 'aria-expanded': expanded } : {})}
            onPress={() => setExpanded(open => !open)}
            onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            style={({ pressed }) => [styles.trigger, expanded && styles.selected,
                !unavailable && (hovered || pressed) && styles.hovered, (focused || expanded) && styles.focused,
                unavailable && styles.disabled]}>
            <Text style={styles.title}>{title}</Text>
            <Text testID={`${testID}-value`} style={styles.value} numberOfLines={1}>{currentName}</Text>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} color={theme.colors.textSecondary} size={16} />
        </Pressable>
        {expanded && <ScrollView testID={`${testID}-options`} accessibilityLabel={title}
            accessibilityRole={Platform.OS === 'web' ? undefined : 'radiogroup'}
            // RN's Role type omits listbox; RN Web forwards this standard ARIA role.
            {...(Platform.OS === 'web' ? { role: 'listbox' as unknown as React.ComponentProps<typeof ScrollView>['role'] } : {})}
            style={styles.options} contentContainerStyle={styles.optionContent} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.map(option => <ChoiceOption key={option.key} option={option} selected={option.key === value}
                onRef={node => { if (node) optionRefs.current.set(option.key, node); else optionRefs.current.delete(option.key); }}
                onPress={() => choose(option.key)} testID={`${testID}-${option.key}`} />)}
        </ScrollView>}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { gap: 6 },
    trigger: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10,
        borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.surface },
    title: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14, flexShrink: 0 },
    value: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 14, flex: 1, minWidth: 0, textAlign: 'right' },
    options: { maxHeight: 220, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.surface },
    optionContent: { padding: 4, gap: 3 },
    option: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 10,
        borderWidth: 1, borderColor: 'transparent', borderRadius: 7, backgroundColor: theme.colors.surface },
    optionText: { ...Typography.default(), color: theme.colors.text, fontSize: 14, lineHeight: 20, flex: 1, minWidth: 0 },
    selectedText: { ...Typography.default('semiBold') },
    checkmark: { width: 20, alignItems: 'center', justifyContent: 'center' },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    hovered: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.5 },
}));
