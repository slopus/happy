import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DesktopDialogFrame } from './DesktopDialogFrame';
import type { StructuredSummary } from './markdown/parseStructuredSummary';

/** Display compatibility only; this does not classify provider thinking or compaction. */
export function StructuredSummaryView({ sections, renderMarkdown, onCopy, copied }: {
    sections: StructuredSummary;
    onCopy: () => Promise<void>;
    copied: boolean;
    renderMarkdown: (text: string) => React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const triggerRef = React.useRef<View>(null);
    const focusTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(focusTimer.current), []);
    const close = () => {
        setOpen(false);
        if (Platform.OS === 'web') {
            clearTimeout(focusTimer.current);
            focusTimer.current = setTimeout(() => triggerRef.current?.focus?.(), 0);
        }
    };
    return <>
        <View style={styles.row}>
            <Ionicons name="document-text-outline" size={14} color={theme.colors.textSecondary} />
            <Text style={styles.title}>{t('message.structuredSummaryTitle')}</Text>
            <Pressable
                ref={triggerRef}
                testID="structured-summary-toggle"
                accessibilityRole="button"
                accessibilityLabel={t('message.structuredSummaryView')}
                accessibilityState={{ expanded: open }}
                aria-expanded={open}
                aria-haspopup="dialog"
                onPress={() => setOpen(value => !value)}
                onHoverIn={() => setHovered(true)}
                onHoverOut={() => setHovered(false)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                style={({ pressed }) => [styles.button, (pressed || hovered) && styles.active, focused && styles.focused]}
            >
                <Text style={styles.action}>{t('message.structuredSummaryView')}</Text>
            </Pressable>
        </View>
        {open && <DesktopDialogFrame
            visible
            title={t('message.structuredSummaryTitle')}
            headerActions={<Pressable
                testID="structured-summary-copy"
                accessibilityRole="button"
                accessibilityLabel={t(copied ? 'common.copied' : 'message.structuredSummaryCopy')}
                accessibilityLiveRegion="polite"
                onPress={() => { void onCopy(); }}
                style={({ pressed }) => [styles.button, pressed && styles.active]}
            >
                <Text style={styles.action}>{t(copied ? 'common.copied' : 'message.structuredSummaryCopy')}</Text>
            </Pressable>}
            maxWidth={760}
            onClose={close}
            testID="structured-summary-dialog"
        >
            <ScrollView style={styles.scroll} contentContainerStyle={styles.body} testID="structured-summary-body">
                <Text style={styles.label}>{t('message.structuredSummaryAnalysis')}</Text>
                {renderMarkdown(sections.analysis)}
                <Text style={styles.label}>{t('message.structuredSummaryContent')}</Text>
                {renderMarkdown(sections.summary)}
            </ScrollView>
        </DesktopDialogFrame>}
    </>;
}

const styles = StyleSheet.create(theme => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: theme.colors.surface },
    button: { paddingHorizontal: 7, paddingVertical: 3, minHeight: 28, justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: 'transparent', backgroundColor: theme.colors.surface },
    active: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    title: { ...Typography.default(), fontSize: 14, color: theme.colors.textSecondary, flex: 1, flexShrink: 1 },
    action: { ...Typography.default(), fontSize: 12, lineHeight: 18, color: theme.colors.text },
    scroll: { flexShrink: 1, minHeight: 0 },
    body: { paddingHorizontal: 20, paddingBottom: 20 },
    label: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.textSecondary, marginTop: 16, marginBottom: 8 },
}));
